import { GARAGES } from "./garages.js";

const API_URL = "https://madison-parking.josh-karpel.workers.dev";

// Color thresholds for raw vacancy counts (no capacity data exists upstream).
// count > green   -> plenty of spots
// count > amber   -> filling up
// otherwise       -> nearly full
const THRESHOLDS = { green: 150, amber: 50 };

// IDs that appear in the upstream feed but we don't want to show (e.g. ID 9,
// which the city's data reports but which isn't in their public garage table).
const HIDDEN_IDS = new Set(["9"]);

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
  card.className = `card ${colorClass(entry.count)}`;
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

  if (entry.note) {
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = entry.note;
    card.append(note);
  }

  // Favorites can be dragged to reorder, via a grip handle.
  if (favorited) card.append(makeGrip(card, entry));

  return card;
}

function toggleFavorite(id) {
  const i = favoriteOrder.indexOf(id);
  if (i >= 0) favoriteOrder.splice(i, 1);
  else favoriteOrder.push(id);
  saveFavorites(favoriteOrder);
  render(loadCachedData());
}

function render(data, { stale = false } = {}) {
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

// --- Lifecycle ---------------------------------------------------------------
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refresh();
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
