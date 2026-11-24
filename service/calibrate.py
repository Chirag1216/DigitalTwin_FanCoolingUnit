"""Thermal profiler — steps through each preset and measures steady-state temperature.

Usage: python main.py --calibrate --password <twin_pass> [--cal-settle 60 --cal-sample 60]

  1. Wait for live telemetry (aborts if the ESP32 isn't publishing)
  2. For each preset OFF..MAX: command it, wait until the ESP32 reports it,
     wait `settle` s, then average ds_temp_C over `sample` s
  3. Save thermal_profile.json (ambient = OFF reading) and set the fan back to OFF
"""

import json
import logging
import statistics
import threading
import time
from typing import List, Optional

from config import PRESETS, CALIBRATE_SETTLE_SECS, CALIBRATE_SAMPLE_SECS, THERMAL_PROFILE_PATH

log = logging.getLogger("calibrate")


class CalibrationError(RuntimeError):
    pass


class ThermalCalibrator:
    def __init__(self, mqtt_client, profile_path: str = THERMAL_PROFILE_PATH,
                 sleep=time.sleep):
        self._mqtt = mqtt_client
        self._profile_path = profile_path
        self._sleep = sleep
        self._lock = threading.Lock()
        self._temps: List[float] = []
        self._collecting = False
        self._last: Optional[dict] = None
        self._got_telemetry = threading.Event()
        self._profile = {"ambient_C": None, "profiles": {}}

    def on_telemetry(self, payload: dict):
        with self._lock:
            self._last = payload
            t = payload.get("ds_temp_C")
            if self._collecting and isinstance(t, (int, float)):
                self._temps.append(float(t))
        self._got_telemetry.set()

    def _wait_for_preset(self, idx: int, timeout: float = 10.0):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            with self._lock:
                if self._last and self._last.get("preset") == idx:
                    return
            time.sleep(0.2)
        raise CalibrationError(f"ESP32 did not switch to preset {idx} within {timeout:.0f}s")

    def run(self, settle_secs: Optional[int] = None, sample_secs: Optional[int] = None) -> dict:
        settle = CALIBRATE_SETTLE_SECS if settle_secs is None else settle_secs
        sample = CALIBRATE_SAMPLE_SECS if sample_secs is None else sample_secs

        print("==================================================")
        print("     THERMAL CALIBRATION — Fan Digital Twin       ")
        print("==================================================")
        print(f"  Settle: {settle}s | Sample: {sample}s per preset "
              f"| Total ≈ {len(PRESETS) * (settle + sample) / 60:.1f} min\n")

        print("  Waiting for telemetry from the ESP32...")
        if not self._got_telemetry.wait(15):
            raise CalibrationError("No telemetry within 15s — is the ESP32 powered and connected?")

        try:
            for idx, preset in enumerate(PRESETS):
                print(f"--- Preset {idx}: {preset['name']} (duty {preset['duty']}%) ---")
                self._mqtt.publish_cmd(idx)
                self._wait_for_preset(idx)
                print(f"  Settling {settle}s...")
                self._sleep(settle)

                with self._lock:
                    self._temps.clear()
                    self._collecting = True
                print(f"  Sampling DS18B20 {sample}s...")
                self._sleep(sample)
                with self._lock:
                    self._collecting = False
                    temps = list(self._temps)

                if not temps:
                    raise CalibrationError(f"No DS18B20 readings at preset {preset['name']} "
                                           "— check the sensor wiring")
                avg = statistics.mean(temps)
                std = statistics.stdev(temps) if len(temps) > 1 else 0.0
                print(f"  {avg:.2f}°C (±{std:.2f}°C, {len(temps)} samples)")

                self._profile["profiles"][str(idx)] = {
                    "name": preset["name"], "duty": preset["duty"],
                    "temp_C": round(avg, 2), "std_C": round(std, 3), "samples": len(temps),
                }
                if idx == 0:
                    self._profile["ambient_C"] = round(avg, 2)
        finally:
            # never leave the fan parked at MAX (or wherever we aborted)
            self._mqtt.publish_cmd(0)

        self._profile["created"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        self._profile["settle_s"], self._profile["sample_s"] = settle, sample
        with open(self._profile_path, "w", encoding="utf-8") as f:
            json.dump(self._profile, f, indent=2)

        print(f"\n[OK] Thermal profile written to {self._profile_path} (fan set back to OFF)")
        self._print_summary()
        return self._profile

    def _print_summary(self):
        ambient = self._profile["ambient_C"]
        print("\n+---------+------+----------+------------+")
        print("| Preset  | Duty |  Temp °C | dT from amb|")
        print("+---------+------+----------+------------+")
        for idx in range(len(PRESETS)):
            p = self._profile["profiles"][str(idx)]
            delta = f"{p['temp_C'] - ambient:+.2f}°C"
            print(f"| {p['name']:7s} | {str(p['duty']) + '%':>4s} | {p['temp_C']:8.2f} | {delta:>10} |")
        print("+---------+------+----------+------------+\n")
