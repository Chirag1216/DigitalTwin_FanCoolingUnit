/**
 * Lightweight Canvas 2D chart renderers:
 *  1) SegmentedArcGauge — duty_pct segmented arc gauge for Butter Yellow card
 *  2) SparklineChart — 2-minute time-series sparklines (RPM, Vibration, Temp)
 */

import { isNum, HISTORY_MS } from "./state.js";

const FONT_MONO =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

function setupHiDPICanvas(canvas, fallbackW, fallbackH) {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width || fallbackW));
  const h = Math.max(1, Math.round(rect.height || fallbackH));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

export class SegmentedArcGauge {
  constructor(canvas) {
    this.canvas = canvas;
    this._duty = null;
    this._presetLabel = "—";
    this._offline = true;

    this._ro = new ResizeObserver(() => this.draw());
    this._ro.observe(canvas);
  }

  update({ dutyPct, presetLabel, offline }) {
    this._duty = isNum(dutyPct) ? Math.max(0, Math.min(100, dutyPct)) : null;
    this._presetLabel = presetLabel || "—";
    this._offline = Boolean(offline);
    this.draw();
  }

  draw() {
    const { ctx, w, h } = setupHiDPICanvas(this.canvas, 220, 148);
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h * 0.6;
    const radius = Math.max(34, Math.min(w * 0.4, h * 0.48));
    const segments = 24;
    const startAngle = (145 * Math.PI) / 180;
    const endAngle = (395 * Math.PI) / 180;
    const totalArc = endAngle - startAngle;
    const step = totalArc / segments;
    const gap = step * 0.24;
    const segLen = step - gap;

    const activeCount =
      !this._offline && isNum(this._duty)
        ? Math.round((this._duty / 100) * segments)
        : 0;

    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(8, radius * 0.19);

    for (let i = 0; i < segments; i++) {
      const a0 = startAngle + i * step + gap / 2;
      const a1 = a0 + segLen;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, a0, a1);
      if (i < activeCount) {
        ctx.strokeStyle = "#0A0A0C";
      } else {
        ctx.strokeStyle = "rgba(10, 10, 12, 0.14)";
      }
      ctx.stroke();
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const valueText =
      !this._offline && isNum(this._duty) ? `${Math.round(this._duty)}%` : "—";
    ctx.fillStyle = this._offline ? "rgba(10, 10, 12, 0.45)" : "#0A0A0C";
    ctx.font = `700 ${Math.round(radius * 0.48)}px ${FONT_MONO}`;
    ctx.fillText(valueText, cx, cy - radius * 0.06);

    ctx.fillStyle = "rgba(10, 10, 12, 0.65)";
    ctx.font = `700 ${Math.max(10, Math.round(radius * 0.2))}px ${FONT_MONO}`;
    ctx.fillText(
      this._offline ? "OFFLINE" : this._presetLabel,
      cx,
      cy + radius * 0.34
    );
  }
}

export class SparklineChart {
  /**
   * @param {HTMLElement} container - wrapper containing <canvas> and .chart-tip
   * @param {Object} opts
   */
  constructor(container, opts) {
    this.container = container;
    this.canvas = container.querySelector("canvas");
    this.tipEl = container.querySelector(".chart-tip");
    this.opts = opts;
    this._points = [];
    this._hoverX = null;

    this._roRaf = 0;
    this._ro = new ResizeObserver(() => {
      if (this._roRaf) return;
      this._roRaf = requestAnimationFrame(() => {
        this._roRaf = 0;
        this.draw();
      });
    });
    this._ro.observe(this.container);

    this.canvas.addEventListener("pointermove", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this._hoverX = e.clientX - rect.left;
      this.draw();
    });
    this.canvas.addEventListener("pointerleave", () => {
      this._hoverX = null;
      if (this.tipEl) this.tipEl.hidden = true;
      this.draw();
    });
  }

  setData(points) {
    this._points = points || [];
    this.draw();
  }

  draw() {
    const { ctx, w, h } = setupHiDPICanvas(this.canvas, 280, 92);
    ctx.clearRect(0, 0, w, h);

    const padL = 40;
    const padR = 8;
    const padT = 8;
    const padB = 18;
    const plotW = Math.max(20, w - padL - padR);
    const plotH = Math.max(20, h - padT - padB);

    const pts = this._points;
    const now = pts.length ? pts[pts.length - 1].t : Date.now();
    const {
      primaryKey,
      secondaryKey = null,
      limitKey = null,
      primaryColor = "#C8F560",
      secondaryColor = "rgba(255, 255, 255, 0.55)",
      limitColor = "#F47B42",
      gridColor = "rgba(255, 255, 255, 0.08)",
      labelColor = "rgba(255, 255, 255, 0.45)",
      footerColor = "rgba(255, 255, 255, 0.35)",
      dotStrokeColor = "#161618",
      crosshairColor = "rgba(255, 255, 255, 0.35)",
      decimals = 0,
      unit = "",
      getRange,
      alertWhenAboveLimit = false,
    } = this.opts;

    const validPrimary = pts.filter((p) => isNum(p[primaryKey]));
    const primaryVals = validPrimary.map((p) => p[primaryKey]);
    const secondaryVals = secondaryKey
      ? pts.filter((p) => isNum(p[secondaryKey])).map((p) => p[secondaryKey])
      : [];
    const limitVals = limitKey
      ? pts.filter((p) => isNum(p[limitKey])).map((p) => p[limitKey])
      : [];

    const [lo, hi] = getRange(primaryVals, secondaryVals, limitVals);
    const span = Math.max(1e-6, hi - lo);

    const xOf = (t) =>
      padL + plotW * Math.max(0, Math.min(1, 1 - (now - t) / HISTORY_MS));
    const yOf = (v) => padT + plotH * (1 - (v - lo) / span);

    // Grid lines + Y labels
    ctx.font = `500 10px ${FONT_MONO}`;
    ctx.textBaseline = "middle";
    [lo, (lo + hi) / 2, hi].forEach((val, idx) => {
      const y = yOf(val);
      ctx.beginPath();
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 1;
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();

      ctx.setLineDash([]);
      ctx.fillStyle = labelColor;
      ctx.textAlign = "right";
      const label = val.toFixed(decimals);
      const yText = idx === 0 ? Math.min(y, padT + plotH - 4) : idx === 2 ? Math.max(y, padT + 5) : y;
      ctx.fillText(label, padL - 6, yText);
    });

    // Footer time labels
    ctx.fillStyle = footerColor;
    ctx.textBaseline = "bottom";
    ctx.textAlign = "left";
    ctx.fillText("2m ago", padL, h - 2);
    ctx.textAlign = "right";
    ctx.fillText("now", w - padR, h - 2);

    // Optional limit threshold line (stepped or latest)
    if (limitKey && pts.length) {
      this._drawSeries(ctx, pts, limitKey, xOf, yOf, {
        color: limitColor,
        width: 1.5,
        dash: [5, 4],
        gapMs: 2500,
      });
    }

    // Optional secondary series (e.g., sim_rpm)
    if (secondaryKey && pts.length) {
      this._drawSeries(ctx, pts, secondaryKey, xOf, yOf, {
        color: secondaryColor,
        width: 1.5,
        dash: [4, 4],
        gapMs: 2500,
      });
    }

    // Primary series
    let strokeColor = primaryColor;
    if (alertWhenAboveLimit && validPrimary.length && limitKey) {
      const latest = validPrimary[validPrimary.length - 1];
      if (isNum(latest[limitKey]) && latest[primaryKey] > latest[limitKey]) {
        strokeColor = "#F47B42";
      }
    }

    if (validPrimary.length) {
      this._drawSeries(ctx, pts, primaryKey, xOf, yOf, {
        color: strokeColor,
        width: 2.5,
        dash: [],
        gapMs: 2500,
      });
    }

    // Hover crosshair & tooltip
    if (this._hoverX !== null && validPrimary.length) {
      let nearest = validPrimary[0];
      let bestDist = Math.abs(xOf(nearest.t) - this._hoverX);
      for (let i = 1; i < validPrimary.length; i++) {
        const d = Math.abs(xOf(validPrimary[i].t) - this._hoverX);
        if (d < bestDist) {
          bestDist = d;
          nearest = validPrimary[i];
        }
      }

      const px = xOf(nearest.t);
      const py = yOf(nearest[primaryKey]);

      ctx.beginPath();
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = crosshairColor;
      ctx.lineWidth = 1;
      ctx.moveTo(px, padT);
      ctx.lineTo(px, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fillStyle = strokeColor;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = dotStrokeColor;
      ctx.stroke();

      if (this.tipEl) {
        const ageS = Math.max(0, Math.round((now - nearest.t) / 1000));
        const valStr = nearest[primaryKey].toFixed(decimals);
        let extra = "";
        if (secondaryKey && isNum(nearest[secondaryKey])) {
          extra = ` · twin ${nearest[secondaryKey].toFixed(decimals)}`;
        } else if (limitKey && isNum(nearest[limitKey])) {
          extra = ` · lim ${nearest[limitKey].toFixed(2)}`;
        }
        this.tipEl.textContent = `${valStr}${unit ? " " + unit : ""}${extra} (${ageS}s ago)`;
        this.tipEl.hidden = false;
        if (px > w * 0.55) {
          this.tipEl.style.left = "auto";
          this.tipEl.style.right = `${Math.max(8, w - px + 10)}px`;
        } else {
          this.tipEl.style.right = "auto";
          this.tipEl.style.left = `${Math.max(8, px + 10)}px`;
        }
      }
    } else if (this.tipEl) {
      this.tipEl.hidden = true;
    }
  }

  _drawSeries(ctx, pts, key, xOf, yOf, { color, width, dash, gapMs }) {
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.setLineDash(dash);

    let prevT = null;
    let started = false;
    for (const pt of pts) {
      const val = pt[key];
      if (!isNum(val)) {
        prevT = null;
        continue;
      }
      const x = xOf(pt.t);
      const y = yOf(val);
      if (prevT === null || pt.t - prevT > gapMs) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      prevT = pt.t;
      started = true;
    }
    if (started) {
      ctx.stroke();
    }
    ctx.restore();
  }
}
