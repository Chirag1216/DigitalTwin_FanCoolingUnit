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
| `service/` | Python logger, simulated model, anomaly detection | Phase 3 (planned) |
| `web/` | Three.js 3D digital twin dashboard | Phase 4 (planned) |
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
