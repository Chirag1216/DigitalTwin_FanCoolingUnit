"""Anomaly detector — compares physical telemetry against simulated twin predictions.

Detects:
  1. Fan stall      — duty > 0 but RPM near zero (settled only)
  2. RPM deviation  — RPM differs from the model by > RPM_TOLERANCE_PCT (settled only)
  3. High vibration — ax_std above the limit for the current preset
  4. Sensor offline — DS18B20 reading is null
"""

import logging
import time
from typing import Any, Dict, List, Optional

from config import (
    RPM_TOLERANCE_PCT, VIBRATION_LIMITS, STALL_RPM_THRESHOLD, ALERT_COOLDOWN_S,
)

log = logging.getLogger("anomaly")


def _num(v) -> Optional[float]:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


class AnomalyDetector:
    def __init__(self, mqtt_client, cooldown: float = ALERT_COOLDOWN_S, clock=time.time):
        self._mqtt = mqtt_client
        self._alerts: List[Dict[str, Any]] = []
        self._last_alert_time: Dict[str, float] = {}
        self._cooldown = cooldown
        self._clock = clock

    def check(self, telemetry: dict, sim: dict) -> List[Dict[str, Any]]:
        now = self._clock()
        found = []

        rpm = _num(telemetry.get("rpm"))
        duty = _num(telemetry.get("duty_pct")) or 0.0
        sim_rpm = _num(sim.get("sim_rpm")) or 0.0

        # RPM checks only once the firmware reports the fan settled
        if telemetry.get("settled") and rpm is not None:
            if duty > 0 and rpm < STALL_RPM_THRESHOLD:
                found.append(("fan_stall", "critical",
                              f"Fan stall: duty={duty:.0f}% but RPM={rpm:.0f}",
                              {"rpm": rpm, "duty": duty}))
            elif sim_rpm > 0:
                dev = abs(rpm - sim_rpm) / sim_rpm * 100.0
                if dev > RPM_TOLERANCE_PCT:
                    found.append(("rpm_deviation", "warning",
                                  f"RPM {rpm:.0f} is {dev:.1f}% off model {sim_rpm:.0f} "
                                  f"(±{RPM_TOLERANCE_PCT:.0f}%)",
                                  {"actual_rpm": rpm, "sim_rpm": sim_rpm,
                                   "deviation_pct": round(dev, 1)}))

        ax_std = _num(telemetry.get("ax_std"))
        preset = telemetry.get("preset")
        if telemetry.get("settled") and preset in range(len(VIBRATION_LIMITS)):
            limit = VIBRATION_LIMITS[preset]
        else:
            limit = max(VIBRATION_LIMITS)  # spinning up/down: only big shocks
        if ax_std is not None and ax_std > limit:
            found.append(("high_vibration", "warning",
                          f"Vibration ax_std={ax_std:.3f} m/s² > {limit} m/s²",
                          {"ax_std": ax_std, "limit": limit}))

        if telemetry.get("ds_temp_C") is None:
            found.append(("sensor_offline", "info",
                          "DS18B20 temperature sensor offline (null reading)", None))

        alerts = []
        for a_type, sev, msg, data in found:
            if now - self._last_alert_time.get(a_type, -1e9) < self._cooldown:
                continue
            self._last_alert_time[a_type] = now
            alert = {"type": a_type, "severity": sev, "msg": msg, "time": now}
            if data:
                alert["data"] = data
            alerts.append(alert)
            self._alerts.append(alert)
            self._mqtt.publish_alert(alert)

        del self._alerts[:-100]
        return alerts

    @property
    def recent_alerts(self) -> List[Dict[str, Any]]:
        return list(self._alerts[-10:])
