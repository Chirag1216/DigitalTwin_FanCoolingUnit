"""Closed-loop thermal controller — maps enclosure temperature to fan preset.

Modes:
  AUTO   — controller picks the preset from the temperature
  MANUAL — operator picks the preset (keys 0-4); controller only observes

Thresholds [T0..T3] separate presets 0..4.
  step UP   from p to p+1 when temp >= T[p]
  step DOWN from p to p-1 when temp <  T[p-1] - hysteresis
Several steps can be taken at once if the temperature jumped.
"""

import json
import logging
import os
import time
from typing import List, Optional

from config import (
    PRESETS, TEMP_MARGIN_PER_STEP, TEMP_HYSTERESIS, CMD_MIN_INTERVAL_S,
    TEMP_THRESHOLDS_ABSOLUTE, THERMAL_PROFILE_PATH,
    TEMP_VALID_RANGE, TEMP_MAX_JUMP, TEMP_JUMP_CONFIRM_S,
)

log = logging.getLogger("thermal")


class TempFilter:
    """Ignores impossible sensor readings (e.g. 107 °C during a power glitch).

    Returns the reading if plausible, otherwise the last good one. A large jump
    that stays for TEMP_JUMP_CONFIRM_S is accepted as real.
    """

    def __init__(self, clock=time.monotonic):
        self._clock = clock
        self._good: Optional[float] = None
        self._jump_since: Optional[float] = None

    def update(self, temp):
        if not isinstance(temp, (int, float)):
            return None  # sensor offline: let the controller hold
        lo, hi = TEMP_VALID_RANGE
        if not lo <= temp <= hi:
            log.warning(f"Ignoring impossible temperature {temp}°C")
            return self._good
        if self._good is not None and abs(temp - self._good) > TEMP_MAX_JUMP:
            now = self._clock()
            if self._jump_since is None:
                self._jump_since = now
                log.warning(f"Ignoring sudden jump {self._good} -> {temp}°C")
            if now - self._jump_since < TEMP_JUMP_CONFIRM_S:
                return self._good
        self._good, self._jump_since = float(temp), None
        return self._good


class ThermalController:
    def __init__(self, mqtt_client, profile_path: Optional[str] = None,
                 margin: float = TEMP_MARGIN_PER_STEP,
                 hysteresis: float = TEMP_HYSTERESIS,
                 min_cmd_interval: float = CMD_MIN_INTERVAL_S):
        self._mqtt = mqtt_client
        self._mode = "auto"
        self._margin = margin
        self._hyst = hysteresis
        self._min_cmd_interval = min_cmd_interval
        self._last_cmd_time = 0.0
        self._ambient: Optional[float] = None
        self._thresholds: List[float] = []
        self._source = "absolute"

        path = profile_path or THERMAL_PROFILE_PATH
        if os.path.exists(path):
            self._load_profile(path)
        else:
            log.warning(f"No thermal profile at {path} — run --calibrate for relative thresholds")
            self._use_absolute_fallback()

    def _load_profile(self, path: str):
        try:
            with open(path, "r", encoding="utf-8") as f:
                profile = json.load(f)
            ambient = profile.get("ambient_C")
            if not isinstance(ambient, (int, float)):
                log.warning("Profile has no valid ambient_C — using absolute thresholds")
                self._use_absolute_fallback()
                return
            self._ambient = float(ambient)
            self._thresholds = [
                round(self._ambient + (i + 1) * self._margin, 2)
                for i in range(len(PRESETS) - 1)
            ]
            self._source = "profile"
            log.info(f"Thermal profile: ambient={self._ambient:.2f}°C thresholds={self._thresholds}")
        except (OSError, ValueError) as e:
            log.error(f"Failed to load profile ({e}) — using absolute thresholds")
            self._use_absolute_fallback()

    def _use_absolute_fallback(self):
        self._ambient = None
        self._thresholds = list(TEMP_THRESHOLDS_ABSOLUTE)
        self._source = "absolute"

    @property
    def mode(self) -> str:
        return self._mode

    @property
    def ambient(self) -> Optional[float]:
        return self._ambient

    @property
    def thresholds(self) -> List[float]:
        return self._thresholds

    @property
    def source(self) -> str:
        return self._source

    def set_mode(self, mode: str):
        if mode in ("auto", "manual") and mode != self._mode:
            self._mode = mode
            # let AUTO act immediately after switching back
            self._last_cmd_time = 0.0
            log.info(f"Controller mode -> {mode.upper()}")

    def toggle_mode(self):
        self.set_mode("manual" if self._mode == "auto" else "auto")

    def evaluate(self, telemetry: dict, temp: Optional[float] = None) -> dict:
        """Decide on a preset. `temp` overrides telemetry['ds_temp_C'] (sim-temp demo)."""
        if temp is None:
            temp = telemetry.get("ds_temp_C")
        current = telemetry.get("preset")
        settled = bool(telemetry.get("settled", 0))

        decision = {
            "temp_C": temp, "ambient_C": self._ambient,
            "current_preset": current, "target_preset": current,
            "mode": self._mode, "action": "hold",
        }

        if not isinstance(temp, (int, float)) or not isinstance(current, int) \
                or not (0 <= current < len(PRESETS)):
            decision["action"] = "skip"
            decision["reason"] = "missing temperature or preset"
            return decision

        target = self.compute_target(float(temp), current)
        decision["target_preset"] = target

        if self._mode != "auto":
            decision["action"] = "manual"
        elif target == current:
            decision["action"] = "hold"
        elif not settled:
            # fan is still spinning up/down from the last change — wait
            decision["action"] = "settling"
        elif time.time() - self._last_cmd_time < self._min_cmd_interval:
            decision["action"] = "rate_limited"
        else:
            self._mqtt.publish_cmd(target)
            self._last_cmd_time = time.time()
            decision["action"] = "changed"
            log.info(f"{temp:.1f}°C -> preset {target} ({PRESETS[target]['name']}), "
                     f"was {current} ({PRESETS[current]['name']})")
        return decision

    def compute_target(self, temp: float, current: Optional[int] = None) -> int:
        th = self._thresholds
        if current is None or not (0 <= current < len(PRESETS)):
            return sum(1 for t in th if temp >= t)

        target = current
        while target < len(th) and temp >= th[target]:
            target += 1
        if target > current:
            return target
        while target > 0 and temp < th[target - 1] - self._hyst:
            target -= 1
        return target
