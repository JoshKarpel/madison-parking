// The inline trend view: the range tabs, chart, and legend that a card expands
// into in place (tap the card to expand, tap its header again to collapse),
// overlaying the "typical" baseline where it applies.
//
// Built as a factory so it stays decoupled from app.js's mutable state: the
// caller injects the Worker URL and getters for the (async-filled) history db
// and a garage's baseline cells, rather than this module reaching for globals.
//
// A single view element is reused across garages and across the app's periodic
// re-renders: app.js re-appends the same node into the freshly-built expanded
// card each render, so the selected range and loaded chart survive a background
// refresh instead of resetting every minute.

import { renderChart } from "./chart.js";
import {
  getRawHistory,
  getBucketedHistory,
  nowSec,
  DAY_SECONDS,
} from "./history.js";
import { cellKey, MIN_CELL_OBSERVATIONS } from "./coloring.js";

// Ranges pick a bucket that keeps the point count sane at ~380px: a day of raw
// 5-min samples, a week/month of hourly aggregates, a year of daily aggregates.
const fmt = {
  time: new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }),
  weekday: new Intl.DateTimeFormat([], { weekday: "short" }),
  monthDay: new Intl.DateTimeFormat([], { month: "numeric", day: "numeric" }),
  month: new Intl.DateTimeFormat([], { month: "short" }),
};
const at = (ts) => new Date(ts * 1000);

// baseline: overlay the (day, hour) typical p25–p75 range. Meaningful only when
// each x-bucket maps to one hour (raw/hourly), so year (daily buckets) instead
// keeps the actual min/max envelope (band).
const RANGES = [
  { key: "day",   label: "Day",   span: DAY_SECONDS,       bucket: "raw",  step: 300,   baseline: true,  band: false, xFormat: (ts) => fmt.time.format(at(ts)) },
  { key: "week",  label: "Week",  span: 7 * DAY_SECONDS,   bucket: "hour", step: 3600,  baseline: true,  band: false, xFormat: (ts) => fmt.weekday.format(at(ts)) },
  { key: "month", label: "Month", span: 30 * DAY_SECONDS,  bucket: "hour", step: 3600,  baseline: true,  band: false, xFormat: (ts) => fmt.monthDay.format(at(ts)) },
  { key: "year",  label: "Year",  span: 365 * DAY_SECONDS, bucket: "day",  step: 86400, baseline: false, band: true,  xFormat: (ts) => fmt.month.format(at(ts)) },
];

// The typical p25–p75 range and median for each point's (day, hour), from the
// garage's stats cells, aligned to the series x. Empty when there's no baseline.
function baselineSeries(points, cells) {
  if (!cells) return [];
  const out = [];
  for (const p of points) {
    const d = at(p.ts);
    const cell = cells[cellKey(d.getDay(), d.getHours())];
    if (cell && cell.n >= MIN_CELL_OBSERVATIONS) {
      out.push({ ts: p.ts, p25: cell.p25, p50: cell.p50, p75: cell.p75 });
    }
  }
  return out;
}

// apiUrl:        Worker base URL.
// getHistoryDb:  () => IDBDatabase | null (filled asynchronously after open).
// getCells:      (garageId) => cells | null (the garage's baseline, or null).
export function createGraphView({ apiUrl, getHistoryDb, getCells }) {
  let els = null;
  let garage = null;

  async function loadSeries(range, id) {
    const until = nowSec();
    const since = until - range.span;
    const db = getHistoryDb();
    if (range.bucket === "raw") {
      return getRawHistory(db, apiUrl, id, since, until);
    }
    return getBucketedHistory(db, apiUrl, id, range.bucket, since, until);
  }

  function build() {
    const container = document.createElement("div");
    container.className = "graph-view";

    const tabs = document.createElement("div");
    tabs.className = "graph-ranges";
    const rangeButtons = RANGES.map((r) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "graph-range";
      b.textContent = r.label;
      b.dataset.key = r.key;
      b.addEventListener("click", () => showRange(r));
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

  async function showRange(range) {
    const { body, status, legend, rangeButtons } = els;
    for (const b of rangeButtons) {
      b.classList.toggle("active", b.dataset.key === range.key);
    }
    status.textContent = "Loading…";
    legend.textContent = "";
    const id = garage;
    try {
      const points = await loadSeries(range, id);
      if (garage !== id) return; // collapsed or switched garages mid-load

      const cells = getCells(id);
      const baseline = range.baseline ? baselineSeries(points, cells) : null;
      body.replaceChildren(
        renderChart(points, {
          band: range.band,
          baseline,
          stepSeconds: range.step,
          xFormat: range.xFormat,
        })
      );
      status.textContent = points.length ? "" : "No history for this range yet";
      legend.textContent =
        baseline && baseline.length
          ? "line: actual · shaded: typical for this day & time"
          : "";
    } catch {
      body.replaceChildren();
      legend.textContent = "";
      status.textContent = "Couldn't load history";
    }
  }

  // Point the view at a garage and return its element for the caller to append.
  // Retargeting a new garage resets to the Day range; re-mounting the same
  // garage (a background re-render) keeps the current range and chart.
  function mount(entry) {
    if (!els) build();
    if (entry.id !== garage) {
      garage = entry.id;
      showRange(RANGES[0]);
    }
    return els.container;
  }

  // Forget the current garage so the next mount starts fresh at the Day range.
  function reset() {
    garage = null;
  }

  return { mount, reset };
}
