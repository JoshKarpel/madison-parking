// The inline trend view: the range presets, a pannable/zoomable chart, and a
// legend that a card expands into in place (tap the chart icon to expand, tap it
// again to collapse).
//
// The chart is a free window on time, not a fixed range. The 6h/Day/Week/Month
// buttons are shortcuts that jump the window to a "last N" span; from there you
// drag to pan through time (past and future) and pinch or wheel to zoom, and the
// bucket (raw / hourly / daily) and label format follow the current span. The
// baseline "typical for this (day, hour)" overlay (median + p25–p75 band) runs as
// one continuous line across the window: faint context behind the recorded past,
// switching at "now" into the bolder forecast ahead.
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
import { eventEmoji } from "./events.js";

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

// The "typical for this (day, hour)" overlay, from the garage's stats cells, as a
// single continuous series across the *whole* window — past and future alike. It's
// the baseline p50 median with its p25–p75 range, one point per hour (the cells'
// own resolution), thinned to keep the count bounded on a very wide window.
//
// Points sit on hour boundaries plus an extra anchor exactly at `now`, so the
// chart can switch the median's style at that boundary (faint context behind the
// recorded past, bolder forecast ahead) with the two halves meeting at the shared
// anchor rather than leaving a gap. A cell with no support emits no point, so the
// chart draws honest breaks where the baseline can't speak instead of bridging.
const TYPICAL_STEP = 3600;
const MAX_TYPICAL_POINTS = 800;

function typicalSeries(startTs, endTs, cells) {
  if (!cells || endTs <= startTs) return { points: [], step: TYPICAL_STEP };
  let step = TYPICAL_STEP;
  const span = endTs - startTs;
  if (span / step > MAX_TYPICAL_POINTS) {
    step = Math.ceil(span / MAX_TYPICAL_POINTS / TYPICAL_STEP) * TYPICAL_STEP;
  }
  const now = nowSec();
  const stamps = [];
  for (let t = Math.ceil(startTs / step) * step; t <= endTs; t += step) stamps.push(t);
  if (now >= startTs && now <= endTs) stamps.push(now);
  stamps.sort((a, b) => a - b);
  const points = [];
  let prev = null;
  for (const t of stamps) {
    if (t === prev) continue; // the `now` anchor may coincide with a step boundary
    prev = t;
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
// getEvents:     (garageId) => [{ starts_at, title, classification }] near it.
export function createGraphView({ apiUrl, getHistoryDb, getCells, getEvents }) {
  let els = null;
  let garage = null;
  let view = null; // { startTs, endTs } — the visible window
  let loaded = null; // { actual, typical, typicalStep, scale }
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
    const { points: typical, step: typicalStep } = typicalSeries(from, to, getCells(garage));
    loaded = { actual, typical, typicalStep, scale };
    renderView();
  }

  function legendText(typical) {
    const bits = [];
    if (typical.length) bits.push("dashed line & shaded band = typical for this time");
    bits.push("drag · pinch to explore");
    return bits.join(" · ");
  }

  function updatePresetButtons() {
    for (const b of els.rangeButtons) {
      b.classList.toggle("active", b.dataset.key === activePreset);
    }
  }

  function eventMarkers() {
    const events = (getEvents && getEvents(garage)) || [];
    return events.map((e) => ({
      ts: e.starts_at,
      emoji: eventEmoji(e.classification),
      title: e.title,
      url: e.url,
    }));
  }

  function renderView() {
    if (!els || !loaded || !view) return;
    const { actual, typical, typicalStep, scale } = loaded;
    const now = nowSec();
    // At the wide (daily) zoom the past typical band is noise over months of real
    // data, so there we show the overlay only ahead of now; the finer scales run it
    // continuously across the window. Either way it's one series, just clipped.
    const shown = scale.useBaseline ? typical : typical.filter((p) => p.ts >= now);
    controller = renderChart({
      actual,
      typical: shown,
      events: eventMarkers(),
      domain: { t0: view.startTs, t1: view.endTs },
      nowTs: now,
      band: scale.band,
      stepSeconds: scale.step,
      typicalStepSeconds: typicalStep,
      xFormat: scale.xFormat,
      pointFormat: scale.pointFormat,
    });
    renderedView = { startTs: view.startTs, endTs: view.endTs };
    els.body.replaceChildren(controller.svg);
    wireGestures(controller.svg);
    els.status.textContent = actual.length || shown.length ? "" : "No history for this range yet";
    els.legend.textContent = legendText(shown);
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
    const transform = `translate(${translateX},0) scale(${scaleX},1)`;
    controller.content.setAttribute("transform", transform);
    // The event-marker layer sits above the gesture surface (so its links are
    // tappable); pan/zoom it in lockstep with the data content.
    if (controller.eventsLayer) controller.eventsLayer.setAttribute("transform", transform);
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
    let markerTap = null; // a press that landed on an event marker (opens its link)
    const dxOf = (a, b) => Math.abs(a.clientX - b.clientX);
    const both = () => [...pointers.values()];

    svg.addEventListener("pointerdown", (e) => {
      pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
      if (pointers.size === 2) {
        controller.hideCrosshair();
        press = null;
        panning = false;
        markerTap = null;
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
      // A press that lands on an event marker opens its Ticketmaster link instead
      // of starting a pan: recorded here, opened on release (below). We open it
      // ourselves rather than making the marker a plain <a>, because capturing the
      // pointer for a pan would swallow the anchor's native click.
      const hit = e.target.closest && e.target.closest(".chart-event-hit");
      if (hit) {
        markerTap = { url: hit.getAttribute("data-url"), clientX: e.clientX };
        return;
      }
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
      // A tap that stayed put on an event marker opens its show; a drag from one
      // (moved past the pan threshold) is ignored, not a mis-navigation.
      if (markerTap) {
        const url = markerTap.url;
        const moved = Math.abs(e.clientX - markerTap.clientX) > 4;
        markerTap = null;
        if (url && !moved) window.open(url, "_blank", "noopener");
        return;
      }
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
