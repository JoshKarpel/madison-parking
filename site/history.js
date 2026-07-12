// Client-side history cache and Worker history API, in one module.
//
// IndexedDB holds raw 5-minute samples synced forward from the Worker, plus an
// offline cache of server-side bucket aggregates and the /stats baselines.
// Everything degrades: if IndexedDB is unavailable or a fetch fails, callers
// fall back to hitting the Worker directly, and the app still renders.

const DB_NAME = "madison-parking-history";
const DB_VERSION = 1;

const STORE_SAMPLES = "samples"; // keyPath [garage_id, ts]; raw counts
const STORE_BUCKETS = "buckets"; // keyPath [garage_id, kind, ts]; server aggregates
const STORE_META = "meta"; // keyPath "key"; stats cache + flags

export const DAY_SECONDS = 86400;
const RETENTION_SECONDS = 365 * DAY_SECONDS;
const STATS_TTL_SECONDS = 6 * 60 * 60;

// On a cold start we don't pull a year of raw (~100k rows/garage); we sync raw
// only for this trailing window and let bucketed queries cover older ranges.
const COLD_START_RAW_SECONDS = 7 * DAY_SECONDS;

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// --- open --------------------------------------------------------------------

// Resolves to an IDBDatabase, or null if IndexedDB is unavailable/blocked. A
// null return is a supported state: every consumer falls back to the network.
export function openHistoryDb() {
  return new Promise((resolve) => {
    if (!("indexedDB" in globalThis)) return resolve(null);
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_SAMPLES)) {
        const s = db.createObjectStore(STORE_SAMPLES, {
          keyPath: ["garage_id", "ts"],
        });
        s.createIndex("ts", "ts");
      }
      if (!db.objectStoreNames.contains(STORE_BUCKETS)) {
        db.createObjectStore(STORE_BUCKETS, {
          keyPath: ["garage_id", "kind", "ts"],
        });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

// --- persistence -------------------------------------------------------------

// Ask the browser to keep this origin's storage from being evicted under
// pressure. Returns the granted state; a denial is fine, it just means the
// cache may be cleared and re-synced later.
export async function requestPersist() {
  if (!navigator.storage || !navigator.storage.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

// --- raw samples -------------------------------------------------------------

export async function getMaxSampleTs(db) {
  const index = tx(db, STORE_SAMPLES, "readonly").index("ts");
  const cursor = await done(index.openCursor(null, "prev"));
  return cursor ? cursor.value.ts : 0;
}

async function putSamples(db, samples) {
  if (samples.length === 0) return;
  const store = tx(db, STORE_SAMPLES, "readwrite");
  for (const [garage_id, ts, available] of samples) {
    store.put({ garage_id, ts, available });
  }
  await txDone(store.transaction);
}

export async function pruneOldSamples(db, cutoff) {
  const index = tx(db, STORE_SAMPLES, "readwrite").index("ts");
  const range = IDBKeyRange.upperBound(cutoff, true);
  const cursor = index.openCursor(range);
  await new Promise((resolve, reject) => {
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return resolve();
      c.delete();
      c.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
}

async function getRawRange(db, garage, since, until) {
  const store = tx(db, STORE_SAMPLES, "readonly");
  const range = IDBKeyRange.bound([garage, since], [garage, until], false, true);
  const rows = await done(store.getAll(range));
  return rows.map((r) => ({ ts: r.ts, avg: r.available }));
}

// --- sync --------------------------------------------------------------------

// Pull every garage's raw samples newer than what we already have. On a cold
// start (empty store) we only ask for the trailing raw window. Prunes anything
// past retention afterward. No-op (returns 0) if the db is null.
export async function syncSamples(db, apiUrl) {
  if (!db) return 0;
  const maxTs = await getMaxSampleTs(db);
  let since = maxTs > 0 ? maxTs : nowSec() - COLD_START_RAW_SECONDS;

  let inserted = 0;
  // Follow pagination: the Worker caps rows per page and reports `complete`.
  for (let page = 0; page < 100; page++) {
    const res = await fetch(
      `${apiUrl}/history/sync?since=${since}`,
      { cache: "no-store" }
    );
    if (!res.ok) throw new Error(`sync HTTP ${res.status}`);
    const body = await res.json();
    const samples = Array.isArray(body.samples) ? body.samples : [];
    await putSamples(db, samples);
    inserted += samples.length;
    if (body.complete || samples.length === 0) break;
    since = body.until;
  }

  await pruneOldSamples(db, nowSec() - RETENTION_SECONDS);
  return inserted;
}

// --- bucketed history (for week/month/year graphs) ---------------------------

async function fetchBuckets(apiUrl, garage, kind, since, until) {
  const url = `${apiUrl}/history?garage=${encodeURIComponent(garage)}&since=${since}&until=${until}&bucket=${kind}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`history HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body.points) ? body.points : [];
}

async function putBuckets(db, garage, kind, points) {
  if (!db || points.length === 0) return;
  const store = tx(db, STORE_BUCKETS, "readwrite");
  for (const p of points) {
    store.put({ garage_id: garage, kind, ts: p.ts, avg: p.avg, min: p.min, max: p.max, n: p.n });
  }
  await txDone(store.transaction);
}

async function getBucketRange(db, garage, kind, since, until) {
  if (!db) return [];
  const store = tx(db, STORE_BUCKETS, "readonly");
  const range = IDBKeyRange.bound(
    [garage, kind, since],
    [garage, kind, until],
    false,
    true
  );
  return done(store.getAll(range));
}

// Server aggregates for a garage/range. Fetches fresh (they're small and
// edge-cached), refreshes the offline cache, and falls back to the cache when
// offline. Points are {ts, avg, min, max, n}.
export async function getBucketedHistory(db, apiUrl, garage, kind, since, until) {
  try {
    const points = await fetchBuckets(apiUrl, garage, kind, since, until);
    await putBuckets(db, garage, kind, points);
    return points;
  } catch (err) {
    const cached = await getBucketRange(db, garage, kind, since, until);
    if (cached.length) return cached;
    throw err;
  }
}

// Raw samples for a garage/range. Prefers the local store; falls back to the
// Worker's raw endpoint if the db is empty or unavailable. Points are {ts, avg}.
export async function getRawHistory(db, apiUrl, garage, since, until) {
  if (db) {
    const local = await getRawRange(db, garage, since, until);
    if (local.length) return local;
  }
  return fetchBuckets(apiUrl, garage, "raw", since, until);
}

// --- stats baselines ---------------------------------------------------------

// Per-(day_of_week, hour) percentile baselines for relative coloring. Cached in
// IndexedDB for STATS_TTL_SECONDS; refetched past that. Falls back to the cached
// copy (even if stale) when offline, and to a bare network fetch with no db.
export async function getStats(db, apiUrl, garage) {
  const key = `stats:${garage}`;
  let cached = null;
  if (db) {
    cached = await done(tx(db, STORE_META, "readonly").get(key));
    if (cached && nowSec() - cached.fetchedAt < STATS_TTL_SECONDS) {
      return cached.stats;
    }
  }
  try {
    const res = await fetch(`${apiUrl}/stats?garage=${encodeURIComponent(garage)}`);
    if (!res.ok) throw new Error(`stats HTTP ${res.status}`);
    const stats = await res.json();
    if (db) {
      const store = tx(db, STORE_META, "readwrite");
      store.put({ key, fetchedAt: nowSec(), stats });
      await txDone(store.transaction);
    }
    return stats;
  } catch (err) {
    if (cached) return cached.stats;
    throw err;
  }
}
