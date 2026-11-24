"""Twin service configuration — constants and defaults."""

import os

# Paths are anchored to this folder so the service behaves the same no matter
# which directory it is launched from (and stays inside the .gitignore entries).
SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))

# MQTT Broker Configuration
BROKER_HOST = "localhost"
BROKER_PORT = 1883
MQTT_USER = "twin"
MQTT_PASS_ENV = "FANTWIN_TWIN_PASS"  # password may come from this env var
CLIENT_ID_PREFIX = "fantwin-twin"    # a per-process suffix is appended

# Topic Configuration
DEVICE_ID = "fan01"
TOPIC_BASE = f"fantwin/{DEVICE_ID}"
TOPIC_TELEMETRY = f"{TOPIC_BASE}/telemetry"
TOPIC_STATUS = f"{TOPIC_BASE}/status"
TOPIC_CMD = f"{TOPIC_BASE}/cmd"
TOPIC_EVENT = f"{TOPIC_BASE}/event"
TOPIC_SIM = f"{TOPIC_BASE}/sim"
TOPIC_ALERT = f"{TOPIC_BASE}/alert"

# Preset definitions (must match firmware/fan_rpm/config.h)
PRESETS = [
    {"name": "OFF", "duty": 0, "expected_rpm": 0},
    {"name": "LOW", "duty": 30, "expected_rpm": 1140},
    {"name": "MEDIUM", "duty": 50, "expected_rpm": 1680},
    {"name": "HIGH", "duty": 70, "expected_rpm": 2220},
    {"name": "MAX", "duty": 90, "expected_rpm": 2760},
]

# Thermal controller
# Relative thresholds: step i (preset i -> i+1) at ambient + (i+1) * margin
TEMP_MARGIN_PER_STEP = 2.0  # °C per preset step above ambient
# Step UP when temp >= threshold; step DOWN only when temp < threshold - hysteresis
TEMP_HYSTERESIS = 1.0
CMD_MIN_INTERVAL_S = 4.0    # min seconds between automatic commands

# Fallback absolute thresholds (used when no thermal_profile.json exists)
# Below 28 -> OFF, 28-32 -> LOW, 32-36 -> MED, 36-40 -> HIGH, >=40 -> MAX
TEMP_THRESHOLDS_ABSOLUTE = [28.0, 32.0, 36.0, 40.0]

# DS18B20 glitch filter: values outside this range, or jumps bigger than
# TEMP_MAX_JUMP, are ignored unless they persist for TEMP_JUMP_CONFIRM_S
TEMP_VALID_RANGE = (-10.0, 70.0)
TEMP_MAX_JUMP = 5.0
TEMP_JUMP_CONFIRM_S = 10.0

# Calibration timing
CALIBRATE_SETTLE_SECS = 60  # seconds to wait for temperature to settle
CALIBRATE_SAMPLE_SECS = 60  # seconds to average temperature after settling
THERMAL_PROFILE_PATH = os.path.join(SERVICE_DIR, "thermal_profile.json")

# Anomaly detection thresholds
RPM_TOLERANCE_PCT = 15.0    # ±15% of expected RPM
# ax_std alert limit (m/s²) per preset. Measured settled values on this rig
# (2026-11-25): max 0.08 / 0.14 / 0.48 / 0.53 / 1.00 for OFF..MAX.
# Re-measure if the fan or MPU6050 is remounted.
VIBRATION_LIMITS = [0.25, 0.30, 0.75, 0.85, 1.50]
# While the fan is changing speed only the highest limit applies
STALL_RPM_THRESHOLD = 50.0  # RPM below this when duty > 0 -> stall alert
ALERT_COOLDOWN_S = 8.0      # min seconds between alerts of the same type

# Settling time (matches firmware SETTLE_MS = 12000)
SETTLE_MS = 12000

# Telemetry older than this is shown as stale in the TUI
TELEMETRY_STALE_S = 3.0

# Logging
LOG_DIR = os.path.join(SERVICE_DIR, "logs")
