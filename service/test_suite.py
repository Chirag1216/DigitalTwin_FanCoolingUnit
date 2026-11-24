"""Unit tests for the twin service. Run: python -m unittest test_suite -v"""

import json
import os
import tempfile
import logging
import unittest
from unittest import mock

logging.disable(logging.WARNING)

from anomaly_detector import AnomalyDetector
from calibrate import ThermalCalibrator, CalibrationError
from data_logger import DataLogger
from sim_model import SimModel, SimTemperature
from thermal_controller import ThermalController, TempFilter
from twin_tui import TwinTUI


class MockMqtt:
    def __init__(self):
        self.cmds, self.alerts, self.sims = [], [], []

    def publish_cmd(self, preset):
        self.cmds.append(preset)

    def publish_alert(self, alert):
        self.alerts.append(alert)

    def publish_sim(self, data):
        self.sims.append(data)


def make_profile(ambient):
    f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump({"ambient_C": ambient, "profiles": {}}, f)
    f.close()
    return f.name


class TestSimModel(unittest.TestCase):
    def test_settled_operating_points(self):
        m = SimModel()
        for preset, rpm in [(0, 0), (2, 1680), (4, 2760)]:
            self.assertEqual(m.predict({"preset": preset, "t_ms": 1000, "settled": 1})["sim_rpm"], rpm)

    def test_transient_ramps_between_presets(self):
        # regression: Gemini version jumped straight to the new RPM
        m = SimModel()
        m.predict({"preset": 1, "t_ms": 0, "settled": 1})
        first = m.predict({"preset": 3, "t_ms": 500, "settled": 0})["sim_rpm"]
        later = m.predict({"preset": 3, "t_ms": 6000, "settled": 0})["sim_rpm"]
        self.assertEqual(first, 1140)            # change just happened
        self.assertTrue(1140 < later < 2220)     # mid-transient
        self.assertEqual(m.predict({"preset": 3, "t_ms": 12500, "settled": 1})["sim_rpm"], 2220)

    def test_bad_preset_is_safe(self):
        self.assertEqual(SimModel().predict({"preset": None, "settled": 1})["sim_rpm"], 0)


class TestThermalController(unittest.TestCase):
    def test_fallback_thresholds(self):
        mq = MockMqtt()
        tc = ThermalController(mq, profile_path="/nonexistent.json", min_cmd_interval=0)
        self.assertIsNone(tc.ambient)
        self.assertEqual(tc.thresholds, [28.0, 32.0, 36.0, 40.0])
        self.assertEqual(tc.evaluate({"ds_temp_C": 25.0, "preset": 0, "settled": 1})["action"], "hold")
        d = tc.evaluate({"ds_temp_C": 30.0, "preset": 0, "settled": 1})
        self.assertEqual((d["target_preset"], d["action"]), (1, "changed"))
        self.assertEqual(mq.cmds, [1])

    def test_profile_and_margin_arg(self):
        path = make_profile(30.0)
        try:
            self.assertEqual(ThermalController(MockMqtt(), path).thresholds, [32.0, 34.0, 36.0, 38.0])
            # regression: --temp-margin used to be ignored
            self.assertEqual(ThermalController(MockMqtt(), path, margin=1.5).thresholds,
                             [31.5, 33.0, 34.5, 36.0])
        finally:
            os.remove(path)

    def test_hysteresis(self):
        path = make_profile(30.0)  # thresholds 32/34/36/38, hysteresis 1
        try:
            tc = ThermalController(MockMqtt(), path)
            self.assertEqual(tc.compute_target(31.9, 0), 0)
            self.assertEqual(tc.compute_target(32.0, 0), 1)
            self.assertEqual(tc.compute_target(39.5, 0), 4)   # multi-step jump up
            self.assertEqual(tc.compute_target(33.5, 2), 2)   # inside band below 34 -> hold
            self.assertEqual(tc.compute_target(32.9, 2), 1)   # below 34-1 -> down
            self.assertEqual(tc.compute_target(30.0, 4), 0)   # multi-step drop
            self.assertEqual(tc.compute_target(35.0, None), 2)
        finally:
            os.remove(path)

    def test_waits_for_settle_rate_limit_and_manual(self):
        mq = MockMqtt()
        tc = ThermalController(mq, "/nonexistent.json", min_cmd_interval=60)
        self.assertEqual(tc.evaluate({"ds_temp_C": 30, "preset": 0, "settled": 0})["action"], "settling")
        self.assertEqual(tc.evaluate({"ds_temp_C": 30, "preset": 0, "settled": 1})["action"], "changed")
        self.assertEqual(tc.evaluate({"ds_temp_C": 30, "preset": 0, "settled": 1})["action"], "rate_limited")
        tc.set_mode("manual")
        self.assertEqual(tc.evaluate({"ds_temp_C": 45, "preset": 0, "settled": 1})["action"], "manual")
        self.assertEqual(mq.cmds, [1])

    def test_temp_override_and_missing_data(self):
        mq = MockMqtt()
        tc = ThermalController(mq, "/nonexistent.json", min_cmd_interval=0)
        d = tc.evaluate({"ds_temp_C": None, "preset": 0, "settled": 1}, temp=41.0)
        self.assertEqual(d["target_preset"], 4)
        self.assertEqual(tc.evaluate({"ds_temp_C": None, "preset": 0, "settled": 1})["action"], "skip")
        self.assertEqual(tc.evaluate({"ds_temp_C": 30, "preset": 9, "settled": 1})["action"], "skip")


class TestAnomalyDetector(unittest.TestCase):
    sim = {"sim_rpm": 1680, "sim_current_mA": 120.0}

    def types(self, telemetry, sim=None):
        ad = AnomalyDetector(MockMqtt(), cooldown=0)
        return {a["type"] for a in ad.check(telemetry, sim or self.sim)}

    def test_cases(self):
        base = {"preset": 2, "duty_pct": 50, "rpm": 1675, "ax_std": 0.02, "settled": 1, "ds_temp_C": 29.0}
        self.assertEqual(self.types(base), set())
        self.assertEqual(self.types({**base, "rpm": 0}), {"fan_stall"})
        self.assertEqual(self.types({**base, "rpm": 1300}), {"rpm_deviation"})
        self.assertEqual(self.types({**base, "rpm": 1300, "settled": 0}), set())
        self.assertEqual(self.types({**base, "ax_std": 0.85}), {"high_vibration"})
        self.assertEqual(self.types({**base, "ds_temp_C": None}), {"sensor_offline"})

    def test_vibration_limit_depends_on_preset(self):
        base = {"duty_pct": 90, "rpm": 2760, "ds_temp_C": 29.0, "ax_std": 1.0}
        sim = {"sim_rpm": 2760}
        self.assertEqual(self.types({**base, "preset": 4, "settled": 1}, sim), set())  # normal at MAX
        off = {"preset": 0, "duty_pct": 0, "rpm": 0, "ds_temp_C": 29.0, "ax_std": 0.4}
        self.assertEqual(self.types({**off, "settled": 1}, {"sim_rpm": 0}), {"high_vibration"})
        self.assertEqual(self.types({**off, "settled": 0}, {"sim_rpm": 500}), set())  # coasting down

    def test_null_fields_do_not_crash(self):
        # regression: firmware sends null for NaN; old code raised TypeError
        self.assertEqual(self.types({"preset": 2, "duty_pct": 50, "rpm": None, "ax_std": None,
                                     "settled": 1, "ds_temp_C": 29.0}), set())

    def test_cooldown(self):
        now = [100.0]
        mq = MockMqtt()
        ad = AnomalyDetector(mq, cooldown=8, clock=lambda: now[0])
        t = {"preset": 2, "duty_pct": 50, "rpm": 0, "settled": 1, "ds_temp_C": 29.0}
        self.assertEqual(len(ad.check(t, self.sim)), 1)
        now[0] += 1
        self.assertEqual(len(ad.check(t, self.sim)), 0)
        now[0] += 10
        self.assertEqual(len(ad.check(t, self.sim)), 1)
        self.assertEqual(len(mq.alerts), 2)


class TestTempFilter(unittest.TestCase):
    def test_rejects_glitches_accepts_persistent_change(self):
        now = [0.0]
        f = TempFilter(clock=lambda: now[0])
        self.assertEqual(f.update(28.0), 28.0)
        self.assertEqual(f.update(107.56), 28.0)  # out of range
        self.assertEqual(f.update(45.0), 28.0)    # sudden jump
        self.assertEqual(f.update(28.1), 28.1)
        self.assertEqual(f.update(40.0), 28.1)
        now[0] = 11.0
        self.assertEqual(f.update(40.0), 40.0)    # stayed, so it's real
        self.assertIsNone(f.update(None))


class TestSimTemperature(unittest.TestCase):
    def test_triangle_wave(self):
        now = [0.0]
        st = SimTemperature(30.0, 32.0, rate=1.0, clock=lambda: now[0])
        now[0] = 1.0
        self.assertEqual(st.step(), 31.0)
        now[0] = 3.0
        self.assertEqual(st.step(), 32.0)
        self.assertFalse(st.rising)
        now[0] = 5.0
        self.assertEqual(st.step(), 31.0)  # cools at half rate


class TestCalibrator(unittest.TestCase):
    def run_cal(self, temps_per_preset):
        mq = MockMqtt()
        path = tempfile.mktemp(suffix=".json")
        cal = None

        def fake_sleep(_secs):
            idx = mq.cmds[-1]
            for t in temps_per_preset[idx]:
                cal.on_telemetry({"preset": idx, "ds_temp_C": t})

        cal = ThermalCalibrator(mq, profile_path=path, sleep=fake_sleep)
        orig_publish = mq.publish_cmd

        def publish_and_echo(p):
            orig_publish(p)
            cal.on_telemetry({"preset": p, "ds_temp_C": None})

        mq.publish_cmd = publish_and_echo
        cal.on_telemetry({"preset": 0, "ds_temp_C": 30.0})
        return cal, mq, path

    def test_writes_profile_and_returns_to_off(self):
        temps = {0: [31.0, 31.2], 1: [30.5], 2: [30.0], 3: [29.5], 4: [29.0]}
        cal, mq, path = self.run_cal(temps)
        try:
            with mock.patch("builtins.print"):
                prof = cal.run(settle_secs=0, sample_secs=0)
            self.assertEqual(prof["ambient_C"], 31.1)
            self.assertEqual(mq.cmds, [0, 1, 2, 3, 4, 0])
            with open(path) as f:
                self.assertEqual(json.load(f)["profiles"]["4"]["temp_C"], 29.0)
        finally:
            if os.path.exists(path):
                os.remove(path)

    def test_no_sensor_data_aborts_without_profile(self):
        temps = {0: [], 1: [], 2: [], 3: [], 4: []}
        cal, mq, path = self.run_cal(temps)
        with mock.patch("builtins.print"), self.assertRaises(CalibrationError):
            cal.run(settle_secs=0, sample_secs=0)
        self.assertFalse(os.path.exists(path))
        self.assertEqual(mq.cmds[-1], 0)


class TestLoggerAndTUI(unittest.TestCase):
    def test_data_logger(self):
        with tempfile.TemporaryDirectory() as d:
            dl = DataLogger(log_dir=d)
            dl.log({"t_ms": 12000, "rpm": 1680, "preset": 2, "ds_temp_C": 28.5,
                    "sim_rpm": 1680, "ctrl_temp_C": 35.0, "anomaly": "", "unknown": 1})
            dl.close()
            with open(dl.path, encoding="utf-8") as f:
                lines = f.readlines()
            self.assertEqual(len(lines), 2)
            self.assertIn("ctrl_temp_C", lines[0])
            self.assertIn("1680", lines[1])

    def test_tui_render(self):
        from rich.console import Console
        devnull = open(os.devnull, "w")
        self.addCleanup(devnull.close)
        tui = TwinTUI(sim_temp=True, thresholds=[32, 34, 36, 38], threshold_source="profile")
        Console(file=devnull, width=140).print(tui.render())  # empty state
        tui.update(telemetry={"preset": 2, "duty_pct": 50, "rpm": None, "ds_temp_C": None, "settled": 1},
                   sim={"sim_rpm": 1680, "sim_current_mA": 120.0},
                   decision={"mode": "auto", "ambient_C": 30.0, "target_preset": 2,
                             "current_preset": 2, "action": "hold", "temp_C": 33.0},
                   alerts=[{"type": "fan_stall", "severity": "critical", "msg": "x", "time": 0}],
                   broker_ok=True, device_online=True)
        tui.event("hello")
        Console(file=devnull, width=140).print(tui.render())


if __name__ == "__main__":
    unittest.main()
