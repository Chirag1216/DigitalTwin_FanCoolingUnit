/**
 * MQTT over WebSocket client (mqtt@5.3.4) for FAN01 Digital Twin.
 * Subscribes to fantwin/fan01/# and publishes {"preset": N} at QoS 1 to fantwin/fan01/cmd.
 */

import { store } from "./state.js";

const TOPIC_BASE = "fantwin/fan01/";
const TOPIC_ALL = `${TOPIC_BASE}#`;
const TOPIC_CMD = `${TOPIC_BASE}cmd`;

class MqttDashboardClient {
  constructor() {
    this._client = null;
    this._authError = false;
  }

  connect({ host, port = 9001, user = "", password = "" }) {
    this.disconnect();
    this._authError = false;

    if (typeof window.mqtt === "undefined") {
      store.setBrokerState({
        status: "error",
        message: "MQTT bundle missing (web/vendor/mqtt.min.js)",
      });
      return;
    }

    const cleanHost = (host || "").trim() || "localhost";
    const parsedPort = Number.parseInt(String(port), 10) || 9001;
    const url = buildWsUrl(cleanHost, parsedPort);

    store.setBrokerState({
      status: "connecting",
      message: `Connecting to ${url}…`,
      host: cleanHost,
      port: parsedPort,
      user: user.trim(),
    });

    const opts = {
      reconnectPeriod: 3000,
      connectTimeout: 8000,
      clean: true,
    };
    if (user.trim()) {
      opts.username = user.trim();
      opts.password = password;
    }

    let client;
    try {
      client = window.mqtt.connect(url, opts);
    } catch (err) {
      store.setBrokerState({
        status: "error",
        message: err?.message || "Invalid broker URL",
      });
      return;
    }

    this._client = client;

    client.on("connect", () => {
      if (this._client !== client) return;
      this._authError = false;
      store.setBrokerState({
        status: "connected",
        message: `Connected (${cleanHost}:${parsedPort})`,
      });
      client.subscribe(TOPIC_ALL, { qos: 0 }, (err) => {
        if (err) {
          console.error("[mqtt] subscribe failed:", err);
        }
      });
    });

    client.on("reconnect", () => {
      if (this._client !== client || this._authError) return;
      store.setBrokerState({
        status: "connecting",
        message: "Reconnecting…",
      });
    });

    client.on("offline", () => {
      if (this._client !== client || this._authError) return;
      store.setBrokerState({
        status: "disconnected",
        message: "Broker offline — retrying",
      });
    });

    client.on("close", () => {
      if (this._client !== client || this._authError) return;
      store.setBrokerState({
        status: "disconnected",
        message: "Disconnected",
      });
    });

    client.on("error", (err) => {
      if (this._client !== client) return;
      const msg = err?.message || "Connection error";
      if (/authori|password|not authorized|bad user/i.test(msg)) {
        this._authError = true;
        store.setBrokerState({
          status: "error",
          message: "Auth refused — check user/password",
        });
        client.end(true);
      } else {
        store.setBrokerState({
          status: "error",
          message: msg,
        });
      }
    });

    client.on("message", (topic, payloadBuf) => {
      if (this._client !== client) return;
      if (!topic.startsWith(TOPIC_BASE)) return;
      let parsed;
      try {
        parsed = JSON.parse(payloadBuf.toString());
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object") return;

      const kind = topic.slice(TOPIC_BASE.length);
      if (kind === "telemetry") {
        store.onTelemetry(parsed);
      } else if (kind === "status") {
        store.onStatus(parsed);
      } else if (kind === "sim") {
        store.onSim(parsed);
      } else if (kind === "alert") {
        store.onAlert(parsed);
      } else if (kind === "event") {
        store.onEvent(parsed);
      }
    });
  }

  disconnect() {
    if (this._client) {
      const old = this._client;
      this._client = null;
      try {
        old.end(true);
      } catch {
        // ignore cleanup errors
      }
    }
    store.setBrokerState({
      status: "disconnected",
      message: "Disconnected",
    });
  }

  publishPreset(preset) {
    const n = Number(preset);
    if (!Number.isInteger(n) || n < 0 || n > 4) return false;
    if (!this._client || store.getState().broker.status !== "connected") {
      return false;
    }
    this._client.publish(TOPIC_CMD, JSON.stringify({ preset: n }), { qos: 1 });
    return true;
  }
}

function buildWsUrl(hostInput, port) {
  if (/^wss?:\/\//i.test(hostInput)) {
    return hostInput;
  }
  if (hostInput.includes(":")) {
    return `ws://${hostInput}`;
  }
  return `ws://${hostInput}:${port}`;
}

export const mqttClient = new MqttDashboardClient();
