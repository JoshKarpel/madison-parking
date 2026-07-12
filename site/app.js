import { GARAGES } from "./garages.js";
import {
  openHistoryDb,
  reconcileBuildVersion,
  requestPersist,
  syncSamples,
  getStats,
  getRecentSamples,
  computeTrend,
  statsFreshness,
  humanizeAgo,
  nowSec,
  DAY_SECONDS,
} from "./history.js";
import { BUILD_ID } from "./version.js";
import {
  classifyFullness,
  occupancyPercent,
  comparisonLabel,
  forecastLabel,
  localCell,
  cellKey,
} from "./coloring.js";
import { createGraphView } from "./graph.js";

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

// Window of recently-synced samples the per-card trend indicator reads over.
// The feed updates every 1-4 min, so 30 min holds ~10-20 samples: enough for the
// relative threshold to smooth jitter, short enough to reflect "right now".
const TREND_WINDOW_SECONDS = 30 * 60;

const TREND_TEXT = {
  filling: "▼ filling up",
  emptying: "▲ emptying out",
  steady: "≈ holding steady",
};

// The chart toggle emoji mirrors the vacancy trend: emptying out means more open
// spots (line rising), filling up means fewer (line falling), steady is flat.
// No recent trend falls back to the neutral wavy dash.
const TREND_EMOJI = {
  filling: "📉",
  emptying: "📈",
  steady: "〰️",
};

const STORAGE_KEYS = {
  data: "parking:data",
  order: "parking:order",
  minimized: "parking:minimized",
};

const els = {
  modified: document.getElementById("modified"),
  modifiedAgo: document.getElementById("modified-ago"),
  status: document.getElementById("status"),
  progressBar: document.getElementById("refresh-progress-bar"),
  refreshLabel: document.getElementById("refresh-label"),
  cards: document.getElementById("cards"),
  refreshIndicator: document.getElementById("refresh-indicator"),
  statsStatus: document.getElementById("stats-status"),
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
  try {
    localStorage.setItem(STORAGE_KEYS.data, JSON.stringify(data));
  } catch {
    /* quota exceeded or storage blocked (private mode): keep the live view. */
  }
}

function loadIds(key) {
  try {
    const raw = localStorage.getItem(key);
    const ids = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch {
    return [];
  }
}

function saveIds(key, ids) {
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    /* quota exceeded or storage blocked: the in-memory state still applies. */
  }
}

// One user-adjustable ordering over every garage (the up/down arrows reorder it)
// plus the set the user has minimized. Minimized garages render as compact rows
// below the full cards; both orderings persist across sessions.
let cardOrder = loadIds(STORAGE_KEYS.order);
const minimizedIds = new Set(loadIds(STORAGE_KEYS.minimized));

function saveOrder() {
  saveIds(STORAGE_KEYS.order, cardOrder);
}

function saveMinimized() {
  saveIds(STORAGE_KEYS.minimized, [...minimizedIds]);
}

// Give every shown garage a slot in the ordering, appending newly-seen IDs in
// the feed's ascending order so a new ramp lands at the end rather than vanishing.
function reconcileOrder(ids) {
  let changed = false;
  for (const id of ids) {
    if (!cardOrder.includes(id)) {
      cardOrder.push(id);
      changed = true;
    }
  }
  if (changed) saveOrder();
}

// The active (non-minimized) IDs in display order, from the last rendered data.
function activeIdsNow() {
  const shown = new Set(
    garageEntries(lastData ? lastData.vacancies : {}).map((e) => e.id)
  );
  return cardOrder.filter((id) => shown.has(id) && !minimizedIds.has(id));
}

// History cache (opened at startup) and per-garage baseline stats, both filled
// asynchronously. Until stats arrive, cards render uncolored.
let historyDb = null;
const statsByGarage = new Map();
const trendByGarage = new Map();

// The garage whose card is currently expanded into its trend view (at most one),
// and the reusable view element it mounts. Injects the Worker URL and getters
// for the async-filled history db and each garage's baseline cells.
let expandedId = null;
const graphView = createGraphView({
  apiUrl: API_URL,
  getHistoryDb: () => historyDb,
  getCells: (id) => cellsFor(id),
});

function toggleExpanded(id) {
  expandedId = expandedId === id ? null : id;
  if (expandedId === null) graphView.reset();
  render(lastData);
}

// All of a garage's baseline cells, or null until its stats have loaded.
function cellsFor(id) {
  const stats = statsByGarage.get(id);
  return stats && stats.cells ? stats.cells : null;
}

// A garage's estimated total capacity, or null until stats have loaded (or if the
// Worker has no estimate for it yet). Drives the fullness color and "% full".
function capacityFor(id) {
  const stats = statsByGarage.get(id);
  return stats && typeof stats.capacity === "number" ? stats.capacity : null;
}

// The (day_of_week, hour) baseline cell that applies to a garage right now.
function currentCell(id) {
  const cells = cellsFor(id);
  if (!cells) return null;
  const { dow, hour } = localCell(new Date());
  return cells[cellKey(dow, hour)] || null;
}

// The headline color band: how full the garage is against its estimated capacity
// ("could I park here right now?"). Null when there's no count or no capacity
// estimate yet, which renders the card uncolored.
function bandFor(count, id) {
  return classifyFullness(count, capacityFor(id));
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

function bandClassFor(entry) {
  if (entry.count == null) return "unavailable";
  const band = bandFor(entry.count, entry.id);
  return band ? `band-${band.band}` : "";
}

function countText(entry) {
  return entry.count == null ? "—" : String(entry.count);
}

// A minimized garage: a compact one-line row (the whole row is a button that
// restores it to a full card). It sits below the full cards, in list order.
function makeMinimizedCard(entry) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = `card minimized ${bandClassFor(entry)}`.trim();
  row.dataset.id = entry.id;
  row.setAttribute("aria-label", `Restore ${entry.name}`);

  const icon = document.createElement("span");
  icon.className = "restore-icon";
  icon.textContent = "＋";

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = entry.name;

  const count = document.createElement("span");
  count.className = "count";
  count.textContent = countText(entry);

  row.append(icon, name, count);
  row.addEventListener("click", () => restoreCard(entry.id));
  return row;
}

function makeCard(entry, { minimized, index, total }) {
  if (minimized) return makeMinimizedCard(entry);

  const card = document.createElement("div");
  card.className = `card ${bandClassFor(entry)}`.trim();
  if (entry.id === expandedId) card.classList.add("expanded");
  card.dataset.id = entry.id;

  // The summary holds the count and every corner control, and is the controls'
  // positioning context. The inline graph mounts as the card's next child, below
  // the summary, so expanding the card doesn't move the controls (they stay
  // anchored to the summary, not the taller card).
  const summary = document.createElement("div");
  summary.className = "card-summary";

  const minimize = document.createElement("button");
  minimize.className = "minimize";
  minimize.type = "button";
  minimize.textContent = "−";
  minimize.setAttribute("aria-label", `Minimize ${entry.name}`);
  minimize.addEventListener("click", () => minimizeCard(entry.id));

  const name = document.createElement("div");
  name.className = "name";
  name.textContent = entry.name;

  const count = document.createElement("div");
  count.className = "count";
  count.textContent = countText(entry);

  const label = document.createElement("div");
  label.className = "count-label";
  label.textContent = entry.count == null ? "unavailable" : "spots";

  summary.append(minimize, name);

  if (entry.note) {
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = entry.note;
    summary.append(note);
  }

  summary.append(count, label);

  // Estimated fullness against the garage's high-water capacity estimate — the
  // headline "could I park here?" figure. Labeled an estimate; absent (like the
  // color) until a capacity estimate exists for this garage.
  const occupancy = occupancyPercent(entry.count, capacityFor(entry.id));
  if (occupancy != null) {
    card.style.setProperty("--fill", `${occupancy}%`);
    const el = document.createElement("div");
    el.className = "fullness";
    el.textContent = `≈${occupancy}% full (est.)`;
    summary.append(el);
  }

  // Short-term direction from recently-synced samples: filling up, emptying out,
  // or holding steady right now.
  const trend = trendByGarage.get(entry.id);
  if (entry.count != null && trend) {
    const el = document.createElement("div");
    el.className = `trend trend-${trend.direction}`;
    el.textContent = TREND_TEXT[trend.direction];
    summary.append(el);
  }

  // How this count compares to the garage's own history for this day and hour,
  // when there's enough history to say. Otherwise nothing (no guessing).
  const comparison = comparisonLabel(entry.count, currentCell(entry.id), new Date());
  if (comparison) {
    const el = document.createElement("div");
    el.className = "comparison";
    el.textContent = comparison;
    summary.append(el);
  }

  // A forward-looking heads-up ("usually busiest around 6pm"), when the baseline
  // says today typically tightens later. Null (nothing shown) otherwise.
  const forecast = forecastLabel(cellsFor(entry.id), new Date());
  if (forecast) {
    const el = document.createElement("div");
    el.className = "forecast";
    el.textContent = forecast;
    summary.append(el);
  }

  // Reorder with up/down arrows in the left corners, disabled at the ends of
  // the active list (only meaningful when there's more than one card).
  if (total > 1) {
    summary.append(
      makeMove(entry, -1, "▲", "up", index === 0),
      makeMove(entry, 1, "▼", "down", index === total - 1)
    );
  }

  // Garages with a known address get a Google Maps link in the top-right
  // corner; unmapped ramps have no known location, so no link.
  if (entry.address) summary.append(makeMapLink(entry));

  // The chart toggle sits in the bottom-right corner; tapping it opens/closes
  // the trend view inline in place.
  summary.append(makeGraphToggle(entry));

  card.append(summary);

  // When expanded, the trend view mounts into the card below the summary.
  if (entry.id === expandedId) card.append(graphView.mount(entry));

  return card;
}

function makeGraphToggle(entry) {
  const btn = document.createElement("button");
  btn.className = "graph-toggle";
  btn.type = "button";
  const trend = trendByGarage.get(entry.id);
  btn.textContent = (trend && TREND_EMOJI[trend.direction]) || TREND_EMOJI.steady;
  const expanded = entry.id === expandedId;
  btn.setAttribute("aria-expanded", String(expanded));
  btn.setAttribute(
    "aria-label",
    `${expanded ? "Hide" : "Show"} ${entry.name} trend`
  );
  btn.addEventListener("click", () => toggleExpanded(entry.id));
  return btn;
}

function makeMove(entry, delta, glyph, direction, atEnd) {
  const btn = document.createElement("button");
  btn.className = `move move-${direction}`;
  btn.type = "button";
  btn.textContent = glyph;
  btn.disabled = atEnd;
  btn.setAttribute("aria-label", `Move ${entry.name} ${direction}`);
  btn.addEventListener("click", () => moveCard(entry.id, delta));
  return btn;
}

function makeMapLink(entry) {
  const link = document.createElement("a");
  link.className = "maplink";
  link.href = mapsUrl(entry.address);
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "🗺️";
  link.setAttribute("aria-label", `Open ${entry.name} in Google Maps`);
  return link;
}

function minimizeCard(id) {
  minimizedIds.add(id);
  saveMinimized();
  if (expandedId === id) {
    expandedId = null;
    graphView.reset();
  }
  render(lastData);
}

function restoreCard(id) {
  minimizedIds.delete(id);
  saveMinimized();
  // Send it to the end of the order so it lands at the bottom of the full cards
  // (minimized rows filter out of the active list, so an end slot is last there).
  const i = cardOrder.indexOf(id);
  if (i >= 0) {
    cardOrder.splice(i, 1);
    cardOrder.push(id);
    saveOrder();
  }
  render(lastData);
}

// The most recently rendered snapshot, so late-arriving stats can re-render the
// same data (recoloring cards) without re-reading storage and racing a refresh.
let lastData = null;

function render(data) {
  lastData = data;
  els.modified.textContent = formatUpdated(data);
  updateModifiedAgo();

  const entries = garageEntries(data ? data.vacancies : {});
  const byId = new Map(entries.map((e) => [e.id, e]));
  reconcileOrder(entries.map((e) => e.id));

  const shown = cardOrder.filter((id) => byId.has(id));
  const active = shown.filter((id) => !minimizedIds.has(id));
  const minimized = shown.filter((id) => minimizedIds.has(id));

  els.cards.replaceChildren(
    ...active.map((id, i) =>
      makeCard(byId.get(id), { minimized: false, index: i, total: active.length })
    ),
    ...minimized.map((id) => makeCard(byId.get(id), { minimized: true }))
  );
}

// The "Updated" timestamp, localized to the viewer from the Worker's machine
// epoch: time only when it's today, date and time otherwise (so stale data that
// crossed midnight reads unambiguously). "unknown" when the epoch is absent (no
// data yet, unparseable upstream, or a cached snapshot from before `observed_at`
// existed); the client works solely from the epoch, never the `modified` string.
function formatUpdated(data) {
  if (!data || typeof data.observed_at !== "number") return "unknown";
  const when = new Date(data.observed_at * 1000);
  const now = new Date();
  const isToday =
    when.getFullYear() === now.getFullYear() &&
    when.getMonth() === now.getMonth() &&
    when.getDate() === now.getDate();
  const options = isToday
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  return when.toLocaleString(undefined, options);
}

// Relative trailer after the timestamp, from the Worker-supplied machine epoch.
// Refreshed on each render and on the per-second countdown tick so it advances
// between the data refreshes without waiting for the next fetch.
function updateModifiedAgo() {
  const observedAt =
    lastData && typeof lastData.observed_at === "number" ? lastData.observed_at : null;
  els.modifiedAgo.textContent = observedAt ? ` (${humanizeAgo(nowSec() - observedAt)})` : "";
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
    refreshHistory();
  } catch {
    const cached = loadCachedData();
    setStatus(cached ? "stale" : "no-data");
  } finally {
    refreshing = false;
    scheduleNextRefresh();
  }
}

// --- Reorder cards -----------------------------------------------------------
// Swap an active card with its neighbor in the given direction (delta -1 up, +1
// down) by swapping their positions in the master order, leaving minimized cards
// untouched. The end cards' out-of-range arrow is disabled, so this stays in
// bounds.
function moveCard(id, delta) {
  const active = activeIdsNow();
  const ai = active.indexOf(id);
  const aj = ai + delta;
  if (ai < 0 || aj < 0 || aj >= active.length) return;
  const i = cardOrder.indexOf(id);
  const j = cardOrder.indexOf(active[aj]);
  [cardOrder[i], cardOrder[j]] = [cardOrder[j], cardOrder[i]];
  saveOrder();
  render(lastData);
}

// --- Pull-to-refresh ---------------------------------------------------------
let pullStartY = null;
let pullDistance = 0;
const PULL_THRESHOLD = 70;

window.addEventListener(
  "touchstart",
  (e) => {
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
    if (pullStartY == null) return;
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
  updateModifiedAgo();
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
  renderStatsStatus();
}

// The newest baseline rebuild across all loaded garages. The weekly cron stamps
// every garage with the same time, so the max is the last stats update; 0 until
// any stats load.
function newestStatsGeneratedAt() {
  let newest = 0;
  for (const stats of statsByGarage.values()) {
    const generatedAt = stats && stats.generated_at;
    if (typeof generatedAt === "number" && generatedAt > newest) newest = generatedAt;
  }
  return newest;
}

function agoLabel(ageSeconds) {
  const days = Math.floor(ageSeconds / DAY_SECONDS);
  if (days <= 0) return "today";
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

// Footer line reporting when the baselines were last rebuilt, flagged stale (the
// weekly cron has likely stopped) past STATS_STALE_SECONDS. Empty until stats
// load, so it never claims a freshness it can't back up.
function renderStatsStatus() {
  const freshness = statsFreshness(newestStatsGeneratedAt(), nowSec());
  const el = els.statsStatus;
  if (!freshness) {
    el.textContent = "";
    el.classList.remove("stale");
    return;
  }
  const when = new Date(freshness.generatedAt * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const ago = agoLabel(freshness.ageSeconds);
  el.classList.toggle("stale", freshness.stale);
  el.textContent = freshness.stale
    ? `⚠️ Stats last updated ${when} (${ago}) — updates may have stopped.`
    : `Stats updated ${when} (${ago}).`;
}

// --- Recent trend ------------------------------------------------------------
// Derive each shown garage's short-term direction from locally-synced samples,
// then re-render so the indicators appear/update. Best effort: a garage with too
// few recent samples shows none.
async function loadTrends(ids) {
  if (!historyDb) return;
  const since = nowSec() - TREND_WINDOW_SECONDS;
  await Promise.all(
    ids.map(async (id) => {
      const trend = computeTrend(await getRecentSamples(historyDb, id, since));
      if (trend) trendByGarage.set(id, trend);
      else trendByGarage.delete(id);
    })
  );
  render(lastData);
}

function shownGarageIds() {
  return garageEntries(lastData ? lastData.vacancies : {}).map((e) => e.id);
}

// Keep the local sample cache (and thus the trend indicators) current: top up
// from the Worker, then recompute trends. A reader concern kept off the
// live-snapshot path, guarded so overlapping refreshes don't stack syncs.
let historySyncing = false;
async function refreshHistory() {
  if (!historyDb || historySyncing) return;
  historySyncing = true;
  try {
    await syncSamples(historyDb, API_URL);
    await loadTrends(shownGarageIds());
  } catch {
    /* offline or Worker down: trends just hold their last values */
  } finally {
    historySyncing = false;
  }
}

// --- Lifecycle ---------------------------------------------------------------
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

  let swRegistration = null;
  window.addEventListener("load", async () => {
    swRegistration = await navigator.serviceWorker.register("./sw.js");
  });

  // Registration only checks for a new worker once, so a long-open session
  // wouldn't notice a deploy until it was closed and reopened. Re-check when the
  // tab is refocused, throttled so quick focus toggles don't each hit the
  // network: a no-op update() is one small conditional GET of sw.js, and a
  // changed worker installs and triggers the controllerchange reload above. This
  // is a control-plane concern, kept off the 60s data-refresh path.
  const UPDATE_CHECK_MIN_INTERVAL_MS = 30 * 60_000;
  let lastUpdateCheck = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !swRegistration) return;
    const now = Date.now();
    if (now - lastUpdateCheck < UPDATE_CHECK_MIN_INTERVAL_MS) return;
    lastUpdateCheck = now;
    swRegistration.update().catch(() => {});
  });
}

// Render immediately from cache so the screen is never blank, then fetch fresh.
const cached = loadCachedData();
if (cached) {
  render(cached);
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
  await reconcileBuildVersion(historyDb, BUILD_ID);
  requestPersist();
  const ids = garageEntries(cached ? cached.vacancies : {}).map((e) => e.id);
  loadStats(ids);
  // Top up the local sample cache and compute the initial trend indicators.
  // Best effort: offline or Worker-down leaves graphs to fall back to direct
  // fetches and the cards simply show no trend.
  await refreshHistory();
})();
