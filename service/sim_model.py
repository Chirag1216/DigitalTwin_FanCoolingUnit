"""Physics-based simulation model — predicts expected sensor values from the preset.

Operating points come from hardware testing (RPM and vibration measured;
current estimated):
  Preset  Duty  RPM    Current(est)
  OFF      0%     0      ~0 mA
  LOW     30%  1140     ~80 mA
  MEDIUM  50%  1680    ~120 mA
  HIGH    70%  2220    ~170 mA
  MAX     90%  2760    ~230 mA

After a preset change the fan approaches the new operating point over the
firmware's SETTLE_MS window; the model follows a first-order (exponential)
response, which is how a fan rotor accelerates against air drag.
"""

import math
from typing import Any, Dict, Optional

from config import SETTLE_MS

_OP_POINTS = {
    0: {"rpm": 0,    "current_mA": 0.0,   "ax_std_base": 0.028},
    1: {"rpm": 1140, "current_mA": 80.0,  "ax_std_base": 0.134},
    2: {"rpm": 1680, "current_mA": 120.0, "ax_std_base": 0.455},
    3: {"rpm": 2220, "current_mA": 170.0, "ax_std_base": 0.518},
    4: {"rpm": 2760, "current_mA": 230.0, "ax_std_base": 0.969},
}

# ~95% of the step is reached by SETTLE_MS (3 time constants)
_TAU_MS = SETTLE_MS / 3.0


class SimModel:
    def __init__(self):
        self._preset: Optional[int] = None
        self._change_t_ms = 0
        # predicted values at the moment of the last preset change
        self._from_rpm = 0.0
        self._from_current = 0.0
        self._last_rpm = 0.0
        self._last_current = 0.0

    def predict(self, telemetry: dict) -> Dict[str, Any]:
        preset = telemetry.get("preset")
        if preset not in _OP_POINTS:
            preset = 0
        t_ms = telemetry.get("t_ms") or 0
        settled = bool(telemetry.get("settled", 0))
        op = _OP_POINTS[preset]

        if self._preset is None:
            # first sample: assume we're at the operating point if settled,
            # otherwise start the transient from the measured RPM
            self._preset = preset
            self._change_t_ms = t_ms
            rpm = telemetry.get("rpm")
            self._from_rpm = float(op["rpm"]) if settled or not isinstance(rpm, (int, float)) else float(rpm)
            self._from_current = op["current_mA"] if settled else 0.0
        elif preset != self._preset:
            # start the transient from wherever the model was
            self._preset = preset
            self._change_t_ms = t_ms
            self._from_rpm = self._last_rpm
            self._from_current = self._last_current

        if settled:
            pred_rpm, pred_current = float(op["rpm"]), op["current_mA"]
        else:
            elapsed = max(0, t_ms - self._change_t_ms)
            k = 1.0 - math.exp(-elapsed / _TAU_MS)
            pred_rpm = self._from_rpm + (op["rpm"] - self._from_rpm) * k
            pred_current = self._from_current + (op["current_mA"] - self._from_current) * k

        self._last_rpm, self._last_current = pred_rpm, pred_current
        return {
            "sim_rpm": round(pred_rpm),
            "sim_current_mA": round(pred_current, 1),
            "sim_ax_std": op["ax_std_base"],
        }


class SimTemperature:
    """Demo temperature source: triangle wave between `low` and `high`.

    Heats at `rate` °C/s, cools at `rate * cool_factor` °C/s. The default rate
    is slow enough that the fan (12 s settle) visits every preset on the way.
    """

    def __init__(self, low: float, high: float, rate: float, cool_factor: float = 0.5,
                 clock=None):
        import time
        self._clock = clock or time.monotonic
        self.low, self.high, self.rate = low, high, rate
        self.cool_factor = cool_factor
        self.temp = low
        self.rising = True
        self._last = self._clock()

    def step(self) -> float:
        now = self._clock()
        dt = max(0.0, now - self._last)
        self._last = now
        if self.rising:
            self.temp += self.rate * dt
            if self.temp >= self.high:
                self.temp, self.rising = self.high, False
        else:
            self.temp -= self.rate * self.cool_factor * dt
            if self.temp <= self.low:
                self.temp, self.rising = self.low, True
        return round(self.temp, 2)
