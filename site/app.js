import { GARAGES } from "./garages.js";
import {
  openHistoryDb,
  requestPersist,
  syncSamples,
  getStats,
  getRawHistory,
  getBucketedHistory,
  nowSec,
  DAY_SECONDS,
} from "./history.js";
import { classify, comparisonLabel, localCell, cellKey, MIN_CELL_OBSERVATIONS } from "./coloring.js";
import { renderChart } from "./chart.js";

const DEFAULT_API_URL = "https://madison-parking.josh-karpel.workers.dev";

// The Worker base URL. No build step means no env injection, so for local
// testing an `?api=<url>` query param overrides it (persisted in localStorage;
// `?api=` with no value clears it). Honored on localhost only, so a crafted link
// can't repoint the installed production PWA at another origin.
function resolveApiUrl() {
  if (!["localhost", "127.0.0.1"].includes(location.hostname)) {
    return DEFAULT_API_URL;
  }
  try {
    const params = new URLSearchParams(location.search);
    if (params.has("api")) {
      const override = params.get("api");
      if (override) localStorage.setItem("parking:api", override);
      else localStorage.removeItem("parking:api");
    }
    return localStorage.getItem("parking:api") || DEFAULT_API_URL;
  } catch {
    return DEFAULT_API_URL;
  }
}

const API_URL = resolveApiUrl();

// IDs that appear in the upstream feed but we don't want to show (e.g. ID 9,
// which the city's data reports but which isn't in their public garage table).
const HIDDEN_IDS = new Set(["9"]);

// How often to auto-refresh while the app is open and visible. The city updates
// every couple of minutes and the Worker edge-caches for 60s, so polling much
// faster than this just re-serves the same numbers.
const REFRESH_INTERVAL_MS = 60_000;

const STORAGE_KEYS = {
  data: "parking:data",
  favorites: "parking:favorites",
};

const els = {
  modified: document.getElementById("modified"),
  status: document.getElementById("status"),
  progressBar: document.getElementById("refresh-progress-bar"),
  refreshLabel: document.getElementById("refresh-label"),
  favorites: document.getElementById("favorites"),
  favoritesEmpty: document.getElementById("favorites-empty"),
  others: document.getElementById("others"),
  refreshIndicator: document.getElementById("refresh-indicator"),
};

function loadCachedData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.data);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveData(data) {
  localStorage.setItem(STORAGE_KEYS.data, JSON.stringify(data));
}

function loadFavorites() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.favorites);
    const ids = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch {
    return [];
  }
}

function saveFavorites(order) {
  localStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify(order));
}

// Ordered list of favorited garage IDs. The order is user-controlled (drag a
// favorite by its grip to reorder) and drives the order favorites render in.
let favoriteOrder = loadFavorites();

function isFavorite(id) {
  return favoriteOrder.includes(id);
}

// History cache (opened at startup) and per-garage baseline stats, both filled
// asynchronously. Until stats arrive, cards render uncolored.
let historyDb = null;
const statsByGarage = new Map();

// The (day_of_week, hour) baseline cell that applies to a garage right now.
function currentCell(id) {
  const stats = statsByGarage.get(id);
  if (!stats) return null;
  const { dow, hour } = localCell(new Date());
  return stats.cells[cellKey(dow, hour)] || null;
}

// Relative color band for a count, or null when there's no basis to judge (no
// count, no stats yet, or too little history for this cell). Null => uncolored.
function bandFor(count, id) {
  return classify(count, currentCell(id));
}

// Union of the garages we know about and whatever the response contains, so an
// unknown ID renders as "Ramp <id>" and a known ID missing from the response
// renders as unavailable rather than being dropped.
function garageEntries(vacancies) {
  const ids = new Set([
    ...Object.keys(GARAGES),
    ...Object.keys(vacancies || {}),
  ]);
  return [...ids]
    .filter((id) => !HIDDEN_IDS.has(id))
    .map((id) => {
      const known = GARAGES[id];
      const raw = vacancies ? vacancies[id] : undefined;
      const count = typeof raw === "number" ? raw : null;
      return {
        id,
        name: known ? known.name : `Ramp ${id}`,
        address: known ? known.address : undefined,
        note: known ? known.note : undefined,
        count,
      };
    })
    .sort((a, b) => Number(a.id) - Number(b.id));
}

function mapsUrl(address) {
  const query = encodeURIComponent(address);
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}

function makeCard(entry, favorited) {
  const card = document.createElement("div");
  const band = bandFor(entry.count, entry.id);
  const bandClass = entry.count == null ? "unavailable" : band ? `band-${band.band}` : "";
  card.className = `card ${bandClass}`.trim();
  card.dataset.id = entry.id;

  const star = document.createElement("button");
  star.className = "star";
  star.type = "button";
  star.textContent = favorited ? "★" : "☆";
  star.setAttribute(
    "aria-label",
    favorited ? `Unfavorite ${entry.name}` : `Favorite ${entry.name}`
  );
  star.setAttribute("aria-pressed", String(favorited));
  star.addEventListener("click", () => toggleFavorite(entry.id));

  // Garages with a known address link out to Google Maps; unmapped ramps have
  // no known location, so their name stays plain text.
  const name = document.createElement(entry.address ? "a" : "div");
  name.className = "name";
  name.textContent = entry.name;
  if (entry.address) {
    name.href = mapsUrl(entry.address);
    name.target = "_blank";
    name.rel = "noopener";
    const pin = document.createElement("span");
    pin.className = "pin";
    pin.textContent = "📍";
    name.append(" ", pin);
  }

  const count = document.createElement("div");
  count.className = "count";
  count.textContent = entry.count == null ? "—" : String(entry.count);

  const label = document.createElement("div");
  label.className = "count-label";
  label.textContent = entry.count == null ? "unavailable" : "spots";

  card.append(star, name, count, label);

  // How this count compares to the garage's own history for this day and hour,
  // when there's enough history to say. Otherwise nothing (no guessing).
  const comparison = comparisonLabel(entry.count, currentCell(entry.id), new Date());
  if (comparison) {
    const el = document.createElement("div");
    el.className = "comparison";
    el.textContent = comparison;
    card.append(el);
  }

  if (entry.note) {
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = entry.note;
    card.append(note);
  }

  // Favorites can be dragged to reorder, via a grip handle.
  if (favorited) card.append(makeGrip(card, entry));

  // Tapping the card body (not the star, map link, or grip) opens its trends.
  card.addEventListener("click", (e) => {
    if (e.target.closest(".star, .name, .grip")) return;
    openGraph(entry);
  });

  return card;
}

function toggleFavorite(id) {
  const i = favoriteOrder.indexOf(id);
  if (i >= 0) favoriteOrder.splice(i, 1);
  else favoriteOrder.push(id);
  saveFavorites(favoriteOrder);
  render(loadCachedData());
}

// The most recently rendered snapshot, so late-arriving stats can re-render the
// same data (recoloring cards) without re-reading storage and racing a refresh.
let lastData = null;

function render(data, { stale = false } = {}) {
  lastData = data;
  els.modified.textContent = data && data.modified ? data.modified : "unknown";

  const entries = garageEntries(data ? data.vacancies : {});
  const byId = new Map(entries.map((e) => [e.id, e]));

  const favEntries = favoriteOrder.map((id) => byId.get(id)).filter(Boolean);
  const otherEntries = entries.filter((e) => !isFavorite(e.id));

  els.favorites.replaceChildren(...favEntries.map((e) => makeCard(e, true)));
  els.favoritesEmpty.hidden = favEntries.length > 0;

  els.others.replaceChildren(...otherEntries.map((e) => makeCard(e, false)));
}

function setStatus(state) {
  const text = {
    refreshing: "Refreshing…",
    live: "Live",
    stale: "Offline — showing last known",
    "no-data": "No data yet — check your connection",
  };
  els.status.textContent = text[state] || "";
  els.status.dataset.state = state;
}

async function fetchFresh() {
  const res = await fetch(API_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data || typeof data.vacancies !== "object") {
    throw new Error("malformed response");
  }
  return data;
}

let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  setStatus("refreshing");
  clearInterval(labelTimer);
  labelTimer = null;
  els.refreshLabel.textContent = "checking…";
  try {
    const data = await fetchFresh();
    saveData(data);
    render(data);
    setStatus("live");
  } catch {
    const cached = loadCachedData();
    setStatus(cached ? "stale" : "no-data");
  } finally {
    refreshing = false;
    scheduleNextRefresh();
  }
}

// --- Drag-to-reorder favorites ----------------------------------------------
// Pointer Events (not HTML5 drag-and-drop, which doesn't work on touch). The
// dragged card is re-inserted among its siblings as the pointer moves; on
// release the new DOM order becomes the persisted favorite order.
let dragState = null;

function makeGrip(card, entry) {
  const grip = document.createElement("button");
  grip.className = "grip";
  grip.type = "button";
  grip.textContent = "⠿";
  grip.setAttribute("aria-label", `Reorder ${entry.name}`);

  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragState = { card, pointerId: e.pointerId };
    card.classList.add("dragging");
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {}
  });

  grip.addEventListener("pointermove", (e) => {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const after = dragAfterElement(els.favorites, e.clientY, dragState.card);
    if (after == null) els.favorites.appendChild(dragState.card);
    else els.favorites.insertBefore(dragState.card, after);
  });

  const end = (e) => {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    dragState.card.classList.remove("dragging");
    dragState = null;
    favoriteOrder = [...els.favorites.children].map((c) => c.dataset.id);
    saveFavorites(favoriteOrder);
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);

  return grip;
}

function dragAfterElement(container, y, dragging) {
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
  for (const child of container.children) {
    if (child === dragging) continue;
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      closest = { offset, element: child };
    }
  }
  return closest.element;
}

// --- Pull-to-refresh ---------------------------------------------------------
let pullStartY = null;
let pullDistance = 0;
const PULL_THRESHOLD = 70;

window.addEventListener(
  "touchstart",
  (e) => {
    if (dragState) {
      pullStartY = null;
      return;
    }
    if (window.scrollY === 0 && e.touches.length === 1) {
      pullStartY = e.touches[0].clientY;
    } else {
      pullStartY = null;
    }
  },
  { passive: true }
);

window.addEventListener(
  "touchmove",
  (e) => {
    if (dragState || pullStartY == null) return;
    pullDistance = e.touches[0].clientY - pullStartY;
    if (pullDistance > 0) {
      const shown = Math.min(pullDistance, PULL_THRESHOLD * 1.5);
      els.refreshIndicator.style.height = `${shown}px`;
      els.refreshIndicator.classList.toggle("ready", pullDistance > PULL_THRESHOLD);
    }
  },
  { passive: true }
);

window.addEventListener("touchend", () => {
  if (pullStartY != null && pullDistance > PULL_THRESHOLD) refresh();
  pullStartY = null;
  pullDistance = 0;
  els.refreshIndicator.style.height = "0px";
  els.refreshIndicator.classList.remove("ready");
});

// --- Auto-refresh while visible ----------------------------------------------
// A self-rescheduling timer (not setInterval) so any refresh, manual or timed,
// restarts the countdown, keeping the progress bar in sync with the next fetch.
let pollTimer = null;
let labelTimer = null;
let nextRefreshAt = 0;

function restartProgressBar() {
  const bar = els.progressBar;
  bar.style.transition = "none";
  bar.style.width = "0%";
  void bar.offsetWidth; // reflow so the next transition animates from 0
  bar.style.transition = `width ${REFRESH_INTERVAL_MS}ms linear`;
  bar.style.width = "100%";
}

function stopProgressBar() {
  els.progressBar.style.transition = "none";
  els.progressBar.style.width = "0%";
}

function updateCountdownLabel() {
  const remainingSec = Math.ceil((nextRefreshAt - Date.now()) / 1000);
  els.refreshLabel.textContent = `checking for update in ${Math.max(0, remainingSec)}s`;
}

function scheduleNextRefresh() {
  clearTimeout(pollTimer);
  clearInterval(labelTimer);
  pollTimer = null;
  labelTimer = null;
  if (document.visibilityState !== "visible") return;
  nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
  restartProgressBar();
  updateCountdownLabel();
  labelTimer = setInterval(updateCountdownLabel, 1000);
  pollTimer = setTimeout(refresh, REFRESH_INTERVAL_MS);
}

function stopPolling() {
  clearTimeout(pollTimer);
  clearInterval(labelTimer);
  pollTimer = null;
  labelTimer = null;
  stopProgressBar();
  els.refreshLabel.textContent = "";
}

// --- Baseline stats ----------------------------------------------------------
// Load each shown garage's percentile baselines (cached in IndexedDB and at the
// edge), then re-render so relative colors and comparison labels appear. Best
// effort: a garage whose stats fail to load just stays uncolored.
async function loadStats(ids) {
  const results = await Promise.allSettled(
    ids.map(async (id) => {
      const stats = await getStats(historyDb, API_URL, id);
      statsByGarage.set(id, stats);
    })
  );
  if (results.some((r) => r.status === "fulfilled")) render(lastData);
}

// --- Trend graphs ------------------------------------------------------------
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

async function loadSeries(range, garage) {
  const until = nowSec();
  const since = until - range.span;
  if (range.bucket === "raw") {
    return getRawHistory(historyDb, API_URL, garage, since, until);
  }
  return getBucketedHistory(historyDb, API_URL, garage, range.bucket, since, until);
}

let graphEls = null;

function buildGraphModal() {
  const overlay = document.createElement("div");
  overlay.className = "graph-modal";
  overlay.hidden = true;

  const sheet = document.createElement("div");
  sheet.className = "graph-sheet";

  const head = document.createElement("div");
  head.className = "graph-head";
  const title = document.createElement("span");
  title.className = "graph-title";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "graph-close";
  close.textContent = "✕";
  close.setAttribute("aria-label", "Close");
  head.append(title, close);

  const tabs = document.createElement("div");
  tabs.className = "graph-ranges";
  const rangeButtons = RANGES.map((r) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "graph-range";
    b.textContent = r.label;
    b.dataset.key = r.key;
    tabs.append(b);
    return b;
  });

  const body = document.createElement("div");
  body.className = "graph-body";
  const status = document.createElement("div");
  status.className = "graph-status";
  const legend = document.createElement("div");
  legend.className = "graph-legend";

  sheet.append(head, tabs, body, status, legend);
  overlay.append(sheet);
  document.body.append(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeGraph();
  });
  close.addEventListener("click", closeGraph);

  graphEls = { overlay, title, body, status, legend, rangeButtons };
  return graphEls;
}

let graphGarage = null;

function closeGraph() {
  if (graphEls) graphEls.overlay.hidden = true;
  graphGarage = null;
}

async function showRange(range) {
  const { body, status, legend, rangeButtons } = graphEls;
  for (const b of rangeButtons) {
    b.classList.toggle("active", b.dataset.key === range.key);
  }
  status.textContent = "Loading…";
  legend.textContent = "";
  const garage = graphGarage;
  try {
    const points = await loadSeries(range, garage);
    if (graphGarage !== garage) return; // switched garages mid-load

    const cells = statsByGarage.get(garage)?.cells;
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

function openGraph(entry) {
  const els = graphEls || buildGraphModal();
  graphGarage = entry.id;
  els.title.textContent = entry.name;
  els.overlay.hidden = false;
  for (const b of els.rangeButtons) {
    b.onclick = () => showRange(RANGES.find((r) => r.key === b.dataset.key));
  }
  showRange(RANGES[0]);
}

// --- Lifecycle ---------------------------------------------------------------
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeGraph();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refresh();
  else stopPolling();
});

if ("serviceWorker" in navigator) {
  // When a newly-deployed worker activates and takes control, reload once so
  // the fresh app applies immediately. Guarded against the first install (no
  // prior controller) and against reload loops.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js");
  });
}

// Render immediately from cache so the screen is never blank, then fetch fresh.
const cached = loadCachedData();
if (cached) {
  render(cached, { stale: true });
  setStatus("stale");
} else {
  render(null);
  setStatus("no-data");
}
refresh();

// History is a reader concern, separate from the live snapshot: open the cache,
// top it up from the Worker, and load baseline stats — all best effort, so any
// failure leaves the live view working and cards simply uncolored.
(async () => {
  historyDb = await openHistoryDb();
  requestPersist();
  const ids = garageEntries(cached ? cached.vacancies : {}).map((e) => e.id);
  loadStats(ids);
  try {
    if (historyDb) await syncSamples(historyDb, API_URL);
  } catch {
    /* offline or Worker down: graphs fall back to direct fetches */
  }
})();
