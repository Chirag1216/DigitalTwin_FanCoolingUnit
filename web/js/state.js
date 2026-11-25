/**
 * Central reactive state store for FAN01 Digital Twin Dashboard.
 * Manages MQTT telemetry, 3 s watchdog, 2-min ring buffers (240 samples @ 500 ms),
 * per-sensor health rules, and safe null -> "—" formatting.
 */

export const PRESET_NAMES = ["OFF", "LOW", "MEDIUM", "HIGH", "MAX"];
export const PRESET_DUTY = [0, 30, 50, 70, 90];
export const VIB_LIMITS = [0.25, 0.30, 0.75, 0.85, 1.50]; // matches service/config.py
export const UNSETTLED_VIB_LIMIT = 1.50;

export const STALE_MS = 3000;
export const DS_STALE_MS = 6000;
export const HISTORY_MS = 120000;
export const HISTORY_MAX_SAMPLES = 240; // 2 min at 500 ms
export const MAX_ALERTS = 50;
export const MAX_EVENTS = 30;

export function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

export function fmt(v, decimals = 0) {
  return isNum(v) ? v.toFixed(decimals) : "—";
}

export function fmtTime(unixSeconds) {
  if (!isNum(unixSeconds)) return "—";
  try {
    return new Date(unixSeconds * 1000).toLocaleTimeString([], {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "—";
  }
}

export function getVibLimit(telemetry) {
  if (!telemetry) return UNSETTLED_VIB_LIMIT;
  const settled = telemetry.settled === 1 || telemetry.settled === true;
  const preset = telemetry.preset;
  if (settled && Number.isInteger(preset) && preset >= 0 && preset < VIB_LIMITS.length) {
    return VIB_LIMITS[preset];
  }
  return UNSETTLED_VIB_LIMIT;
}

export function computeHealth(s, now = Date.now()) {
  const t = s.telemetry.data;
  const brokerConnected = s.broker.status === "connected";
  const espOffline = s.esp.online === false;
  const telemetryStale =
    s.telemetry.lastRxMs === null || now - s.telemetry.lastRxMs > STALE_MS;
  const globalOffline = !brokerConnected || espOffline || telemetryStale;

  const inaDisconnected =
    globalOffline || !t || t.ina_fresh === 0 || !isNum(t.current_mA);
  const dsDisconnected =
    globalOffline ||
    !t ||
    !isNum(t.ds_temp_C) ||
    (isNum(t.ds_age_ms) && t.ds_age_ms > DS_STALE_MS);
  const mpuDisconnected =
    globalOffline || !t || !isNum(t.ax_std) || !isNum(t.n) || t.n === 0;
  const rpmDisconnected = globalOffline || !t || !isNum(t.rpm);

  return {
    brokerConnected,
    espOffline,
    telemetryStale,
    globalOffline,
    inaDisconnected,
    dsDisconnected,
    mpuDisconnected,
    rpmDisconnected,
  };
}

class DashboardStore {
  constructor() {
    this._listeners = new Set();
    this._state = {
      broker: {
        status: "disconnected", // disconnected | connecting | connected | error
        message: "Not connected",
        host: "localhost",
        port: 9001,
        user: "web",
      },
      esp: {
        online: null, // null | boolean
        lastStatus: null,
      },
      telemetry: {
        data: null,
        lastRxMs: null,
        stale: true,
      },
      sim: {
        data: null,
        lastRxMs: null,
        online: false,
      },
      history: [], // { t, rpm, simRpm, axStd, vibLimit, dsTemp }
      alerts: [],
      events: [],
      ui: {
        cameraPreset: "iso",
      },
    };

    this._watchdogId = setInterval(() => this._tickWatchdog(), 500);
  }

  getState() {
    return this._state;
  }

  subscribe(fn) {
    this._listeners.add(fn);
    fn(this._state);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    for (const fn of this._listeners) {
      try {
        fn(this._state);
      } catch (err) {
        console.error("[state] listener error:", err);
      }
    }
  }

  setBrokerState(patch) {
    const prevStatus = this._state.broker.status;
    this._state.broker = { ...this._state.broker, ...patch };
    if (patch.status && patch.status !== "connected" && prevStatus === "connected") {
      this._state.sim.online = false;
    }
    this._emit();
  }

  setCameraPreset(preset) {
    if (this._state.ui.cameraPreset === preset) return;
    this._state.ui = { ...this._state.ui, cameraPreset: preset };
    this._emit();
  }

  onTelemetry(payload) {
    const now = Date.now();
    this._state.telemetry = {
      data: payload,
      lastRxMs: now,
      stale: false,
    };
    // Receiving live telemetry implies ESP32 is online even if retained status arrived earlier or was missed
    if (this._state.esp.online !== true) {
      this._state.esp.online = true;
    }

    const vibLimit = getVibLimit(payload);
    const simRpm =
      this._state.sim.online && isNum(this._state.sim.data?.sim_rpm)
        ? this._state.sim.data.sim_rpm
        : null;

    this._state.history.push({
      t: now,
      rpm: isNum(payload.rpm) ? payload.rpm : null,
      simRpm,
      axStd: isNum(payload.ax_std) ? payload.ax_std : null,
      vibLimit,
      dsTemp: isNum(payload.ds_temp_C) ? payload.ds_temp_C : null,
    });

    const cutoff = now - HISTORY_MS;
    while (
      this._state.history.length > HISTORY_MAX_SAMPLES ||
      (this._state.history.length > 0 && this._state.history[0].t < cutoff)
    ) {
      this._state.history.shift();
    }

    this._emit();
  }

  onStatus(payload) {
    const online = typeof payload.online === "boolean" ? payload.online : null;
    this._state.esp = {
      online,
      lastStatus: payload,
    };
    if (online === false) {
      this._state.telemetry.stale = true;
    }
    this._pushEvent(
      online === true
        ? `ESP32 online (${payload.name ?? "preset " + (payload.preset ?? "—")})`
        : online === false
          ? "ESP32 went offline (LWT)"
          : "ESP32 status updated"
    );
    this._emit();
  }

  onSim(payload) {
    const now = Date.now();
    this._state.sim = {
      data: payload,
      lastRxMs: now,
      online: true,
    };
    // Backfill simRpm on the latest history sample if it arrived just before this sim packet
    const last = this._state.history[this._state.history.length - 1];
    if (last && last.simRpm === null && now - last.t < 450 && isNum(payload.sim_rpm)) {
      last.simRpm = payload.sim_rpm;
    }
    this._emit();
  }

  onAlert(payload) {
    const now = Date.now();
    const alert = {
      type: typeof payload.type === "string" ? payload.type : "unknown",
      severity: typeof payload.severity === "string" ? payload.severity : "info",
      msg: typeof payload.msg === "string" ? payload.msg : JSON.stringify(payload),
      time: isNum(payload.time) ? payload.time : null,
      data: payload.data ?? null,
      receivedAtMs: now,
    };
    if (alert.type === "twin_offline") {
      this._state.sim.online = false;
    }
    this._state.alerts.unshift(alert);
    if (this._state.alerts.length > MAX_ALERTS) {
      this._state.alerts.length = MAX_ALERTS;
    }
    this._emit();
  }

  onEvent(payload) {
    const msg =
      typeof payload.msg === "string"
        ? payload.msg
        : JSON.stringify(payload);
    this._pushEvent(msg);
    this._emit();
  }

  _pushEvent(msg) {
    this._state.events.unshift({
      msg,
      receivedAtMs: Date.now(),
    });
    if (this._state.events.length > MAX_EVENTS) {
      this._state.events.length = MAX_EVENTS;
    }
  }

  _tickWatchdog() {
    const now = Date.now();
    let changed = false;

    const wasStale = this._state.telemetry.stale;
    const isStale =
      this._state.telemetry.lastRxMs === null ||
      now - this._state.telemetry.lastRxMs > STALE_MS;

    if (wasStale !== isStale) {
      this._state.telemetry.stale = isStale;
      changed = true;
    }

    // If telemetry continues arriving for >3 s without any sim message, twin is offline
    if (
      this._state.sim.online &&
      this._state.telemetry.lastRxMs !== null &&
      this._state.sim.lastRxMs !== null &&
      this._state.telemetry.lastRxMs - this._state.sim.lastRxMs > STALE_MS
    ) {
      this._state.sim.online = false;
      changed = true;
    }

    if (changed) {
      this._emit();
    }
  }
}

export const store = new DashboardStore();
