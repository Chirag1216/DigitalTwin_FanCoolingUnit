"""Fan digital twin service — main entry point.

Usage (from anywhere; paths are relative to this folder):
    # one-time thermal calibration (~10 min)
    python main.py --calibrate --password <twin_pass>

    # normal operation (closed-loop control + live TUI)
    python main.py --password <twin_pass>

    # demo: simulated heating/cooling drives the real fan
    python main.py --password <twin_pass> --sim-temp

The password can also come from $FANTWIN_TWIN_PASS, or is prompted for.

Keys while running:  m = toggle AUTO/MANUAL   0-4 = set preset (MANUAL)   q = quit
"""

import argparse
import getpass
import logging
import os
import select
import signal
import sys
import threading
import time

from config import (
    BROKER_HOST, BROKER_PORT, MQTT_USER, MQTT_PASS_ENV, LOG_DIR,
    CALIBRATE_SETTLE_SECS, CALIBRATE_SAMPLE_SECS, TEMP_MARGIN_PER_STEP, THERMAL_PROFILE_PATH,
)
from mqtt_client import MqttClient
from data_logger import DataLogger
from thermal_controller import ThermalController, TempFilter
from sim_model import SimModel, SimTemperature
from anomaly_detector import AnomalyDetector
from calibrate import ThermalCalibrator, CalibrationError

try:
    from rich.live import Live
    from twin_tui import TwinTUI
    HAS_RICH = True
except ImportError:
    HAS_RICH = False

log = logging.getLogger("twin")


def parse_args():
    p = argparse.ArgumentParser(description="Arctic Fan Digital Twin Service (Phase 3)")
    p.add_argument("--host", default=BROKER_HOST, help=f"MQTT broker host (default: {BROKER_HOST})")
    p.add_argument("--port", type=int, default=BROKER_PORT)
    p.add_argument("--user", default=MQTT_USER, help=f"MQTT username (default: {MQTT_USER})")
    p.add_argument("--password", default=None,
                   help=f"MQTT password (else ${MQTT_PASS_ENV}, else prompted)")
    p.add_argument("--manual", action="store_true", help="Start in MANUAL mode")
    p.add_argument("--calibrate", action="store_true", help="Run one-time thermal calibration")
    p.add_argument("--cal-settle", type=int, default=CALIBRATE_SETTLE_SECS,
                   help=f"Calibration settle seconds per preset (default {CALIBRATE_SETTLE_SECS})")
    p.add_argument("--cal-sample", type=int, default=CALIBRATE_SAMPLE_SECS,
                   help=f"Calibration sample seconds per preset (default {CALIBRATE_SAMPLE_SECS})")
    p.add_argument("--profile", default=THERMAL_PROFILE_PATH, help="Thermal profile JSON path")
    p.add_argument("--sim-temp", action="store_true",
                   help="DEMO: drive the controller with a simulated temperature ramp")
    p.add_argument("--sim-temp-start", type=float, default=None,
                   help="Ramp low point °C (default: first threshold - 3)")
    p.add_argument("--sim-temp-max", type=float, default=None,
                   help="Ramp peak °C (default: last threshold + 3)")
    p.add_argument("--sim-temp-rate", type=float, default=0.15,
                   help="Heating rate °C/s; cooling is half (default 0.15)")
    p.add_argument("--temp-margin", type=float, default=TEMP_MARGIN_PER_STEP,
                   help=f"°C per preset step above ambient (default {TEMP_MARGIN_PER_STEP})")
    p.add_argument("--no-tui", action="store_true", help="Plain log output instead of the TUI")
    return p.parse_args()


def resolve_password(args) -> str:
    if args.password is not None:
        return args.password
    env = os.environ.get(MQTT_PASS_ENV)
    if env:
        return env
    if sys.stdin.isatty():
        return getpass.getpass(f"MQTT password for '{args.user}': ")
    sys.exit(f"[ERROR] No MQTT password: pass --password or set ${MQTT_PASS_ENV}")


def connect_or_exit(mqtt: MqttClient, timeout: float = 5.0):
    print(f"Connecting to mqtt://{mqtt.host}:{mqtt.port} ...")
    mqtt.connect()
    mqtt.loop_start()
    ok = mqtt.wait_connected(timeout)
    if mqtt.fatal_error:
        mqtt.loop_stop()
        sys.exit(f"[ERROR] Broker refused login: {mqtt.fatal_error}. "
                 "Check --user/--password (users are created by broker/setup_users.sh).")
    if not ok:
        print(f"[WARN] Broker {mqtt.host}:{mqtt.port} not reachable yet — will keep retrying. "
              "Is it running? (cd broker && ./start_broker.sh)")
    return ok


class KeyReader(threading.Thread):
    """Reads single keypresses from the terminal (Linux/macOS) without Enter."""

    def __init__(self, on_key, stop: threading.Event):
        super().__init__(daemon=True)
        self._on_key, self._stop = on_key, stop

    def run(self):
        if not sys.stdin.isatty():
            return
        import termios
        import tty
        fd = sys.stdin.fileno()
        old = termios.tcgetattr(fd)
        try:
            tty.setcbreak(fd)  # keeps Ctrl+C working
            while not self._stop.is_set():
                if select.select([fd], [], [], 0.2)[0]:
                    ch = os.read(fd, 1).decode(errors="ignore")
                    if ch:
                        self._on_key(ch)
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)


class TuiLogHandler(logging.Handler):
    def __init__(self, tui):
        super().__init__(logging.INFO)
        self._tui = tui

    def emit(self, record):
        if record.name == "mqtt" and record.getMessage().startswith("ALERT"):
            return  # already shown in the anomaly panel
        color = {logging.WARNING: "yellow", logging.ERROR: "red"}.get(record.levelno, "white")
        self._tui.event(f"[{color}]{record.getMessage()}[/]")


def run_calibration(args, password):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    mqtt = MqttClient(args.host, args.port, args.user, password)
    calibrator = ThermalCalibrator(mqtt, profile_path=args.profile)
    mqtt.on("telemetry", calibrator.on_telemetry)
    if not connect_or_exit(mqtt):
        mqtt.loop_stop()
        sys.exit(1)
    print("NOTE: stop any running twin service first, or it will fight the calibration.\n")
    try:
        calibrator.run(settle_secs=args.cal_settle, sample_secs=args.cal_sample)
    except CalibrationError as e:
        print(f"\n[ERROR] Calibration failed: {e}\n        Profile NOT written; fan set back to OFF.")
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nCalibration aborted — profile NOT written; fan set back to OFF.")
    finally:
        time.sleep(0.3)  # let the final OFF command go out
        mqtt.loop_stop()


def main():
    args = parse_args()
    password = resolve_password(args)

    if args.calibrate:
        run_calibration(args, password)
        return

    use_tui = HAS_RICH and not args.no_tui and sys.stdout.isatty()
    mqtt = MqttClient(args.host, args.port, args.user, password)
    controller = ThermalController(mqtt, profile_path=args.profile, margin=args.temp_margin)
    model = SimModel()
    temp_filter = TempFilter()
    anomaly = AnomalyDetector(mqtt)
    if args.manual:
        controller.set_mode("manual")

    sim_temp = None
    if args.sim_temp:
        th = controller.thresholds
        low = args.sim_temp_start if args.sim_temp_start is not None else round(th[0] - 3, 1)
        high = args.sim_temp_max if args.sim_temp_max is not None else round(th[-1] + 3, 1)
        if high <= low:
            sys.exit(f"[ERROR] --sim-temp-max ({high}) must be above --sim-temp-start ({low})")
        sim_temp = SimTemperature(low, high, args.sim_temp_rate)

    src = (f"profile (ambient {controller.ambient:.2f}°C)" if controller.ambient is not None
           else "default absolute (no thermal_profile.json — run --calibrate)")
    print(f"Thresholds {controller.thresholds} from {src}, margin {args.temp_margin}°C")
    if sim_temp:
        print(f"SIM-TEMP demo: {sim_temp.low}°C <-> {sim_temp.high}°C at {sim_temp.rate}°C/s")
    connect_or_exit(mqtt)

    # only start a session log once the login worked (no more empty CSVs)
    data_log = DataLogger()

    # Log to a file always; to the console only without the TUI (it would garble the screen)
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    fh = logging.FileHandler(os.path.join(LOG_DIR, f"session_{data_log.stamp}.log"), encoding="utf-8")
    fh.setFormatter(fmt)
    root.addHandler(fh)
    if not use_tui:
        sh = logging.StreamHandler()
        sh.setFormatter(fmt)
        root.addHandler(sh)

    tui = None
    if use_tui:
        tui = TwinTUI(f"{args.host}:{args.port}", sim_temp=bool(sim_temp),
                      thresholds=controller.thresholds, threshold_source=controller.source)
        tui.update(mode=controller.mode)
        root.addHandler(TuiLogHandler(tui))

    # ---------------- MQTT handlers (run on the paho thread) ----------------
    def on_telemetry(payload: dict):
        ctrl_temp = sim_temp.step() if sim_temp else temp_filter.update(payload.get("ds_temp_C"))
        sim = model.predict(payload)
        alerts = anomaly.check(payload, sim)
        decision = controller.evaluate(payload, temp=ctrl_temp)

        row = dict(payload)
        row.update(sim)
        row.update({
            "ctrl_temp_C": ctrl_temp, "ctrl_mode": decision["mode"],
            "ctrl_target": decision.get("target_preset"), "ctrl_action": decision["action"],
            "anomaly": "|".join(a["type"] for a in alerts),
        })
        data_log.log(row)

        mqtt.publish_sim({
            **sim, "t_ms": payload.get("t_ms"), "preset": payload.get("preset"),
            "ctrl_temp_C": ctrl_temp, "ctrl_mode": decision["mode"],
            "ctrl_target": decision.get("target_preset"), "ctrl_action": decision["action"],
            "sim_temp": bool(sim_temp),
        })

        if tui:
            tui.update(telemetry=payload, sim=sim, decision=decision,
                       alerts=anomaly.recent_alerts, broker_ok=True, device_online=True)
        elif data_log.count % 10 == 1:  # plain mode: one summary line every ~5 s
            log.info(f"P{payload.get('preset')} rpm={payload.get('rpm')} sim={sim['sim_rpm']} "
                     f"T={ctrl_temp}°C -> {decision['action']} P{decision.get('target_preset')}")

    def on_status(payload: dict):
        online = bool(payload.get("online", False))
        if tui:
            tui.update(device_online=online)
        log.info(f"ESP32 {'ONLINE' if online else 'OFFLINE'} {payload}")

    def on_event(payload: dict):
        log.info(f"ESP32 event: {payload.get('msg', payload)}")

    mqtt.on("telemetry", on_telemetry)
    mqtt.on("status", on_status)
    mqtt.on("event", on_event)

    # ---------------- keyboard ----------------
    stop = threading.Event()

    def on_key(ch: str):
        ch = ch.lower()
        if ch == "q":
            stop.set()
        elif ch == "m":
            controller.toggle_mode()
            if tui:
                tui.update(mode=controller.mode)
        elif ch in "01234":
            if controller.mode != "manual":
                log.warning("Preset keys work in MANUAL mode — press m first")
            else:
                mqtt.publish_cmd(int(ch))

    # ---------------- run ----------------

    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    keys = KeyReader(on_key, stop)
    keys.start()

    try:
        if tui:
            with Live(tui.render(), refresh_per_second=4, screen=True) as live:
                while not stop.is_set() and not mqtt.fatal_error:
                    tui.update(broker_ok=mqtt.connected)
                    live.update(tui.render())
                    stop.wait(0.25)
        else:
            print("Running — m: toggle mode, 0-4: preset (manual), q / Ctrl+C: quit")
            while not stop.is_set() and not mqtt.fatal_error:
                stop.wait(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        keys.join(timeout=1)
        mqtt.loop_stop()
        data_log.close()
        if mqtt.fatal_error:
            print(f"[ERROR] Broker refused login: {mqtt.fatal_error}")
        print(f"\nLogged {data_log.count} rows to {data_log.path}")


if __name__ == "__main__":
    main()
