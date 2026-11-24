"""MQTT client — connects to broker, dispatches messages, publishes commands & alerts."""

import json
import logging
import os
import threading
from typing import Callable, Dict, Optional

import paho.mqtt.client as paho

from config import (
    TOPIC_BASE, TOPIC_CMD, TOPIC_SIM, TOPIC_ALERT, TOPIC_TELEMETRY,
    TOPIC_STATUS, TOPIC_EVENT, CLIENT_ID_PREFIX, PRESETS,
)

log = logging.getLogger("mqtt")

# CONNACK reason codes that will never succeed on retry
_FATAL_RC = {"Not authorized", "Bad user name or password", "Bad username or password"}


class MqttClient:
    def __init__(self, host: str, port: int, user: str, password: str):
        # Unique id: a second instance (e.g. --calibrate while the twin runs)
        # must not kick this one off the broker.
        client_id = f"{CLIENT_ID_PREFIX}-{os.getpid()}"
        self._client = paho.Client(paho.CallbackAPIVersion.VERSION2, client_id=client_id)
        if user:
            self._client.username_pw_set(user, password)
        self._client.on_connect = self._on_connect
        self._client.on_disconnect = self._on_disconnect
        self._client.on_message = self._on_message
        self._host = host
        self._port = port
        self._connected = False
        self._fatal_error: Optional[str] = None
        self._connect_done = threading.Event()  # set on first CONNACK (ok or not)
        self._handlers: Dict[str, Callable[[dict], None]] = {}

    def on(self, topic_suffix: str, handler: Callable[[dict], None]):
        """Register handler(payload_dict) for fantwin/fan01/<suffix>."""
        self._handlers[f"{TOPIC_BASE}/{topic_suffix}"] = handler

    def connect(self):
        lwt = json.dumps({"type": "twin_offline", "severity": "info",
                          "msg": "Twin service went offline", "online": False})
        self._client.will_set(TOPIC_ALERT, lwt, qos=1, retain=False)
        self._client.reconnect_delay_set(min_delay=1, max_delay=5)
        self._client.connect_async(self._host, self._port, keepalive=10)

    def wait_connected(self, timeout: float) -> bool:
        """Block until the first CONNACK or timeout. Returns True if connected."""
        self._connect_done.wait(timeout)
        return self._connected

    @property
    def host(self) -> str:
        return self._host

    @property
    def port(self) -> int:
        return self._port

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def fatal_error(self) -> Optional[str]:
        """Non-retryable connect error (e.g. bad password), else None."""
        return self._fatal_error

    def loop_start(self):
        self._client.loop_start()

    def loop_stop(self):
        try:
            self._client.disconnect()
        except Exception:
            pass
        self._client.loop_stop()

    def publish_cmd(self, preset: int):
        if not (0 <= preset < len(PRESETS)):
            log.error(f"Invalid preset index: {preset}")
            return
        self._client.publish(TOPIC_CMD, json.dumps({"preset": preset}), qos=1)
        log.info(f"CMD -> preset {preset} ({PRESETS[preset]['name']})")

    def publish_sim(self, data: dict):
        self._client.publish(TOPIC_SIM, json.dumps(data), qos=0)

    def publish_alert(self, alert: dict):
        self._client.publish(TOPIC_ALERT, json.dumps(alert), qos=1)
        log.warning(f"ALERT [{alert.get('type')}] {alert.get('msg')}")

    def _on_connect(self, client, userdata, flags, rc, properties=None):
        if not rc.is_failure:
            self._connected = True
            self._fatal_error = None
            # Only what we consume — not our own sim/alert traffic.
            for t in (TOPIC_TELEMETRY, TOPIC_STATUS, TOPIC_EVENT):
                client.subscribe(t, qos=1)
            log.info(f"Connected to broker {self._host}:{self._port}")
        else:
            reason = str(rc)
            log.error(f"MQTT connect refused: {reason}")
            if reason in _FATAL_RC:
                self._fatal_error = reason
                client.disconnect()  # stop the retry loop
        self._connect_done.set()

    def _on_disconnect(self, client, userdata, disconnect_flags, rc=None, properties=None):
        was = self._connected
        self._connected = False
        if was and getattr(rc, "is_failure", True):  # not our own clean disconnect
            log.warning(f"Disconnected from broker (rc={rc}) — retrying")

    def _on_message(self, client, userdata, msg):
        handler = self._handlers.get(msg.topic)
        if not handler:
            return
        try:
            payload = json.loads(msg.payload.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            log.warning(f"Non-JSON payload on {msg.topic}: {msg.payload[:80]!r}")
            return
        if not isinstance(payload, dict):
            payload = {"value": payload}
        try:
            handler(payload)
        except Exception:
            log.exception(f"Handler error for {msg.topic}")
