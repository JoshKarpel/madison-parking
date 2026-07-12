import { GARAGES } from "./garages.js";

const API_URL = "https://madison-parking.josh-karpel.workers.dev";

// Color thresholds for raw vacancy counts (no capacity data exists upstream).
// count > green   -> plenty of spots
// count > amber   -> filling up
// otherwise       -> nearly full
const THRESHOLDS = { green: 150, amber: 50 };

const STORAGE_KEYS = {
  data: "parking:data",
  favorites: "parking:favorites",
};

const els = {
  modified: document.getElementById("modified"),
  status: document.getElementById("status"),
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
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function saveFavorites(favorites) {
  localStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify([...favorites]));
}

let favorites = loadFavorites();

function colorClass(count) {
  if (count == null) return "unavailable";
  if (count > THRESHOLDS.green) return "green";
  if (count > THRESHOLDS.amber) return "amber";
  return "red";
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
    .map((id) => {
      const known = GARAGES[id];
      const raw = vacancies ? vacancies[id] : undefined;
      const count = typeof raw === "number" ? raw : null;
      return {
        id,
        name: known ? known.name : `Ramp ${id}`,
        short: known ? known.short : `Ramp ${id}`,
        count,
      };
    })
    .sort((a, b) => Number(a.id) - Number(b.id));
}

function makeCard(entry, isFavorite) {
  const card = document.createElement("div");
  card.className = `card ${colorClass(entry.count)}`;

  const star = document.createElement("button");
  star.className = "star";
  star.type = "button";
  star.textContent = isFavorite ? "★" : "☆";
  star.setAttribute(
    "aria-label",
    isFavorite ? `Unfavorite ${entry.name}` : `Favorite ${entry.name}`
  );
  star.setAttribute("aria-pressed", String(isFavorite));
  star.addEventListener("click", () => toggleFavorite(entry.id));

  const name = document.createElement("div");
  name.className = "name";
  name.textContent = entry.name;

  const count = document.createElement("div");
  count.className = "count";
  count.textContent = entry.count == null ? "—" : String(entry.count);

  const label = document.createElement("div");
  label.className = "count-label";
  label.textContent = entry.count == null ? "unavailable" : "spots";

  card.append(star, name, count, label);
  return card;
}

function toggleFavorite(id) {
  if (favorites.has(id)) favorites.delete(id);
  else favorites.add(id);
  saveFavorites(favorites);
  const data = loadCachedData();
  if (data) render(data);
}

function render(data, { stale = false } = {}) {
  els.modified.textContent = data && data.modified ? data.modified : "unknown";

  const entries = garageEntries(data ? data.vacancies : {});
  const favEntries = entries.filter((e) => favorites.has(e.id));
  const otherEntries = entries.filter((e) => !favorites.has(e.id));

  els.favorites.replaceChildren(
    ...favEntries.map((e) => makeCard(e, true))
  );
  els.favoritesEmpty.hidden = favEntries.length > 0;

  els.others.replaceChildren(
    ...otherEntries.map((e) => makeCard(e, false))
  );
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
  }
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

// --- Lifecycle ---------------------------------------------------------------
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refresh();
});

if ("serviceWorker" in navigator) {
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
