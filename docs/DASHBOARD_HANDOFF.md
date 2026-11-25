# Handoff: build the 3D web dashboard (Phase 4)

You are joining a working project. Read this whole file before writing code. Where this file and
the code disagree, the code wins; tell the user.

## 1. Your task

Build a browser dashboard in `web/` that shows a **live 3D digital twin** of a fan cooling unit:
the 3D model's fan spins like the real one, live sensor data is shown clearly, and the fan can be
controlled. It will be shown in a live demo to a teacher, so it must be readable and reliable.

## 2. What already works (do not rebuild)

| Part | Folder | Notes |
|---|---|---|
| ESP32 firmware | `firmware/fan_rpm/` | PWM presets, tach RPM, MPU6050, DS18B20, MQTT |
| Mosquitto broker | `broker/` | auth + ACL; MQTT 1883, WebSockets 9001 |
| Python twin service | `service/` | CSV log, model, auto temperature control, anomaly alerts, terminal UI |
| Plain web monitor | `web/monitor.html` | **working reference** for MQTT code, field names and labels |
| 3D models | `3d-model/` | Blender glTF exports |

```
ESP32 ──MQTT 1883──► Mosquitto ◄──WebSocket 9001── your dashboard
                         ▲
                         └── Python twin (publishes sim + alert, sends cmd)
```

## 3. Do not change

`firmware/`, `broker/`, `service/`, and `web/monitor.html`. Add new files under `web/`
(for example `web/dashboard.html`, `web/js/…`). If you think one of those needs a change,
explain why and ask first. Never commit `firmware/fan_rpm/secrets.h` or `broker/passwd`, and
never hard-code a password in web files.

## 4. Connecting

- URL: `ws://<broker-pc>:9001` (`localhost` when the browser is on the broker PC)
- User: `web`. The password is typed by the person in the page. Do not store it in code.
- ACL for `web`: **read** `fantwin/#`, **write** only `fantwin/+/cmd`
- Library used by the monitor: `mqtt@5.3.4` from unpkg
- Subscribe to `fantwin/fan01/#`

## 5. Topics (device id `fan01`, prefix `fantwin/fan01/`)

### `telemetry` (ESP32, every 500 ms, not retained) — real sample at MEDIUM

```json
{"t_ms":144540,"n":250,"ax_mean":-0.01,"ay_mean":0.006,"az_mean":9.815,
 "ax_std":0.4545,"ay_std":0.1145,"az_std":0.3146,"ax_p2p":1.4988,"ay_p2p":0.5076,"az_p2p":1.5538,
 "gx_mean":0.0001,"gy_mean":0.001,"gz_mean":0.0002,"gx_std":0.0056,"gy_std":0.0185,"gz_std":0.0028,
 "temp_C":29.01,"shunt_mV":null,"bus_V":null,"load_V":null,"current_mA":null,
 "ina_age_ms":144540,"ina_fresh":0,"ds_temp_C":28.06,"ds_age_ms":304,
 "preset":2,"duty_pct":50,"rpm":1680,"settled":1}
```

| Field | Meaning | Unit |
|---|---|---|
| `t_ms`, `n` | ESP32 uptime; motion samples in this window (about 250) | ms, count |
| `ax/ay/az_mean`, `_std`, `_p2p` | acceleration average, shake (std dev), peak-to-peak; Z includes gravity | m/s² |
| `gx/gy/gz_mean`, `_std` | rotation rate of the board | rad/s |
| `temp_C` | MPU6050 chip temperature (not the room) | °C |
| `ds_temp_C`, `ds_age_ms` | **enclosure temperature** (DS18B20), updates every 2 s | °C, ms |
| `preset`, `duty_pct` | 0–4; PWM duty | , % |
| `rpm` | tachometer speed, resolution 60 | RPM |
| `settled` | 1 once 12 s have passed since the last preset change | 0/1 |
| `shunt_mV`, `bus_V`, `load_V`, `current_mA`, `ina_*` | INA219 power sensor, **currently not connected** | |

Any numeric sensor field can be `null`.

### `status` (ESP32, retained, also the Last Will)
`{"online":true,"preset":2,"name":"MEDIUM","duty":50}` or `{"online":false}`

### `cmd` (you publish, QoS 1)
`{"preset":N}` with N = 0..4. Anything else is rejected and reported on `event`.

### `event` (ESP32)
`{"msg":"connected"}`

### `sim` (Python twin, only while it runs, every telemetry message)
```json
{"sim_rpm":1680,"sim_current_mA":120.0,"sim_ax_std":0.455,"t_ms":144540,"preset":2,
 "ctrl_temp_C":28.06,"ctrl_mode":"manual","ctrl_target":0,"ctrl_action":"manual","sim_temp":false}
```
- `ctrl_mode`: `auto` or `manual`
- `ctrl_action`: `hold`, `changed`, `settling`, `rate_limited`, `manual`, `skip`
- `sim_temp: true` means demo mode: `ctrl_temp_C` is simulated and differs from `ds_temp_C`.
  Label it clearly.
- `sim_current_mA` is an unverified estimate. Don't present it as measured.

### `alert` (Python twin)
```json
{"type":"high_vibration","severity":"warning","msg":"Vibration ax_std=0.900 m/s² > 0.25 m/s²",
 "time":1795550000.1,"data":{"ax_std":0.9,"limit":0.25}}
```
Types: `fan_stall` (critical), `rpm_deviation` (warning), `high_vibration` (warning),
`sensor_offline` (info), `twin_offline` (info, the twin's Last Will, no `time`).
`time` is Unix seconds.

## 6. Measured behaviour of the real rig

| Preset | Name | Duty | RPM | `ax_std` typical | Vibration alert limit |
|---|---|---|---|---|---|
| 0 | OFF | 0 % | 0 | 0.03 | 0.25 |
| 1 | LOW | 30 % | 1140 | 0.13 | 0.30 |
| 2 | MEDIUM | 50 % | 1680 | 0.46 | 0.75 |
| 3 | HIGH | 70 % | 2220 | 0.52 | 0.85 |
| 4 | MAX | 90 % | 2760–2820 | 0.97 | 1.50 |

While `settled` is 0, only the 1.50 limit applies. Source of truth: `service/config.py`.

Things that will look like bugs but are real:
- **Switching to OFF: `rpm` reads 0 within about 0.5 s while the fan is still coasting.**
  Vibration shows the fan takes about 7 s to stop. Animate a coast-down yourself.
- **Spin-up transients:** LOW from OFF overshoots to about 1560 before settling at 1140.
  Going HIGH → MAX showed one false spike of 4980. Clamp the animation to 0–3000 and smooth it.
- Normal room temperature is about 28 °C and does not change with fan speed, because nothing in
  the box produces heat.

## 7. Automatic control (in the Python twin)

Calibrated room temperature is 28.03 °C. Fan goes LOW/MEDIUM/HIGH/MAX at about
30 / 32 / 34 / 36 °C and steps down 1 °C below the level. These come from
`service/thermal_profile.json` (not in git) and are **not published over MQTT**.

AUTO/MANUAL can only be toggled with the `m` key in the twin's terminal; there is no MQTT command
for it. In AUTO the twin overrides buttons pressed in the browser, so warn the user in the UI
when `ctrl_mode` is `auto`.

## 8. 3D models

All are glTF binary, units in metres, Y up, with one animation `Fan_Spin`.

| File | Size | Use |
|---|---|---|
| `assembly_detailed_transparent.glb` | 5.3 MB | recommended: see-through box (`Box_Translucent`) |
| `assembly_detailed.glb` | 5.3 MB | opaque box |
| `assembly_simplified.glb` | 4.5 MB | lighter, fewer nodes |
| `fan_120mm_P12.glb` | 1.0 MB | fan only |

Node names in the detailed assemblies:

- `Fan_120mm` → `Fan_Frame`, **`Fan_Rotor`**, `Fan_PWM_Cable`
- `Electronics` → `ESP32_DevKitC`, `Sensor_Temperature_DS18B20`, `Sensor_Vibration_MPU6050`,
  `Sensor_Current_INA219`, `DS18B20_Pullup_Perfboard`, `Breadboard_A`, `Breadboard_B`
- `Enclosure_Box` → `Box_Walls`, `Box_Lid_Flap`, `Fan_Mount_Screws`
- `Wiring` → cable meshes by colour

The simplified model uses slightly different names (`ESP32`, `Breadboard`); check before relying
on them. `Sensor_Current_INA219` is in the model but not in the real rig: grey it out or label it.

**Spinning the rotor:** it turns about its **local −Y axis**. `Fan_Spin` is exactly one revolution
in 1 s, so `action.timeScale = revolutionsPerSecond` works, or rotate it yourself:
`rotor.rotateY(-2 * Math.PI * rpm / 60 * dt)`. At 60 fps, real speeds (up to 46 rev/s) look
frozen or backwards, so scale the visual speed down (for example `rpm / 60 / 20`), keep it
proportional, and show the true RPM as text.

## 9. Requirements

Must have
1. 3D model with orbit/zoom; rotor speed follows live RPM, with smooth spin-up and coast-down.
2. Large readouts: RPM, enclosure temperature, vibration, preset/duty.
3. Connection states that differ visibly: broker disconnected, ESP32 offline (`status`),
   no telemetry for more than 3 s (grey out values), live.
4. Preset buttons OFF–MAX, highlighting the preset **reported by telemetry**, not the one clicked.
5. Twin panel: mode, action, target, expected vs measured RPM, demo-mode label.
6. Alerts list with severity shown by icon and text, not colour alone.
7. `null` shown as "—"; never crash on a missing field or when the twin is not running.

Nice to have
- Short history charts (about 2 minutes) of RPM, temperature, vibration.
- Click a part in 3D to see its readings; labels on the sensors.
- Visual cues: temperature tint on the DS18B20, vibration highlight on the MPU6050 or fan.
- Camera preset buttons for the demo.

Constraints
- Plain HTML + ES modules, no build step. Pin library versions (Three.js via an import map).
- A `.glb` cannot be loaded from `file://`. Serve the repo root:
  `python3 -m http.server 8000` → `http://localhost:8000/web/dashboard.html`
- The demo laptop may be on a phone hotspot. Prefer saving libraries into `web/vendor/` so the
  page works without internet.
- Do not insert MQTT text with `innerHTML`.

## 10. Testing without the hardware

Run a throwaway broker on spare ports (it does not touch the real one):

```bash
printf 'listener 18831 127.0.0.1\nallow_anonymous true\nlistener 19001 127.0.0.1\nprotocol websockets\n' > /tmp/test-mosquitto.conf
mosquitto -c /tmp/test-mosquitto.conf
```

In another terminal, with `service/.venv` active, save as `fake_feed.py` and run it. Connect the
dashboard to `localhost:19001` with no username.

```python
import json, random, time
import paho.mqtt.client as paho

RPM, DUTY = [0, 1140, 1680, 2220, 2760], [0, 30, 50, 70, 90]
state = {"p": 0, "t": time.time()}

def on_message(c, u, m):
    state.update(p=json.loads(m.payload)["preset"], t=time.time())

c = paho.Client(paho.CallbackAPIVersion.VERSION2)
c.on_message = on_message
c.connect("127.0.0.1", 18831)
c.subscribe("fantwin/fan01/cmd")
c.loop_start()
c.publish("fantwin/fan01/status", json.dumps({"online": True, "preset": 0, "name": "OFF", "duty": 0}), retain=True)
rpm, start = 0.0, time.time()
while True:
    p = state["p"]
    rpm = 0 if p == 0 else rpm + (RPM[p] - rpm) * 0.35
    c.publish("fantwin/fan01/telemetry", json.dumps({
        "t_ms": int((time.time() - start) * 1000), "n": 250,
        "ax_std": round([0.03, 0.13, 0.46, 0.52, 0.97][p] + random.random() * 0.02, 4),
        "temp_C": 29.0, "ds_temp_C": 28.1, "current_mA": None, "bus_V": None,
        "preset": p, "duty_pct": DUTY[p], "rpm": round(rpm / 60) * 60,
        "settled": int(time.time() - state["t"] >= 12)}))
    time.sleep(0.5)
```

The real Python twin can join the same test broker to produce `sim` and `alert`:
`python main.py --port 18831 --user "" --password x`

## 11. Done means

- [ ] Works against the fake feed and against the real rig
- [ ] No console errors; usable on a laptop screen (and not broken at phone width)
- [ ] Pulling ESP32 power shows "offline"; restarting the broker reconnects by itself
- [ ] Every item under "Must have" demonstrated
- [ ] `README.md` gains a short "run the dashboard" section
- [ ] You tell the user what you tested and what you could not
