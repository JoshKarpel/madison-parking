// The inline trend view: the range presets, a pannable/zoomable chart, and a
// legend that a card expands into in place (tap the chart icon to expand, tap it
// again to collapse).
//
// The chart is a free window on time, not a fixed range. The 6h/Day/Week/Month
// buttons are shortcuts that jump the window to a "last N" span; from there you
// drag to pan through time (past and future) and pinch or wheel to zoom, and the
// bucket (raw / hourly / daily) and label format follow the current span. Where
// the window reaches past "now", the baseline supplies a forecast: the
// (day, hour) median as a dashed line with its typical p25–p75 band.
//
// Built as a factory so it stays decoupled from app.js's mutable state: the
// caller injects the Worker URL and getters for the (async-filled) history db
// and a garage's baseline cells, rather than this module reaching for globals.
//
// A single view element is reused across garages and across the app's periodic
// re-renders: app.js re-appends the same node into the freshly-built expanded
// card each render, so the window and loaded chart survive a background refresh.

import { renderChart } from "./chart.js";
import {
  getRawHistory,
  getBucketedHistory,
  nowSec,
  DAY_SECONDS,
} from "./history.js";
import { cellKey, MIN_CELL_OBSERVATIONS } from "./coloring.js";

const DAY = DAY_SECONDS;

const fmt = {
  time: new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }),
  weekday: new Intl.DateTimeFormat([], { weekday: "short" }),
  monthDay: new Intl.DateTimeFormat([], { month: "numeric", day: "numeric" }),
  month: new Intl.DateTimeFormat([], { month: "short" }),
  hour: new Intl.DateTimeFormat([], { hour: "numeric" }),
  monthDayFull: new Intl.DateTimeFormat([], { month: "short", day: "numeric" }),
};
const at = (ts) => new Date(ts * 1000);

// Presets are "last N" windows: they show `past` of history back from now, plus
// a small forecast peek ahead so the typical-ahead line is visible by default
// (drag right for more). Zoom/pan take over from there.
const PRESETS = [
  { key: "6h", label: "6h", past: 6 * 3600 },
  { key: "day", label: "Day", past: DAY },
  { key: "week", label: "Week", past: 7 * DAY },
  { key: "month", label: "Month", past: 30 * DAY },
];
const DEFAULT_PRESET = PRESETS[0]; // 6h: the immediate "could I park now?" horizon
const PEEK_FRACTION = 0.15; // fraction of the past span shown ahead of now

const MIN_SPAN = 3600; // an hour: zoomed all the way in
const MAX_SPAN = 5 * 365 * DAY; // the retention window: zoomed all the way out

// The bucket, gap threshold, and label formats follow the visible span, so a
// free zoom always lands on a sane point density and legible axis.
function scaleForSpan(span) {
  if (span <= 2 * DAY) {
    return {
      bucket: "raw", step: 300, band: false, useBaseline: true,
      xFormat: (ts) => fmt.time.format(at(ts)),
      pointFormat: (ts) => `${fmt.weekday.format(at(ts))} ${fmt.time.format(at(ts))}`,
    };
  }
  if (span <= 14 * DAY) {
    return {
      bucket: "hour", step: 3600, band: false, useBaseline: true,
      xFormat: (ts) => fmt.weekday.format(at(ts)),
      pointFormat: (ts) => `${fmt.weekday.format(at(ts))} ${fmt.hour.format(at(ts))}`,
    };
  }
  if (span <= 90 * DAY) {
    return {
      bucket: "hour", step: 3600, band: false, useBaseline: true,
      xFormat: (ts) => fmt.monthDay.format(at(ts)),
      pointFormat: (ts) => `${fmt.monthDay.format(at(ts))} ${fmt.hour.format(at(ts))}`,
    };
  }
  return {
    bucket: "day", step: 86400, band: true, useBaseline: false,
    xFormat: (ts) => fmt.month.format(at(ts)),
    pointFormat: (ts) => fmt.monthDayFull.format(at(ts)),
  };
}

// The typical p25–p75 range and median for each point's (day, hour), from the
// garage's stats cells, aligned to the series x. Empty when there's no baseline.
//
// A cell is per-hour, so many consecutive samples (a day of raw 5-min points)
// share one cell's constant percentiles. Emitting one baseline point apiece
// would make the band a piecewise-constant staircase — rectangular blocks with
// vertical steps at each hour boundary. Instead, collapse each contiguous
// same-cell run to a single point at the run's midpoint, so the band and median
// connect hour to hour with sloped lines. (Hourly buckets are already one cell
// per point, so their runs are length 1 and pass through unchanged.)
function baselineSeries(points, cells) {
  if (!cells) return [];
  const out = [];
  let run = null;
  const flush = () => {
    if (!run) return;
    const { cell, tsStart, tsEnd } = run;
    out.push({ ts: (tsStart + tsEnd) / 2, p25: cell.p25, p50: cell.p50, p75: cell.p75 });
    run = null;
  };
  for (const p of points) {
    const d = at(p.ts);
    const key = cellKey(d.getDay(), d.getHours());
    const cell = cells[key];
    if (!cell || cell.n < MIN_CELL_OBSERVATIONS) {
      flush();
      continue;
    }
    if (run && run.key === key) {
      run.tsEnd = p.ts;
    } else {
      flush();
      run = { key, cell, tsStart: p.ts, tsEnd: p.ts };
    }
  }
  flush();
  return out;
}

// The forecast for the future portion of the window: the baseline (day, hour)
// median with its typical p25–p75 range, one point per hour (the baseline's own
// resolution), thinned to keep the count bounded on a very wide window. Missing
// cells leave gaps, which the chart draws as breaks rather than bridging.
const PREDICT_STEP = 3600;
const MAX_PREDICT_POINTS = 800;

function predictSeries(startTs, endTs, cells) {
  if (!cells) return { points: [], step: PREDICT_STEP };
  const from = Math.max(startTs, nowSec());
  if (endTs <= from) return { points: [], step: PREDICT_STEP };
  let step = PREDICT_STEP;
  const span = endTs - from;
  if (span / step > MAX_PREDICT_POINTS) {
    step = Math.ceil(span / MAX_PREDICT_POINTS / PREDICT_STEP) * PREDICT_STEP;
  }
  const points = [];
  for (let t = Math.ceil(from / PREDICT_STEP) * PREDICT_STEP; t <= endTs; t += step) {
    const d = at(t);
    const cell = cells[cellKey(d.getDay(), d.getHours())];
    if (cell && cell.n >= MIN_CELL_OBSERVATIONS) {
      points.push({ ts: t, avg: cell.p50, min: cell.p25, max: cell.p75 });
    }
  }
  return { points, step };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// apiUrl:        Worker base URL.
// getHistoryDb:  () => IDBDatabase | null (filled asynchronously after open).
// getCells:      (garageId) => cells | null (the garage's baseline, or null).
export function createGraphView({ apiUrl, getHistoryDb, getCells }) {
  let els = null;
  let garage = null;
  let view = null; // { startTs, endTs } — the visible window
  let loaded = null; // { actual, predicted, predictedStep, scale }
  let renderedView = null; // the window `loaded` was rendered against
  let controller = null; // the current chart's { svg, content, plot, viewW, ... }
  let activePreset = null;
  let loadToken = 0;
  let wheelSettleTimer = null;

  function setView(next) {
    view = {
      startTs: next.startTs,
      endTs: next.endTs,
    };
  }

  function goToPreset(preset) {
    const now = nowSec();
    activePreset = preset.key;
    setView({
      startTs: now - preset.past,
      endTs: now + preset.past * PEEK_FRACTION,
    });
    refresh();
  }

  async function loadActual(from, to, bucket, id) {
    const db = getHistoryDb();
    const capEnd = Math.min(to, nowSec());
    if (from >= capEnd) return [];
    if (bucket === "raw") return getRawHistory(db, apiUrl, id, from, capEnd);
    return getBucketedHistory(db, apiUrl, id, bucket, from, capEnd);
  }

  // Reload the window's data and render. Loads a span of headroom on each side so
  // a pan (which only translates the drawn content) reveals already-loaded data
  // before it needs to reload. Stale loads are dropped by token.
  async function refresh() {
    if (!view || garage == null) return;
    const my = ++loadToken;
    const span = view.endTs - view.startTs;
    const scale = scaleForSpan(span);
    const pad = span;
    const from = view.startTs - pad;
    const to = view.endTs + pad;
    let actual = [];
    try {
      actual = await loadActual(from, to, scale.bucket, garage);
    } catch {
      actual = [];
    }
    if (my !== loadToken || garage == null) return;
    const { points: predicted, step: predictedStep } = predictSeries(from, to, getCells(garage));
    loaded = { actual, predicted, predictedStep, scale };
    renderView();
  }

  function legendText(baseline, predicted) {
    const bits = [];
    if (predicted.length) bits.push("dashed = typical ahead");
    if (baseline && baseline.length) bits.push("shaded = typical range");
    bits.push("drag · pinch to explore");
    return bits.join(" · ");
  }

  function updatePresetButtons() {
    for (const b of els.rangeButtons) {
      b.classList.toggle("active", b.dataset.key === activePreset);
    }
  }

  function renderView() {
    if (!els || !loaded || !view) return;
    const { actual, predicted, predictedStep, scale } = loaded;
    const baseline = scale.useBaseline ? baselineSeries(actual, getCells(garage)) : null;
    controller = renderChart({
      actual,
      predicted,
      baseline,
      domain: { t0: view.startTs, t1: view.endTs },
      nowTs: nowSec(),
      band: scale.band,
      stepSeconds: scale.step,
      predictedStepSeconds: predictedStep,
      xFormat: scale.xFormat,
      pointFormat: scale.pointFormat,
    });
    renderedView = { startTs: view.startTs, endTs: view.endTs };
    els.body.replaceChildren(controller.svg);
    wireGestures(controller.svg);
    els.status.textContent = actual.length || predicted.length ? "" : "No history for this range yet";
    els.legend.textContent = legendText(baseline, predicted);
    updatePresetButtons();
  }

  // While a gesture is in flight we don't rebuild the SVG (that would drop the
  // gesture's pointer state); instead we transform the already-drawn content to
  // preview the new window, then reload once the gesture settles. This maps the
  // rendered domain's content onto the current `view` with an x translate+scale.
  function applyGestureTransform() {
    if (!controller || !renderedView || !view) return;
    const rSpan = renderedView.endTs - renderedView.startTs;
    const vSpan = view.endTs - view.startTs;
    const scaleX = rSpan / vSpan;
    const left = controller.plot.left;
    const translateX =
      left + ((renderedView.startTs - view.startTs) / vSpan) * controller.plot.w - scaleX * left;
    controller.content.setAttribute("transform", `translate(${translateX},0) scale(${scaleX},1)`);
  }

  function zoomAround(focusTs, factor) {
    if (focusTs == null) return;
    const span = view.endTs - view.startTs;
    const newSpan = clamp(span * factor, MIN_SPAN, MAX_SPAN);
    const frac = (focusTs - view.startTs) / span;
    setView({
      startTs: focusTs - frac * newSpan,
      endTs: focusTs + (1 - frac) * newSpan,
    });
    activePreset = null;
    applyGestureTransform();
  }

  function wireGestures(svg) {
    const pointers = new Map();
    let press = null; // single-pointer press that may become a pan
    let panning = false;
    let pinch = null; // two-pointer zoom
    const dxOf = (a, b) => Math.abs(a.clientX - b.clientX);
    const both = () => [...pointers.values()];

    svg.addEventListener("pointerdown", (e) => {
      pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
      if (pointers.size === 2) {
        controller.hideCrosshair();
        press = null;
        panning = false;
        const [a, b] = both();
        const startSpan = view.endTs - view.startTs;
        const focusTs = controller.tsAtClientX((a.clientX + b.clientX) / 2);
        pinch = {
          startDist: Math.max(1, dxOf(a, b)),
          startSpan,
          startStart: view.startTs,
          focusFrac: focusTs == null ? 0.5 : (focusTs - view.startTs) / startSpan,
        };
        return;
      }
      if (e.button !== 0) return;
      press = { clientX: e.clientX, startView: { ...view } };
      panning = false;
      try {
        svg.setPointerCapture(e.pointerId);
      } catch {}
    });

    svg.addEventListener("pointermove", (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });

      if (pinch) {
        if (pointers.size < 2) return;
        const [a, b] = both();
        const newSpan = clamp((pinch.startSpan * pinch.startDist) / Math.max(1, dxOf(a, b)), MIN_SPAN, MAX_SPAN);
        const focusTs = pinch.startStart + pinch.focusFrac * pinch.startSpan;
        setView({
          startTs: focusTs - pinch.focusFrac * newSpan,
          endTs: focusTs + (1 - pinch.focusFrac) * newSpan,
        });
        activePreset = null;
        applyGestureTransform();
        return;
      }

      if (press) {
        const dx = e.clientX - press.clientX;
        if (!panning && Math.abs(dx) > 4) {
          panning = true;
          controller.hideCrosshair(); // a lingering hover crosshair shouldn't ride along with the pan
        }
        if (panning) {
          const dts = controller.tsAtClientX(e.clientX) - controller.tsAtClientX(press.clientX);
          setView({ startTs: press.startView.startTs - dts, endTs: press.startView.endTs - dts });
          applyGestureTransform();
        }
        return;
      }

      if (e.pointerType === "mouse") controller.crosshairAtClientX(e.clientX);
    });

    const endPointer = (e) => {
      pointers.delete(e.pointerId);
      try {
        svg.releasePointerCapture(e.pointerId);
      } catch {}
      if (pinch) {
        if (pointers.size < 2) {
          pinch = null;
          refresh();
        }
        return;
      }
      if (press) {
        if (panning) {
          refresh();
        } else {
          controller.crosshairAtClientX(e.clientX); // a tap: pin the readout
        }
        press = null;
        panning = false;
      }
    };
    svg.addEventListener("pointerup", endPointer);
    svg.addEventListener("pointercancel", endPointer);

    svg.addEventListener("pointerleave", (e) => {
      if (e.pointerType === "mouse" && !press && !pinch) controller.hideCrosshair();
    });

    svg.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        controller.hideCrosshair();
        zoomAround(controller.tsAtClientX(e.clientX), Math.exp(e.deltaY * 0.0015));
        if (wheelSettleTimer) clearTimeout(wheelSettleTimer);
        wheelSettleTimer = setTimeout(() => {
          wheelSettleTimer = null;
          refresh();
        }, 180);
      },
      { passive: false }
    );
  }

  function build() {
    const container = document.createElement("div");
    container.className = "graph-view";

    const tabs = document.createElement("div");
    tabs.className = "graph-ranges";
    const rangeButtons = PRESETS.map((preset) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "graph-range";
      b.textContent = preset.label;
      b.dataset.key = preset.key;
      b.addEventListener("click", () => goToPreset(preset));
      tabs.append(b);
      return b;
    });

    const body = document.createElement("div");
    body.className = "graph-body";
    const status = document.createElement("div");
    status.className = "graph-status";
    const legend = document.createElement("div");
    legend.className = "graph-legend";

    container.append(tabs, body, status, legend);
    els = { container, body, status, legend, rangeButtons };
    return els;
  }

  // Point the view at a garage and return its element for the caller to append.
  // Retargeting a new garage resets to the Day preset; re-mounting the same
  // garage (a background re-render) keeps the current window and chart.
  function mount(entry) {
    if (!els) build();
    if (entry.id !== garage) {
      garage = entry.id;
      goToPreset(DEFAULT_PRESET);
    }
    return els.container;
  }

  // Forget the current garage so the next mount starts fresh at the Day preset.
  function reset() {
    garage = null;
    view = null;
    loaded = null;
    renderedView = null;
    controller = null;
  }

  return { mount, reset };
}
