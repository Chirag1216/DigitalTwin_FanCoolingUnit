"""CSV data logger — records all telemetry fields plus twin predictions."""

import csv
import os
import threading
from datetime import datetime

from config import LOG_DIR

COLUMNS = [
    "timestamp", "t_ms", "n",
    "ax_mean", "ay_mean", "az_mean", "ax_std", "ay_std", "az_std",
    "ax_p2p", "ay_p2p", "az_p2p",
    "gx_mean", "gy_mean", "gz_mean", "gx_std", "gy_std", "gz_std",
    "temp_C", "shunt_mV", "bus_V", "load_V", "current_mA",
    "ina_age_ms", "ina_fresh", "ds_temp_C", "ds_age_ms",
    "preset", "duty_pct", "rpm", "settled",
    # Twin additions
    "sim_rpm", "sim_current_mA", "sim_ax_std",
    "ctrl_temp_C",   # temperature the controller acted on (simulated in --sim-temp)
    "ctrl_mode", "ctrl_target", "ctrl_action",
    "anomaly",
]


class DataLogger:
    def __init__(self, log_dir: str = LOG_DIR):
        os.makedirs(log_dir, exist_ok=True)
        self._stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self._path = os.path.join(log_dir, f"session_{self._stamp}.csv")
        self._file = open(self._path, "w", newline="", encoding="utf-8")
        self._writer = csv.DictWriter(self._file, fieldnames=COLUMNS, extrasaction="ignore")
        self._writer.writeheader()
        self._file.flush()
        self._count = 0
        self._lock = threading.Lock()

    def log(self, row: dict):
        enriched = dict(row)
        enriched["timestamp"] = datetime.now().isoformat(timespec="milliseconds")
        with self._lock:
            if self._file.closed:
                return
            self._writer.writerow(enriched)
            self._count += 1
            if self._count % 10 == 0:
                self._file.flush()

    @property
    def path(self) -> str:
        return self._path

    @property
    def stamp(self) -> str:
        return self._stamp

    @property
    def count(self) -> int:
        return self._count

    def close(self):
        with self._lock:
            if not self._file.closed:
                self._file.flush()
                self._file.close()
