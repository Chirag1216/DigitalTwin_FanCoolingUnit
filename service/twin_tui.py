"""Rich terminal UI — live dashboard for the fan digital twin service."""

import threading
import time
from collections import deque

from rich.layout import Layout
from rich.panel import Panel
from rich.table import Table

from config import PRESETS, TELEMETRY_STALE_S


def _fmt(v, spec, unit=""):
    return f"{v:{spec}}{unit}" if isinstance(v, (int, float)) and not isinstance(v, bool) else "—"


def _preset_name(p):
    return PRESETS[p]["name"] if isinstance(p, int) and 0 <= p < len(PRESETS) else "?"


class TwinTUI:
    def __init__(self, broker_info: str = "localhost:1883", sim_temp: bool = False,
                 thresholds=None, threshold_source: str = "absolute"):
        self._broker_info = broker_info
        self._sim_temp = sim_temp
        self._thresholds = list(thresholds or [])
        self._threshold_source = threshold_source
        self._lock = threading.Lock()
        self._telemetry = {}
        self._sim = {}
        self._decision = {}
        self._alerts = []
        self._msg_count = 0
        self._last_rx = None
        self._broker_ok = False
        self._device_online = None  # None = unknown
        self._mode = "auto"
        self._events = deque(maxlen=6)

    # ---- state updates (called from MQTT / keyboard threads) ----
    def update(self, *, telemetry=None, sim=None, decision=None, alerts=None,
               broker_ok=None, device_online=None, mode=None):
        with self._lock:
            if telemetry is not None:
                self._telemetry = dict(telemetry)
                self._msg_count += 1
                self._last_rx = time.monotonic()
            if sim is not None:
                self._sim = sim
            if decision is not None:
                self._decision = decision
            if alerts is not None:
                self._alerts = list(alerts)
            if broker_ok is not None:
                self._broker_ok = broker_ok
            if device_online is not None:
                self._device_online = device_online
            if mode is not None:
                self._mode = mode

    def event(self, msg: str):
        with self._lock:
            self._events.append(f"[dim]{time.strftime('%H:%M:%S')}[/] {msg}")

    # ---- rendering (main thread) ----
    def render(self) -> Layout:
        with self._lock:
            layout = Layout()
            layout.split_column(
                Layout(self._status_panel(), size=3),
                Layout(name="main", ratio=1),
                Layout(name="bottom", size=8),
                Layout(self._keys_panel(), size=3),
            )
            layout["main"].split_row(
                Layout(self._telemetry_panel(), ratio=1),
                Layout(self._twin_panel(), ratio=1),
            )
            layout["bottom"].split_row(
                Layout(self._alerts_panel(), ratio=3),
                Layout(self._events_panel(), ratio=2),
            )
            return layout

    def _status_panel(self) -> Panel:
        t = self._telemetry
        broker = ("[bold green]● BROKER[/]" if self._broker_ok
                  else f"[bold red]○ BROKER {self._broker_info}[/]")
        stale = self._last_rx is None or time.monotonic() - self._last_rx > TELEMETRY_STALE_S
        if self._device_online is False:
            device = "[bold red]○ ESP32 OFFLINE[/]"
        elif stale:
            device = "[bold yellow]○ ESP32 NO DATA[/]"
        else:
            device = "[bold green]● ESP32 LIVE[/]"
        mode = self._mode.upper()
        mode_style = "bold green" if mode == "AUTO" else "bold yellow"
        p = t.get("preset")
        info = (f"{broker}  {device}  │  Mode: [{mode_style}]{mode}[/]  │  "
                f"Preset: [bold cyan]{p if p is not None else '—'} ({_preset_name(p)})[/]  │  "
                f"Duty: [bold]{_fmt(t.get('duty_pct'), '.0f', '%')}[/]  │  Frames: {self._msg_count}")
        if self._sim_temp:
            info += "  │  [bold magenta]SIM-TEMP DEMO[/]"
        return Panel(info, title="[bold blue]Arctic P12 Pro — Digital Twin[/]", border_style="blue")

    def _telemetry_panel(self) -> Panel:
        t = self._telemetry
        table = Table(show_lines=True, expand=True)
        table.add_column("Physical Sensor", style="bold")
        table.add_column("Measurement", justify="right")
        table.add_column("Unit", style="dim")
        table.add_row("Tachometer", _fmt(t.get("rpm"), ".0f"), "RPM")
        table.add_row("Enclosure Temp (DS18B20)", _fmt(t.get("ds_temp_C"), ".2f"), "°C")
        table.add_row("Board Temp (MPU6050)", _fmt(t.get("temp_C"), ".2f"), "°C")
        table.add_row("Vibration std (ax)", _fmt(t.get("ax_std"), ".4f"), "m/s²")
        table.add_row("Fan Current", _fmt(t.get("current_mA"), ".1f"), "mA")
        table.add_row("Bus Voltage", _fmt(t.get("bus_V"), ".2f"), "V")
        v, i = t.get("bus_V"), t.get("current_mA")
        p = v * i / 1000.0 if isinstance(v, (int, float)) and isinstance(i, (int, float)) else None
        table.add_row("Electrical Power", _fmt(p, ".2f"), "W")
        table.add_row("Settled", "Yes" if t.get("settled") else "No (transient)", "")
        return Panel(table, title="[bold cyan]Physical Telemetry[/]", border_style="cyan")

    def _twin_panel(self) -> Panel:
        t, s, d = self._telemetry, self._sim, self._decision
        table = Table(show_lines=True, expand=True)
        table.add_column("Twin Property", style="bold")
        table.add_column("Physical", justify="right")
        table.add_column("Model", justify="right")
        table.add_column("Status")

        rpm, sim_rpm = t.get("rpm"), s.get("sim_rpm")
        if isinstance(rpm, (int, float)) and isinstance(sim_rpm, (int, float)):
            ok = abs(rpm - sim_rpm) <= sim_rpm * 0.15 if sim_rpm > 0 else rpm < 50
            status = "[green]NOMINAL[/]" if ok else "[yellow]DEVIANT[/]"
            if not t.get("settled"):
                status = "[dim]TRANSIENT[/]"
        else:
            status = "—"
        table.add_row("Fan Speed", _fmt(rpm, ".0f", " RPM"), _fmt(sim_rpm, ".0f", " RPM"), status)

        cur, sim_cur = t.get("current_mA"), s.get("sim_current_mA")
        if isinstance(cur, (int, float)) and isinstance(sim_cur, (int, float)) and sim_cur > 0:
            dev = (cur - sim_cur) / sim_cur * 100
            cstat = f"[dim]{dev:+.0f}% (est.)[/]"
        else:
            cstat = "—"
        table.add_row("Current", _fmt(cur, ".1f", " mA"), _fmt(sim_cur, ".1f", " mA"), cstat)

        temp = d.get("temp_C")
        temp_label = "Control Temp" + (" (sim)" if self._sim_temp else "")
        table.add_row(temp_label, _fmt(temp, ".2f", "°C"),
                      f"amb {_fmt(d.get('ambient_C'), '.1f', '°C')}", "")

        th = " / ".join(f"{x:.1f}" for x in self._thresholds)
        table.add_row("Thresholds", f"[dim]{self._threshold_source}[/]", th, "")

        action = str(d.get("action", "—")).upper()
        color = {"CHANGED": "bold yellow", "HOLD": "green", "SETTLING": "cyan",
                 "MANUAL": "yellow", "RATE_LIMITED": "cyan"}.get(action, "white")
        tp = d.get("target_preset")
        table.add_row("Controller", f"P{d.get('current_preset', '—')}",
                      f"→ P{tp if tp is not None else '—'} {_preset_name(tp)}", f"[{color}]{action}[/]")
        return Panel(table, title="[bold green]Simulation Model & Thermal Controller[/]",
                     border_style="green")

    def _alerts_panel(self) -> Panel:
        if not self._alerts:
            body = "[dim]No anomalies detected. System healthy.[/]"
        else:
            icons = {"critical": "[bold red]CRIT[/]", "warning": "[bold yellow]WARN[/]"}
            lines = []
            for a in self._alerts[-5:]:
                ts = time.strftime("%H:%M:%S", time.localtime(a.get("time", 0)))
                lines.append(f"[dim]{ts}[/] {icons.get(a.get('severity'), '[bold blue]INFO[/]')} "
                             f"{a.get('msg')}")
            body = "\n".join(lines)
        return Panel(body, title="[bold yellow]Anomaly Monitor[/]", border_style="yellow")

    def _events_panel(self) -> Panel:
        body = "\n".join(self._events) if self._events else "[dim]—[/]"
        return Panel(body, title="[bold]Events[/]", border_style="white")

    def _keys_panel(self) -> Panel:
        return Panel("[bold]m[/] toggle AUTO/MANUAL   [bold]0-4[/] set preset (MANUAL)   "
                     "[bold]q[/] / Ctrl+C quit", border_style="dim")
