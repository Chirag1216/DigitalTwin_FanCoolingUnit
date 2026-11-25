/**
 * Phase 2 — Live 3D Digital Twin (Three.js + OrbitControls + GLTFLoader).
 * Flat Bento aesthetic: #111113 canvas, neutral studio lighting, zero glows/bloom.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  PRESET_NAMES,
  isNum,
  fmt,
  getVibLimit,
  computeHealth,
} from "./state.js";

const MODEL_URL = "../3d-model/assembly_detailed_transparent.glb";

const PART_DEFS = [
  { key: "fan", nodeNames: ["Fan_Rotor", "Fan_120mm"], label: "P12 Fan", title: "Fan (Arctic P12 Pro)" },
  { key: "ds", nodeNames: ["Sensor_Temperature_DS18B20"], label: "DS18B20", title: "DS18B20 Temp" },
  { key: "mpu", nodeNames: ["Sensor_Vibration_MPU6050"], label: "MPU6050", title: "MPU6050 IMU" },
  { key: "ina", nodeNames: ["Sensor_Current_INA219"], label: "INA219", title: "INA219 Power" },
  { key: "esp", nodeNames: ["ESP32_DevKitC"], label: "ESP32", title: "ESP32 Controller" },
];

export class Scene3DTwin {
  /**
   * @param {HTMLElement} mountEl - #scene3d-mount container
   * @param {{ onUserOrbit?: () => void }} [opts]
   */
  constructor(mountEl, opts = {}) {
    this.mountEl = mountEl;
    this.onUserOrbit = opts.onUserOrbit || null;

    this._state = null;
    this._visualRpm = 0;
    this._hideBox = false;
    this._showLabels = false;
    this._selectedPart = null;

    this._root = null;
    this._restPos = new THREE.Vector3();
    this._rotor = null;
    this._enclosureObjects = [];
    this._inspectableMeshes = [];
    this._partRoots = new Map(); // key -> Object3D
    this._sensorMaterials = { ina: [], ds: [], mpu: [] };
    this._cameraPresets = {};
    this._transition = null; // { pos: Vector3, target: Vector3 }
    this._modelWidth = 0.25;
    this._shakePhase = 0;

    this._raycaster = new THREE.Raycaster();
    this._pointerDown = null;
    this._tmpVec = new THREE.Vector3();

    this._initDOM();
    this._initThree();
    this._loadModel();
    this._bindEvents();
    this._startLoop();
  }

  _initDOM() {
    this.mountEl.textContent = "";

    this._statusBanner = document.createElement("div");
    this._statusBanner.className = "scene3d-status";
    this._statusBanner.textContent = "Loading 3D twin…";

    this._labelsLayer = document.createElement("div");
    this._labelsLayer.className = "scene3d-labels";
    this._labelsLayer.hidden = true;

    this._labelButtons = new Map();
    for (const def of PART_DEFS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "scene3d-label-pill";
      btn.textContent = def.label;
      btn.hidden = true;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.selectPart(def.key);
      });
      this._labelsLayer.appendChild(btn);
      this._labelButtons.set(def.key, btn);
    }

    // Floating Inspector Card
    this._inspectorEl = document.createElement("aside");
    this._inspectorEl.className = "scene3d-inspector";
    this._inspectorEl.hidden = true;

    const inspHead = document.createElement("div");
    inspHead.className = "inspector-head";
    this._inspTitle = document.createElement("span");
    this._inspTitle.className = "inspector-title";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "inspector-close";
    closeBtn.setAttribute("aria-label", "Close inspector");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.selectPart(null);
    });
    inspHead.append(this._inspTitle, closeBtn);

    this._inspBody = document.createElement("dl");
    this._inspBody.className = "inspector-rows";

    this._inspectorEl.append(inspHead, this._inspBody);
    this.mountEl.append(this._statusBanner, this._labelsLayer, this._inspectorEl);
  }

  _initThree() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x111113);

    const rect = this.mountEl.getBoundingClientRect();
    const w = Math.max(1, rect.width || 640);
    const h = Math.max(1, rect.height || 340);

    this.camera = new THREE.PerspectiveCamera(40, w / h, 0.01, 50);
    this.camera.position.set(0.45, 0.35, 0.45);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.className = "scene3d-canvas";
    this.mountEl.prepend(this.renderer.domElement);

    // Neutral studio lighting
    const hemi = new THREE.HemisphereLight(0xf4f5f7, 0x26262a, 1.35);
    this.scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
    keyLight.position.set(2.5, 4.0, 3.0);
    this.scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xdce2ec, 0.9);
    fillLight.position.set(-3.0, 2.0, -2.5);
    this.scene.add(fillLight);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.1;
    this.controls.maxDistance = 3.0;

    this.controls.addEventListener("start", () => {
      this._transition = null;
      if (this.onUserOrbit) this.onUserOrbit();
    });

    this._resizeRaf = 0;
    this._ro = new ResizeObserver(() => {
      if (this._resizeRaf) return;
      this._resizeRaf = requestAnimationFrame(() => {
        this._resizeRaf = 0;
        this._handleResize();
      });
    });
    this._ro.observe(this.mountEl);
  }

  _handleResize() {
    const rect = this.mountEl.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  _loadModel() {
    const loader = new GLTFLoader();
    loader.load(
      MODEL_URL,
      (gltf) => {
        this._root = gltf.scene;
        this.scene.add(this._root);
        this._root.updateMatrixWorld(true);
        this._restPos.copy(this._root.position);

        this._indexSceneNodes();
        this._computeCameraPresets();
        this.setCameraPreset("iso", true);

        this._statusBanner.hidden = true;
        if (this._state) this._applyVisualCues();
      },
      undefined,
      (err) => {
        console.error("[scene3d] Failed to load 3D model:", err);
        this._statusBanner.hidden = false;
        this._statusBanner.classList.add("is-error");
        this._statusBanner.textContent = "Failed to load 3D model (assembly_detailed_transparent.glb)";
      }
    );
  }

  _indexSceneNodes() {
    const root = this._root;
    this._rotor = root.getObjectByName("Fan_Rotor") || null;

    // Enclosure meshes to toggle via Hide Box
    const encRoot = root.getObjectByName("Enclosure_Box");
    if (encRoot) this._enclosureObjects.push(encRoot);
    root.traverse((obj) => {
      if (/^Box_(Translucent|Walls|Lid_Flap)/i.test(obj.name) && !this._enclosureObjects.includes(obj)) {
        this._enclosureObjects.push(obj);
      }
    });

    // Index the 5 inspectable subtrees (excluding Enclosure_Box)
    const seenMeshes = new Set();
    for (const def of PART_DEFS) {
      let partObj = null;
      for (const n of def.nodeNames) {
        const found = root.getObjectByName(n);
        if (found) {
          partObj = found;
          break;
        }
      }
      if (!partObj) continue;
      this._partRoots.set(def.key, partObj);

      partObj.traverse((child) => {
        if (!child.isMesh || seenMeshes.has(child)) return;
        if (this._isInsideEnclosure(child)) return;
        seenMeshes.add(child);
        child.userData.partKey = def.key;
        this._inspectableMeshes.push(child);

        // Clone material for sensor cues so shared materials stay untouched
        if (def.key === "ina" || def.key === "ds" || def.key === "mpu") {
          const cloned = child.material.clone();
          child.material = cloned;
          this._sensorMaterials[def.key].push({
            mat: cloned,
            origColor: cloned.color ? cloned.color.clone() : new THREE.Color(0xffffff),
            origEmissive: cloned.emissive ? cloned.emissive.clone() : new THREE.Color(0x000000),
            origEmissiveIntensity: isNum(cloned.emissiveIntensity) ? cloned.emissiveIntensity : 0,
          });
        }
      });
    }

    // For Fan, also make sure Fan_120mm (frame + cable) is clickable if Fan_Rotor was matched first
    const fanGroup = root.getObjectByName("Fan_120mm");
    if (fanGroup) {
      this._partRoots.set("fan", fanGroup);
      fanGroup.traverse((child) => {
        if (!child.isMesh || seenMeshes.has(child)) return;
        seenMeshes.add(child);
        child.userData.partKey = "fan";
        this._inspectableMeshes.push(child);
      });
    }
  }

  _isInsideEnclosure(obj) {
    let cur = obj;
    while (cur) {
      if (cur.name === "Enclosure_Box" || /^Box_(Translucent|Walls|Lid_Flap)/i.test(cur.name)) {
        return true;
      }
      cur = cur.parent;
    }
    return false;
  }

  _computeCameraPresets() {
    const box = new THREE.Box3().setFromObject(this._root);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(0.05, size.length() * 0.5);
    this._modelWidth = Math.max(0.05, Math.max(size.x, size.z));

    this.controls.minDistance = radius * 0.45;
    this.controls.maxDistance = radius * 6.0;

    // Derive Front outward vector from center -> Fan_120mm projected onto XZ
    const fanObj = this._root.getObjectByName("Fan_120mm") || this._rotor;
    const frontDir = new THREE.Vector3(0, 0, 1);
    if (fanObj) {
      const fanCenter = new THREE.Box3().setFromObject(fanObj).getCenter(new THREE.Vector3());
      const delta = fanCenter.sub(center);
      delta.y = 0;
      if (delta.lengthSq() > 1e-6) {
        frontDir.copy(delta).normalize();
      }
    }

    const up = new THREE.Vector3(0, 1, 0);
    const rightDir = new THREE.Vector3().crossVectors(up, frontDir).normalize();

    const elecObj = this._root.getObjectByName("Electronics");
    const elecCenter = elecObj
      ? new THREE.Box3().setFromObject(elecObj).getCenter(new THREE.Vector3())
      : center.clone();

    const elecDir = elecCenter.clone().sub(center);
    elecDir.y = 0;
    const sensorViewDir =
      elecDir.lengthSq() > 1e-6
        ? elecDir.normalize().multiplyScalar(0.65).addScaledVector(rightDir, 0.45).addScaledVector(up, 0.65).normalize()
        : frontDir.clone().multiplyScalar(0.55).addScaledVector(rightDir, 0.65).addScaledVector(up, 0.55).normalize();

    this._cameraPresets = {
      front: {
        target: center.clone(),
        pos: center.clone().addScaledVector(frontDir, radius * 2.15).addScaledVector(up, size.y * 0.12),
      },
      iso: {
        target: center.clone(),
        pos: center
          .clone()
          .add(
            frontDir
              .clone()
              .multiplyScalar(0.78)
              .addScaledVector(rightDir, 0.62)
              .addScaledVector(up, 0.52)
              .normalize()
              .multiplyScalar(radius * 2.35)
          ),
      },
      top: {
        target: center.clone(),
        pos: center
          .clone()
          .addScaledVector(up, radius * 2.35)
          .addScaledVector(frontDir, radius * 0.22),
      },
      sensors: {
        target: elecCenter.clone(),
        pos: elecCenter.clone().addScaledVector(sensorViewDir, radius * 1.25),
      },
    };
  }

  _bindEvents() {
    const dom = this.renderer.domElement;
    dom.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      this._pointerDown = { x: e.clientX, y: e.clientY };
    });

    dom.addEventListener("pointerup", (e) => {
      if (e.button !== 0 || !this._pointerDown) return;
      const dist = Math.hypot(e.clientX - this._pointerDown.x, e.clientY - this._pointerDown.y);
      this._pointerDown = null;
      if (dist > 5 || !this._root) return;

      const rect = dom.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      this._raycaster.setFromCamera(ndc, this.camera);
      const hits = this._raycaster.intersectObjects(this._inspectableMeshes, false);
      if (hits.length > 0 && hits[0].object.userData.partKey) {
        this.selectPart(hits[0].object.userData.partKey);
      } else {
        this.selectPart(null);
      }
    });
  }

  setCameraPreset(preset, immediate = false) {
    const p = this._cameraPresets[preset];
    if (!p) return;
    if (immediate) {
      this._transition = null;
      this.camera.position.copy(p.pos);
      this.controls.target.copy(p.target);
      this.controls.update();
    } else {
      this._transition = { pos: p.pos.clone(), target: p.target.clone() };
    }
  }

  setHideBox(hide) {
    this._hideBox = Boolean(hide);
    for (const obj of this._enclosureObjects) {
      obj.visible = !this._hideBox;
    }
  }

  setShowLabels(show) {
    this._showLabels = Boolean(show);
    this._labelsLayer.hidden = !this._showLabels;
  }

  selectPart(partKey) {
    this._selectedPart = partKey;
    if (!partKey) {
      this._inspectorEl.hidden = true;
      return;
    }
    this._inspectorEl.hidden = false;
    this._renderInspector();
  }

  updateState(state) {
    this._state = state;
    if (this._root) {
      this._applyVisualCues();
    }
    if (this._selectedPart) {
      this._renderInspector();
    }
    this._updateLabelStates();
  }

  _updateLabelStates() {
    const inaBtn = this._labelButtons.get("ina");
    if (!inaBtn || !this._state) return;
    const h = computeHealth(this._state);
    inaBtn.classList.toggle("is-disconnected", h.inaDisconnected);
  }

  _applyVisualCues() {
    const s = this._state;
    if (!s) return;
    const h = computeHealth(s);
    const t = s.telemetry.data;
    const sim = s.sim.data;

    // 1. INA219 desaturation when disconnected
    for (const entry of this._sensorMaterials.ina) {
      if (h.inaDisconnected) {
        entry.mat.color.setHex(0x55555a);
        if (entry.mat.emissive) {
          entry.mat.emissive.setHex(0x000000);
          entry.mat.emissiveIntensity = 0;
        }
      } else {
        entry.mat.color.copy(entry.origColor);
        if (entry.mat.emissive) {
          entry.mat.emissive.copy(entry.origEmissive);
          entry.mat.emissiveIntensity = entry.origEmissiveIntensity;
        }
      }
    }

    // 2. DS18B20 temperature tint (neutral <= 28°C -> Tangerine #F47B42 at 36°C+)
    const tempVal =
      s.sim.online && sim?.sim_temp === true && isNum(sim.ctrl_temp_C)
        ? sim.ctrl_temp_C
        : !h.dsDisconnected && isNum(t?.ds_temp_C)
          ? t.ds_temp_C
          : null;
    const tempFactor = tempVal !== null ? Math.max(0, Math.min(1, (tempVal - 28) / 8)) : 0;
    const tangerine = new THREE.Color(0xf47b42);
    for (const entry of this._sensorMaterials.ds) {
      entry.mat.color.copy(entry.origColor).lerp(tangerine, tempFactor * 0.7);
      if (entry.mat.emissive) {
        entry.mat.emissive.copy(entry.origEmissive).lerp(tangerine, tempFactor * 0.45);
        entry.mat.emissiveIntensity = entry.origEmissiveIntensity + tempFactor * 0.55;
      }
    }

    // 3. MPU6050 vibration tint (>= 0.8 * limit amber, >= limit red)
    const activeLimit = !h.globalOffline && t ? getVibLimit(t) : null;
    const ax = !h.mpuDisconnected && isNum(t?.ax_std) ? t.ax_std : null;
    let mpuTint = null;
    if (ax !== null && activeLimit !== null) {
      if (ax >= activeLimit) mpuTint = new THREE.Color(0xf87171);
      else if (ax >= 0.8 * activeLimit) mpuTint = new THREE.Color(0xfbbf24);
    }
    for (const entry of this._sensorMaterials.mpu) {
      if (mpuTint) {
        entry.mat.color.copy(entry.origColor).lerp(mpuTint, 0.55);
        if (entry.mat.emissive) {
          entry.mat.emissive.copy(mpuTint);
          entry.mat.emissiveIntensity = 0.45;
        }
      } else {
        entry.mat.color.copy(entry.origColor);
        if (entry.mat.emissive) {
          entry.mat.emissive.copy(entry.origEmissive);
          entry.mat.emissiveIntensity = entry.origEmissiveIntensity;
        }
      }
    }
  }

  _renderInspector() {
    const def = PART_DEFS.find((d) => d.key === this._selectedPart);
    if (!def) {
      this._inspectorEl.hidden = true;
      return;
    }
    this._inspTitle.textContent = def.title;

    const s = this._state;
    const t = s?.telemetry?.data;
    const sim = s?.sim?.data;
    const h = s ? computeHealth(s) : { globalOffline: true, inaDisconnected: true };

    const rows = [];
    if (def.key === "fan") {
      const presetStr =
        !h.globalOffline && isNum(t?.preset)
          ? `${t.preset} (${PRESET_NAMES[t.preset] ?? "?"})`
          : "—";
      rows.push(["RPM", !h.globalOffline ? `${fmt(t?.rpm, 0)} RPM` : "—"]);
      rows.push(["Sim RPM", s?.sim?.online && isNum(sim?.sim_rpm) ? `${fmt(sim.sim_rpm, 0)} RPM` : "—"]);
      rows.push(["Duty", !h.globalOffline ? `${fmt(t?.duty_pct, 0)} %` : "—"]);
      rows.push(["Preset", presetStr]);
      rows.push(["Settled", !h.globalOffline && t ? (t.settled ? "Yes" : "Settling") : "—"]);
    } else if (def.key === "mpu") {
      const live = !h.globalOffline && !h.mpuDisconnected;
      rows.push(["ax / ay / az std", live ? `${fmt(t?.ax_std, 3)} / ${fmt(t?.ay_std, 3)} / ${fmt(t?.az_std, 3)}` : "—"]);
      rows.push(["ax / ay / az p2p", live ? `${fmt(t?.ax_p2p, 3)} / ${fmt(t?.ay_p2p, 3)} / ${fmt(t?.az_p2p, 3)}` : "—"]);
      rows.push(["gx / gy / gz std", live ? `${fmt(t?.gx_std, 4)} / ${fmt(t?.gy_std, 4)} / ${fmt(t?.gz_std, 4)}` : "—"]);
      rows.push(["Chip Temp", !h.globalOffline ? `${fmt(t?.temp_C, 2)} °C` : "—"]);
    } else if (def.key === "ds") {
      rows.push(["ds_temp_C", !h.globalOffline && !h.dsDisconnected ? `${fmt(t?.ds_temp_C, 2)} °C` : "—"]);
      rows.push(["ds_age_ms", !h.globalOffline && isNum(t?.ds_age_ms) ? `${fmt(t.ds_age_ms, 0)} ms` : "—"]);
      rows.push(["ctrl_temp_C", s?.sim?.online && isNum(sim?.ctrl_temp_C) ? `${fmt(sim.ctrl_temp_C, 2)} °C` : "—"]);
    } else if (def.key === "esp") {
      const uptime = !h.globalOffline && isNum(t?.t_ms) ? formatUptime(t.t_ms) : "—";
      const lastEv = s?.events?.length ? s.events[0].msg : "—";
      rows.push(["Status", s?.esp?.online === true ? "ONLINE" : s?.esp?.online === false ? "OFFLINE" : "UNKNOWN"]);
      rows.push(["Uptime", uptime]);
      rows.push(["Samples (n)", !h.globalOffline && isNum(t?.n) ? String(t.n) : "—"]);
      rows.push(["Last Event", lastEv]);
    } else if (def.key === "ina") {
      if (h.inaDisconnected) {
        rows.push(["Status", "Not connected on rig"]);
        rows.push(["Current / Bus V", "—"]);
      } else {
        rows.push(["current_mA", `${fmt(t?.current_mA, 1)} mA`]);
        rows.push(["bus_V", `${fmt(t?.bus_V, 2)} V`]);
        rows.push(["shunt_mV", `${fmt(t?.shunt_mV, 3)} mV`]);
        rows.push(["load_V", `${fmt(t?.load_V, 2)} V`]);
      }
    }

    this._inspBody.textContent = "";
    for (const [k, v] of rows) {
      const wrap = document.createElement("div");
      wrap.className = "inspector-row";
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      wrap.append(dt, dd);
      this._inspBody.appendChild(wrap);
    }
  }

  _startLoop() {
    let lastMs = performance.now();
    const tick = (nowMs) => {
      this._rafId = requestAnimationFrame(tick);
      const dt = Math.min(0.05, Math.max(0.001, (nowMs - lastMs) / 1000));
      lastMs = nowMs;

      this._stepRotor(dt);
      this._stepMicroShake(dt);
      this._stepCameraTransition(dt);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      if (this._showLabels && this._root) {
        this._projectLabels();
      }
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _stepRotor(dt) {
    if (!this._rotor) return;
    const s = this._state;
    const h = s ? computeHealth(s) : { globalOffline: true };
    const t = s?.telemetry?.data;

    const shouldCoastDown =
      !s ||
      h.globalOffline ||
      !t ||
      t.preset === 0 ||
      !isNum(t.rpm) ||
      t.rpm <= 0;

    if (shouldCoastDown) {
      this._visualRpm *= Math.exp(-dt / 2.0);
      if (this._visualRpm < 5) this._visualRpm = 0;
    } else {
      const clampedRpm = Math.max(0, Math.min(3000, t.rpm));
      this._visualRpm += (clampedRpm - this._visualRpm) * (1 - Math.exp(-dt * 4));
    }

    if (this._visualRpm > 0) {
      this._rotor.rotateY(-2 * Math.PI * (this._visualRpm / 60 / 20) * dt);
    }
  }

  _stepMicroShake(dt) {
    if (!this._root) return;
    const s = this._state;
    const h = s ? computeHealth(s) : { globalOffline: true, mpuDisconnected: true };
    const t = s?.telemetry?.data;
    const activeLimit = t ? getVibLimit(t) : 1.5;

    const shouldShake =
      s &&
      !h.globalOffline &&
      !h.mpuDisconnected &&
      t &&
      t.preset !== 0 &&
      isNum(t.ax_std) &&
      t.ax_std > 0.6 * activeLimit;

    if (shouldShake) {
      const norm = Math.min(1, (t.ax_std - 0.6 * activeLimit) / (0.8 * activeLimit));
      const amp = norm * 0.004 * this._modelWidth;
      this._shakePhase += dt * 55;
      const jx = Math.sin(this._shakePhase * 1.13) * amp;
      const jy = Math.cos(this._shakePhase * 1.71) * amp * 0.6;
      const jz = Math.sin(this._shakePhase * 2.09) * amp * 0.8;
      this._root.position.set(
        this._restPos.x + jx,
        this._restPos.y + jy,
        this._restPos.z + jz
      );
    } else {
      this._root.position.lerp(this._restPos, 1 - Math.exp(-dt * 12));
    }
  }

  _stepCameraTransition(dt) {
    if (!this._transition) return;
    const alpha = 1 - Math.exp(-dt * 7);
    this.camera.position.lerp(this._transition.pos, alpha);
    this.controls.target.lerp(this._transition.target, alpha);
    if (
      this.camera.position.distanceTo(this._transition.pos) < 0.002 &&
      this.controls.target.distanceTo(this._transition.target) < 0.002
    ) {
      this.camera.position.copy(this._transition.pos);
      this.controls.target.copy(this._transition.target);
      this._transition = null;
    }
  }

  _projectLabels() {
    const w = this.mountEl.clientWidth;
    const h = this.mountEl.clientHeight;
    if (w <= 0 || h <= 0) return;

    const box = new THREE.Box3();
    for (const def of PART_DEFS) {
      const btn = this._labelButtons.get(def.key);
      const obj = this._partRoots.get(def.key);
      if (!btn || !obj || !obj.visible) {
        if (btn) btn.hidden = true;
        continue;
      }

      box.setFromObject(obj);
      box.getCenter(this._tmpVec);
      this._tmpVec.project(this.camera);

      if (this._tmpVec.z > 1 || this._tmpVec.z < -1) {
        btn.hidden = true;
        continue;
      }

      const x = (this._tmpVec.x * 0.5 + 0.5) * w;
      const y = (-this._tmpVec.y * 0.5 + 0.5) * h;

      if (x < 12 || x > w - 12 || y < 12 || y > h - 12) {
        btn.hidden = true;
        continue;
      }

      btn.hidden = false;
      btn.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -50%)`;
    }
  }
}

function formatUptime(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
