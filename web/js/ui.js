/**
 * Safe DOM bindings and UI updates for FAN01 Digital Twin Dashboard.
 * Strict rule: textContent ONLY — never innerHTML for any MQTT data.
 */

import {
  store,
  PRESET_NAMES,
  isNum,
  fmt,
  fmtTime,
  getVibLimit,
  computeHealth,
} from "./state.js";
import { mqttClient } from "./mqtt-client.js";
import { SegmentedArcGauge, SparklineChart } from "./charts.js";
import { Scene3DTwin } from "./scene3d.js";

const $ = (id) => document.getElementById(id);

const SEVERITY_META = {
  critical: { icon: "⛔", label: "CRITICAL", cls: "sev-critical" },
  warning: { icon: "⚠", label: "WARNING", cls: "sev-warning" },
  info: { icon: "ℹ", label: "INFO", cls: "sev-info" },
};

export function initUI() {
  const els = {
    grid: $("bentoGrid"),

    // Top bar pills
    pillBroker: $("pillBroker"),
    pillBrokerText: $("pillBrokerText"),
    pillEsp: $("pillEsp"),
    pillEspText: $("pillEspText"),
    pillTelemetry: $("pillTelemetry"),
    pillTelemetryText: $("pillTelemetryText"),
    pillTwin: $("pillTwin"),
    pillTwinText: $("pillTwinText"),

    // Broker drawer
    drawerToggle: $("btnBrokerToggle"),
    drawer: $("brokerDrawer"),
    brokerForm: $("brokerForm"),
    inputHost: $("inpHost"),
    inputPort: $("inpPort"),
    inputUser: $("inpUser"),
    inputPass: $("inpPass"),
    btnConnect: $("btnConnect"),
    btnDisconnect: $("btnDisconnect"),
    brokerNote: $("brokerNote"),

    // 3D Viewport
    sceneMount: $("scene3d-mount"),
    cameraButtons: Array.from(document.querySelectorAll("[data-cam-preset]")),
    btnHideBox: $("btnHideBox"),
    btnLabels: $("btnLabels"),

    // RPM Card
    cardRpm: $("cardRpm"),
    valRpm: $("valRpm"),
    badgeRpmState: $("badgeRpmState"),
    valSimRpm: $("valSimRpm"),

    // Temp Card
    cardTemp: $("cardTemp"),
    valDsTemp: $("valDsTemp"),
    badgeTempState: $("badgeTempState"),
    valMpuTemp: $("valMpuTemp"),
    badgeSimTemp: $("badgeSimTemp"),
    valSimTempCtrl: $("valSimTempCtrl"),

    // Vibration Card
    cardVib: $("cardVib"),
    valAxStd: $("valAxStd"),
    badgeVibState: $("badgeVibState"),
    valVibLimit: $("valVibLimit"),
    valSimAxStd: $("valSimAxStd"),
    valVibSamples: $("valVibSamples"),

    // Power / INA219 Card
    cardPower: $("cardPower"),
    badgePowerState: $("badgePowerState"),
    valCurrentMa: $("valCurrentMa"),
    valBusV: $("valBusV"),
    valPowerMw: $("valPowerMw"),
    rowEstCurrent: $("rowEstCurrent"),
    valEstCurrentMa: $("valEstCurrentMa"),

    // Fan Load & Control Card
    cardControl: $("cardControl"),
    gaugeCanvas: $("gaugeDuty"),
    presetButtons: Array.from(document.querySelectorAll("[data-preset]")),
    autoModeBanner: $("autoModeBanner"),

    // Twin Engine Card
    cardTwin: $("cardTwin"),
    badgeTwinState: $("badgeTwinState"),
    valCtrlMode: $("valCtrlMode"),
    valCtrlAction: $("valCtrlAction"),
    valCtrlTarget: $("valCtrlTarget"),
    valTwinEstCurrent: $("valTwinEstCurrent"),

    // Alerts Feed Card
    alertsList: $("alertsList"),
    alertsCount: $("alertsCount"),
  };

  // Instantiate 3D Digital Twin & Canvas 2D charts
  const scene3d = new Scene3DTwin(els.sceneMount);
  const dutyGauge = new SegmentedArcGauge(els.gaugeCanvas);

  const chartRpm = new SparklineChart($("chartRpmWrap"), {
    primaryKey: "rpm",
    secondaryKey: "simRpm",
    primaryColor: "#0D0D0F",
    secondaryColor: "rgba(13, 13, 15, 0.45)",
    gridColor: "rgba(13, 13, 15, 0.14)",
    labelColor: "rgba(13, 13, 15, 0.65)",
    footerColor: "rgba(13, 13, 15, 0.55)",
    dotStrokeColor: "#C8F560",
    crosshairColor: "rgba(13, 13, 15, 0.42)",
    decimals: 0,
    unit: "RPM",
    getRange: (pri, sec) => [0, Math.max(3000, ...pri, ...sec)],
  });

  const chartVib = new SparklineChart($("chartVibWrap"), {
    primaryKey: "axStd",
    limitKey: "vibLimit",
    primaryColor: "#C8F560",
    limitColor: "#F47B42",
    decimals: 2,
    unit: "m/s²",
    alertWhenAboveLimit: true,
    getRange: (pri, _sec, lim) => [0, Math.max(0.3, ...pri, ...lim) * 1.15],
  });

  const chartTemp = new SparklineChart($("chartTempWrap"), {
    primaryKey: "dsTemp",
    primaryColor: "#0D0D0F",
    gridColor: "rgba(13, 13, 15, 0.14)",
    labelColor: "rgba(13, 13, 15, 0.65)",
    footerColor: "rgba(13, 13, 15, 0.55)",
    dotStrokeColor: "#F47B42",
    crosshairColor: "rgba(13, 13, 15, 0.42)",
    decimals: 1,
    unit: "°C",
    getRange: (pri) => {
      if (!pri.length) return [20, 40];
      const lo = Math.min(...pri);
      const hi = Math.max(...pri);
      const mid = (lo + hi) / 2;
      const half = Math.max(1.0, (hi - lo) / 2 + 0.4);
      return [mid - half, mid + half];
    },
  });

  // Wire Broker Connect drawer
  els.drawerToggle.addEventListener("click", () => {
    const isOpen = !els.drawer.hidden;
    els.drawer.hidden = isOpen;
    els.drawerToggle.setAttribute("aria-expanded", String(!isOpen));
  });

  els.brokerForm.addEventListener("submit", (e) => {
    e.preventDefault();
    mqttClient.connect({
      host: els.inputHost.value,
      port: els.inputPort.value,
      user: els.inputUser.value,
      password: els.inputPass.value,
    });
  });

  els.btnDisconnect.addEventListener("click", () => {
    mqttClient.disconnect();
  });

  // Wire camera preset & overlay toggle buttons
  els.cameraButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const preset = btn.dataset.camPreset;
      store.setCameraPreset(preset);
      scene3d.setCameraPreset(preset);
    });
  });

  let hideBox = false;
  els.btnHideBox.addEventListener("click", () => {
    hideBox = !hideBox;
    els.btnHideBox.classList.toggle("is-active", hideBox);
    els.btnHideBox.setAttribute("aria-pressed", String(hideBox));
    scene3d.setHideBox(hideBox);
  });

  let showLabels = false;
  els.btnLabels.addEventListener("click", () => {
    showLabels = !showLabels;
    els.btnLabels.classList.toggle("is-active", showLabels);
    els.btnLabels.setAttribute("aria-pressed", String(showLabels));
    scene3d.setShowLabels(showLabels);
  });

  // Wire Fan Preset buttons — highlights strictly follow telemetry.preset, not clicked button
  els.presetButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const preset = Number.parseInt(btn.dataset.preset, 10);
      mqttClient.publishPreset(preset);
    });
  });

  // Prefill non-secret host/port/user from query string
  const params = new URLSearchParams(window.location.search);
  els.inputHost.value =
    params.get("host") || window.location.hostname || "localhost";
  if (params.has("port")) {
    els.inputPort.value = params.get("port");
  }
  if (params.has("user")) {
    els.inputUser.value = params.get("user");
  }

  let lastAlertsRef = null;
  let lastAlertsLen = -1;

  store.subscribe((s) => {
    const h = computeHealth(s);
    const t = s.telemetry.data;
    const sim = s.sim.data;

    // 1. Global offline/stale state
    els.grid.classList.toggle("is-global-offline", h.globalOffline);

    // 2. Top bar pills
    updateBrokerPill(els, s.broker);
    updateEspPill(els, s.broker.status, s.esp);
    updateTelemetryPill(els, s.broker.status, s.telemetry, h);
    updateTwinPill(els, s.sim);

    els.btnDisconnect.disabled = s.broker.status === "disconnected";
    els.brokerNote.textContent = s.broker.message;

    // 3. 3D Viewport camera preset & live twin sync
    els.cameraButtons.forEach((btn) => {
      const active = btn.dataset.camPreset === s.ui.cameraPreset;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    scene3d.updateState(s);

    // 4. RPM Card
    els.cardRpm.classList.toggle("is-disconnected", h.rpmDisconnected);
    if (h.rpmDisconnected) {
      els.valRpm.textContent = "—";
      els.badgeRpmState.textContent = "DISCONNECTED";
      els.badgeRpmState.dataset.tone = "off";
    } else {
      els.valRpm.textContent = fmt(t.rpm, 0);
      const settled = t.settled === 1 || t.settled === true;
      els.badgeRpmState.textContent = settled ? "SETTLED" : "SETTLING";
      els.badgeRpmState.dataset.tone = settled ? "good" : "warn";
    }
    els.valSimRpm.textContent =
      s.sim.online && isNum(sim?.sim_rpm) ? `${fmt(sim.sim_rpm, 0)} RPM` : "—";

    // 5. Enclosure Temp Card
    els.cardTemp.classList.toggle("is-disconnected", h.dsDisconnected);
    if (h.dsDisconnected) {
      els.valDsTemp.textContent = "—";
      els.badgeTempState.textContent = "DISCONNECTED";
      els.badgeTempState.hidden = false;
    } else {
      els.valDsTemp.textContent = fmt(t.ds_temp_C, 2);
      els.badgeTempState.hidden = true;
    }
    els.valMpuTemp.textContent =
      !h.globalOffline && isNum(t?.temp_C) ? `${fmt(t.temp_C, 2)} °C` : "—";

    const isSimTemp = s.sim.online && sim?.sim_temp === true;
    els.badgeSimTemp.hidden = !isSimTemp;
    if (isSimTemp) {
      els.valSimTempCtrl.textContent = isNum(sim.ctrl_temp_C)
        ? `${fmt(sim.ctrl_temp_C, 2)} °C`
        : "—";
    }

    // 6. Vibration Card
    els.cardVib.classList.toggle("is-disconnected", h.mpuDisconnected);
    const activeLimit = !h.globalOffline && t ? getVibLimit(t) : null;
    if (h.mpuDisconnected) {
      els.valAxStd.textContent = "—";
      els.badgeVibState.textContent = "DISCONNECTED";
      els.badgeVibState.dataset.tone = "off";
      els.valVibLimit.textContent = "—";
      els.valVibSamples.textContent = "—";
    } else {
      els.valAxStd.textContent = fmt(t.ax_std, 3);
      const aboveLimit = activeLimit !== null && t.ax_std > activeLimit;
      els.badgeVibState.textContent = aboveLimit
        ? "HIGH VIB"
        : t.settled
          ? "NOMINAL"
          : "SETTLING";
      els.badgeVibState.dataset.tone = aboveLimit
        ? "warn"
        : t.settled
          ? "good"
          : "neutral";
      els.valVibLimit.textContent =
        activeLimit !== null
          ? `${activeLimit.toFixed(2)} m/s²${t.settled ? "" : " (settling)"}`
          : "—";
      els.valVibSamples.textContent = isNum(t.n) ? String(t.n) : "—";
    }
    els.valSimAxStd.textContent =
      s.sim.online && isNum(sim?.sim_ax_std)
        ? `${fmt(sim.sim_ax_std, 3)} m/s²`
        : "—";

    // 7. Power / INA219 Card
    els.cardPower.classList.toggle("is-disconnected", h.inaDisconnected);
    if (h.inaDisconnected) {
      els.badgePowerState.textContent = "DISCONNECTED";
      els.badgePowerState.dataset.tone = "off";
      els.valCurrentMa.textContent = "—";
      els.valBusV.textContent = "—";
      els.valPowerMw.textContent = "—";
      els.rowEstCurrent.hidden = false;
      els.valEstCurrentMa.textContent =
        s.sim.online && isNum(sim?.sim_current_mA)
          ? `${fmt(sim.sim_current_mA, 1)} mA`
          : "—";
    } else {
      els.badgePowerState.textContent = "LIVE";
      els.badgePowerState.dataset.tone = "good";
      els.valCurrentMa.textContent = `${fmt(t.current_mA, 1)} mA`;
      els.valBusV.textContent = isNum(t.bus_V) ? `${fmt(t.bus_V, 2)} V` : "—";
      els.valPowerMw.textContent =
        isNum(t.current_mA) && isNum(t.bus_V)
          ? `${fmt(t.current_mA * t.bus_V, 0)} mW`
          : "—";
      els.rowEstCurrent.hidden = true;
    }

    // 8. Fan Load & Control Card
    const livePreset = !h.globalOffline && isNum(t?.preset) ? t.preset : null;
    const liveDuty = !h.globalOffline && isNum(t?.duty_pct) ? t.duty_pct : null;
    dutyGauge.update({
      dutyPct: liveDuty,
      presetLabel:
        livePreset !== null ? PRESET_NAMES[livePreset] ?? `P${livePreset}` : "—",
      offline: h.globalOffline,
    });

    const canSendCmd = h.brokerConnected;
    els.presetButtons.forEach((btn) => {
      const idx = Number.parseInt(btn.dataset.preset, 10);
      btn.disabled = !canSendCmd;
      const isActive = livePreset !== null && idx === livePreset;
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-pressed", String(isActive));
    });

    const isAutoMode = s.sim.online && sim?.ctrl_mode === "auto";
    els.autoModeBanner.hidden = !isAutoMode;

    // 9. Twin Engine Card
    els.cardTwin.classList.toggle("is-twin-offline", !s.sim.online);
    if (!s.sim.online || !sim) {
      els.badgeTwinState.textContent = "TWIN OFFLINE";
      els.badgeTwinState.dataset.tone = "off";
      els.valCtrlMode.textContent = "—";
      els.valCtrlAction.textContent = "—";
      els.valCtrlTarget.textContent = "—";
      els.valTwinEstCurrent.textContent = "—";
    } else {
      els.badgeTwinState.textContent = "ONLINE";
      els.badgeTwinState.dataset.tone = "good";
      els.valCtrlMode.textContent =
        typeof sim.ctrl_mode === "string" ? sim.ctrl_mode.toUpperCase() : "—";
      els.valCtrlAction.textContent =
        typeof sim.ctrl_action === "string" ? sim.ctrl_action : "—";
      els.valCtrlTarget.textContent = isNum(sim.ctrl_target)
        ? `${sim.ctrl_target} · ${PRESET_NAMES[sim.ctrl_target] ?? "?"}`
        : "—";
      els.valTwinEstCurrent.textContent = isNum(sim.sim_current_mA)
        ? `${fmt(sim.sim_current_mA, 1)} mA`
        : "—";
    }

    // 10. Mini Sparkline Charts
    chartRpm.setData(s.history);
    chartVib.setData(s.history);
    chartTemp.setData(s.history);

    // 11. Alerts Feed (only rebuild when alerts array updates)
    if (lastAlertsRef !== s.alerts || lastAlertsLen !== s.alerts.length) {
      lastAlertsRef = s.alerts;
      lastAlertsLen = s.alerts.length;
      renderAlerts(els.alertsList, els.alertsCount, s.alerts);
    }
  });

  // Auto-connect if requested via query param (e.g. ?host=localhost&port=19001&user=&auto=1)
  if (params.has("auto")) {
    mqttClient.connect({
      host: els.inputHost.value,
      port: els.inputPort.value,
      user: els.inputUser.value,
      password: "",
    });
  }
}

function updateBrokerPill(els, broker) {
  const map = {
    connected: { text: "CONNECTED", tone: "good" },
    connecting: { text: "CONNECTING", tone: "warn" },
    error: { text: "ERROR", tone: "crit" },
    disconnected: { text: "DISCONNECTED", tone: "crit" },
  };
  const info = map[broker.status] || map.disconnected;
  els.pillBroker.dataset.tone = info.tone;
  els.pillBrokerText.textContent = info.text;
}

function updateEspPill(els, brokerStatus, esp) {
  if (brokerStatus !== "connected") {
    els.pillEsp.dataset.tone = "neutral";
    els.pillEspText.textContent = "UNKNOWN";
    return;
  }
  if (esp.online === true) {
    els.pillEsp.dataset.tone = "good";
    els.pillEspText.textContent = "ONLINE";
  } else if (esp.online === false) {
    els.pillEsp.dataset.tone = "crit";
    els.pillEspText.textContent = "OFFLINE";
  } else {
    els.pillEsp.dataset.tone = "neutral";
    els.pillEspText.textContent = "UNKNOWN";
  }
}

function updateTelemetryPill(els, brokerStatus, telemetry, health) {
  if (brokerStatus !== "connected") {
    els.pillTelemetry.dataset.tone = "crit";
    els.pillTelemetryText.textContent = "OFFLINE";
  } else if (telemetry.lastRxMs === null) {
    els.pillTelemetry.dataset.tone = "warn";
    els.pillTelemetryText.textContent = "WAITING";
  } else if (health.telemetryStale) {
    els.pillTelemetry.dataset.tone = "crit";
    els.pillTelemetryText.textContent = "STALE >3s";
  } else {
    els.pillTelemetry.dataset.tone = "good";
    els.pillTelemetryText.textContent = "LIVE";
  }
}

function updateTwinPill(els, sim) {
  if (!sim.online || !sim.data) {
    els.pillTwin.dataset.tone = "neutral";
    els.pillTwinText.textContent = "OFFLINE";
    return;
  }
  const mode =
    typeof sim.data.ctrl_mode === "string"
      ? sim.data.ctrl_mode.toUpperCase()
      : "ACTIVE";
  els.pillTwin.dataset.tone = mode === "AUTO" ? "warn" : "good";
  els.pillTwinText.textContent = mode;
}

function renderAlerts(listEl, countEl, alerts) {
  countEl.textContent = String(alerts.length);
  listEl.textContent = "";

  if (!alerts.length) {
    const empty = document.createElement("li");
    empty.className = "alert-empty";
    empty.textContent = "No alerts received.";
    listEl.appendChild(empty);
    return;
  }

  for (const a of alerts) {
    const meta = SEVERITY_META[a.severity] || SEVERITY_META.info;
    const li = document.createElement("li");
    li.className = `alert-item ${meta.cls}`;

    const header = document.createElement("div");
    header.className = "alert-head";

    const sevBadge = document.createElement("span");
    sevBadge.className = "alert-sev";

    const iconSpan = document.createElement("span");
    iconSpan.className = "alert-icon";
    iconSpan.setAttribute("aria-hidden", "true");
    iconSpan.textContent = meta.icon;

    const labelSpan = document.createElement("span");
    labelSpan.textContent = meta.label;

    sevBadge.append(iconSpan, labelSpan);

    const typeSpan = document.createElement("span");
    typeSpan.className = "alert-type";
    typeSpan.textContent = a.type || "unknown";

    const timeSpan = document.createElement("span");
    timeSpan.className = "alert-time";
    timeSpan.textContent = fmtTime(a.time);

    header.append(sevBadge, typeSpan, timeSpan);

    const msgEl = document.createElement("p");
    msgEl.className = "alert-msg";
    msgEl.textContent = a.msg || "—";

    li.append(header, msgEl);
    listEl.appendChild(li);
  }
}
