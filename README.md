# DigitalTwin_FanCoolongUnit
Digital Twin for a PWM controlled Arctic fan attached to a box to simulate a cooling cabinet unit.

An ESP32 drives an **Arctic P12 Pro** 120 mm PWM fan inside an enclosure and measures RPM (tach),
vibration (MPU6050), temperature (DS18B20) and power (INA219). Data and commands flow over MQTT
between the physical unit, a Python twin service and a web 3D dashboard.

```
ESP32 (firmware/) ──MQTT 1883──► Mosquitto (broker/) ◄──WebSocket 9001── Browser 3D twin (web/)
                                      ▲
                                      └── Python twin service (service/): logger · sim model · anomalies
```

## Repository layout

| Folder | What | Status |
|---|---|---|
| `firmware/fan_rpm/` | ESP32 Arduino sketch: PWM presets, tach RPM, IMU vibration stats, DS18B20, INA219, MQTT link | Phase 1 ✅ |
| `broker/` | Mosquitto config with auth, topic ACL, WebSockets, persistence + a WebSocket test page | Phase 2 ✅ |
| `service/` | Python logger, simulated model, closed-loop thermal control, anomaly detection, Rich TUI | Phase 3 ✅ |
| `web/` | Three.js 3D digital twin dashboard | ✅  |
| `3d-model/` | Blender glTF models of the fan and full assembly (`Fan_Rotor` is a separate mesh) | ✅ |

## Hardware / pins (ESP32 DevKitC)

| Signal | GPIO | Notes |
|---|---|---|
| Fan PWM (blue) | 26 | 25 kHz |
| Fan TACH (green) | 25 | 10 kΩ pull-up to 3.3 V, 10 kΩ series + 10 nF to GND (RC filter) |
| I2C SDA / SCL | 21 / 22 | MPU6050 (0x68), INA219 (0x40) |
| DS18B20 data | 4 | 4.7 kΩ pull-up to 3.3 V |

Fan presets (validated operating points): `OFF 0% · LOW 30% · MEDIUM 50% · HIGH 70% · MAX 90%`
→ measured ≈ `0 · 1140 · 1680 · 2220 · 2760 RPM`.

## MQTT topics (`fantwin/fan01/…`)

| Topic | Direction | Payload |
|---|---|---|
| `telemetry` | ESP32 → | JSON every 500 ms (same fields as the serial CSV) |
| `status` | ESP32 → (retained, LWT) | `{"online":true,"preset":2,"name":"MEDIUM","duty":50}` / `{"online":false}` |
| `cmd` | → ESP32 | `{"preset":N}` or `N`, N = 0..4 (anything else is rejected) |
| `event` | ESP32 → | info / rejected-command messages |
| `sim`, `alert` | service → | Phase 3 |

## Quick start

1. **Broker** (PC, needs `mosquitto`):
   ```bash
   cd broker
   ./setup_users.sh      # creates users fan01 / twin / web
   ./start_broker.sh     # prints the PC IP for the ESP32
   ```
2. **Firmware**: copy `firmware/fan_rpm/secrets.example.h` → `secrets.h`, fill WiFi (2.4 GHz),
   broker IP and the `fan01` password. Install **PubSubClient**, **Adafruit INA219**,
   **OneWire**, **DallasTemperature**; board *ESP32 Dev Module*; upload `fan_rpm.ino`.
   Serial monitor 115200: `p 0`…`p 4` changes preset.
3. **Test**: open `broker/ws_test.html` in a browser, enter the PC IP + `web` password → live RPM and preset buttons.
   **Live monitor:** open `web/monitor.html` in a browser (needs internet for the MQTT library),
   enter the broker PC (`localhost` on the same PC) and the `web` password. Every telemetry field
   is shown with its name and unit, plus 2-minute charts, fan buttons, and twin data/alerts.
4. **Twin Service** (Phase 3):
   ```bash
   cd service
   python3 -m venv .venv && source .venv/bin/activate
   pip install -r requirements.txt

   # The twin password can be given with --password, via $FANTWIN_TWIN_PASS, or typed at the prompt.
   export FANTWIN_TWIN_PASS='<twin_password>'

   # (Recommended) One-time thermal profiling (~10 min) -> thermal_profile.json:
   python main.py --calibrate            # shorten with --cal-settle 30 --cal-sample 30

   # Live twin: closed-loop fan control + Rich TUI
   python main.py                        # add --manual to start without auto control

   # DEMO mode: simulated heating/cooling ramp drives the real fan
   python main.py --sim-temp             # tune with --sim-temp-rate / -start / -max

   # Tests
   python -m unittest test_suite -v
   ```
   Keys: `m` toggle AUTO/MANUAL · `0`–`4` set preset (MANUAL) · `q` quit.
   Each run writes `service/logs/session_<time>.csv` (telemetry + model + controller decisions;
   `ds_temp_C` is always the real sensor, `ctrl_temp_C` what the controller used) and a matching `.log`.
   Twin publishes `fantwin/fan01/sim` (model + controller state) and `fantwin/fan01/alert` (anomalies).

## Run the 3D Dashboard

Browsers cannot load `.glb` models over `file://`, so serve the repository root over HTTP:

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000/web/dashboard.html`, open **Broker Connect**, and connect to `ws://<broker-pc>:9001` (`localhost` when running on the broker PC) with user `web` and the password created by `broker/setup_users.sh`. All required libraries (`mqtt@5.3.4` and `three@0.170.0`) are bundled locally under `web/vendor/` so the dashboard works offline during hotspot or air-gapped demos.
