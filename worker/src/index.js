const UPSTREAM = "https://www.cityofmadison.com/parking/data/ramp-availability.json";

// Cache the upstream response this long inside the Worker/edge, so we don't
// hammer the city. They update every couple of minutes.
const UPSTREAM_CACHE_TTL_SECONDS = 60;

// How long the browser may reuse the current-snapshot response.
const CLIENT_MAX_AGE_SECONDS = 30;

// The feed reports its "modified" time as naive local Madison time. Everything
// stored and served is UTC epoch seconds; conversions go through this zone.
const FEED_TZ = "America/Chicago";

// Baselines are built from ALL retained history (the 5-year retention is the
// effective window), not a trailing slice. Recurring yearly and seasonal events
// (a summer farmer's market, an annual festival) only recur a handful of times
// across several years, so the extreme low tail (p01, event-level packing) needs
// every year we have to be stable. This is why the rebuild is weekly, not daily:
// reading all history per garage is the expensive part, and a multi-year
// baseline changes negligibly week to week.
const STATS_CACHE_TTL_SECONDS = 6 * 60 * 60;

// Max span (in seconds) a client may request per bucket, so it can't ask us to
// scan or ship an absurd number of points. Raw is per-sample; hour/day are
// aggregated in SQL.
const RANGE_CAP_SECONDS = {
  raw: 8 * 86400,
  hour: 400 * 86400,
  day: 6 * 365 * 86400,
};

// Most rows (not a duration) we'll ever return from one history/sync page.
const SYNC_PAGE_LIMIT_ROWS = 20000;

// Retention backstop: the cron drops samples older than this so the table can't
// grow without bound. Five years is far longer than any graph range; it exists
// only to cap storage, not to shape the data.
const RETENTION_SECONDS = 5 * 365 * 86400;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, 405);
    }

    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/history":
          return await handleHistory(url, env);
        case "/history/sync":
          return await handleSync(url, env);
        case "/stats":
          return await handleStats(url, env);
        default:
          return await handleSnapshot();
      }
    } catch (err) {
      return json({ error: "internal error", detail: String(err) }, 500);
    }
  },

  // Two cron rates share this handler; event.cron says which fired. The
  // every-minute cron samples the feed (feed-derived ts + INSERT OR IGNORE keep
  // it idempotent). The daily cron does the slow maintenance off the request
  // path: prune past-retention samples and rebuild the /stats baselines.
  async scheduled(event, env, ctx) {
    if (cronAction(event.cron) === "maintain") {
      ctx.waitUntil(pruneOldSamples(env, event.scheduledTime));
      ctx.waitUntil(rebuildStats(env, event.scheduledTime));
    } else {
      ctx.waitUntil(collectSample(env));
    }
  },
};

// --- Current snapshot (unchanged behavior) -----------------------------------

async function handleSnapshot() {
  const upstream = await fetch(UPSTREAM, {
    cf: { cacheTtl: UPSTREAM_CACHE_TTL_SECONDS, cacheEverything: true },
  });
  if (!upstream.ok) {
    return json(
      { error: "upstream returned an error", status: upstream.status },
      502
    );
  }
  const data = await upstream.json();
  return json(data, 200, {
    "Cache-Control": `public, max-age=${CLIENT_MAX_AGE_SECONDS}`,
  });
}

// --- Collection --------------------------------------------------------------

async function collectSample(env) {
  const upstream = await fetch(UPSTREAM, { cf: { cacheTtl: 0 } });
  if (!upstream.ok) {
    console.log(`collect: upstream ${upstream.status}, skipping tick`);
    return;
  }
  const data = await upstream.json();
  const vacancies = data && data.vacancies;
  if (!vacancies || typeof vacancies !== "object") {
    console.log("collect: malformed feed, no vacancies object");
    return;
  }

  // We trust the feed's own timestamp. If they stop advancing it, our idempotent
  // INSERT OR IGNORE simply records nothing new — that's the feed's problem, not
  // ours to paper over with a fabricated clock time. Only a genuinely
  // unparseable timestamp leaves us no idempotency key, so we skip the tick.
  const ts = parseFeedModified(data.modified);
  if (ts == null) {
    console.log(`collect: unparseable modified ${JSON.stringify(data.modified)}, skipping tick`);
    return;
  }

  const rows = Object.entries(vacancies).filter(
    ([, available]) => Number.isFinite(available)
  );
  if (rows.length === 0) return;

  const insert = env.madison_parking.prepare(
    "INSERT OR IGNORE INTO samples (garage_id, observed_at, available_spaces) VALUES (?, ?, ?)"
  );
  await env.madison_parking.batch(
    rows.map(([garageId, available]) => insert.bind(garageId, ts, available))
  );
}

// The weekly cron carries maintenance (prune + stats rebuild); every other tick
// just collects. Weekly, not daily: the rebuild scans all retained history per
// garage (millions of rows at steady state), and a multi-year baseline changes
// negligibly week to week, so a weekly scan stays comfortably inside D1's
// free-tier read budget. Must match the second entry in wrangler.toml's crons.
const MAINTENANCE_CRON = "30 4 * * 0";
function cronAction(cron) {
  return cron === MAINTENANCE_CRON ? "maintain" : "collect";
}

function retentionCutoffSec(scheduledTimeMs) {
  return Math.floor(scheduledTimeMs / 1000) - RETENTION_SECONDS;
}

async function pruneOldSamples(env, scheduledTimeMs) {
  const cutoff = retentionCutoffSec(scheduledTimeMs);
  const { meta } = await env.madison_parking
    .prepare("DELETE FROM samples WHERE observed_at < ?")
    .bind(cutoff)
    .run();
  if (meta.changes) {
    console.log(`prune: deleted ${meta.changes} samples older than ${cutoff}`);
  }
}

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

// "July 12, 2026 – 10:05am" (en-dash U+2013 or hyphen) -> UTC epoch seconds,
// interpreting the wall-clock time in America/Chicago. Returns null if unparseable.
function parseFeedModified(modified) {
  if (typeof modified !== "string") return null;
  const m = modified
    .trim()
    .match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+[–—-]\s+(\d{1,2}):(\d{2})\s*([ap]m)$/i);
  if (!m) return null;

  const month = MONTHS[m[1].toLowerCase()];
  if (month === undefined) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  let hour = Number(m[4]);
  const minute = Number(m[5]);
  const meridiem = m[6].toLowerCase();
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (meridiem === "pm" && hour !== 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  return wallTimeToEpochSec(year, month, day, hour, minute, FEED_TZ);
}

// --- Time-zone helpers -------------------------------------------------------

// Offset (seconds) to ADD to a UTC instant to get local wall-clock time in tz,
// at that instant. Negative for America/Chicago (behind UTC).
function zoneOffsetSec(utcSec, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  });
  const parts = {};
  for (const p of dtf.formatToParts(new Date(utcSec * 1000))) {
    parts[p.type] = p.value;
  }
  const asUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return Math.round(asUTC / 1000) - utcSec;
}

// Naive local wall-clock time in tz -> UTC epoch seconds, DST-correct. The
// offset depends on the instant we're solving for, so we apply it twice to
// converge across a DST boundary.
function wallTimeToEpochSec(year, month, day, hour, minute, tz) {
  const naiveUTC = Math.floor(Date.UTC(year, month, day, hour, minute) / 1000);
  let guess = naiveUTC - zoneOffsetSec(naiveUTC, tz);
  guess = naiveUTC - zoneOffsetSec(guess, tz);
  return guess;
}

// UTC epoch seconds -> local (day_of_week 0=Sun..6=Sat, hour 0..23) in tz.
// Memoized per calendar day to keep it cheap across tens of thousands of rows.
function makeLocalCellResolver(tz) {
  const offsetByDay = new Map();
  return (utcSec) => {
    const dayKey = Math.floor(utcSec / 86400);
    let offset = offsetByDay.get(dayKey);
    if (offset === undefined) {
      offset = zoneOffsetSec(utcSec, tz);
      offsetByDay.set(dayKey, offset);
    }
    const local = new Date((utcSec + offset) * 1000);
    return { dow: local.getUTCDay(), hour: local.getUTCHours() };
  };
}

// --- /history ----------------------------------------------------------------

async function handleHistory(url, env) {
  const garage = url.searchParams.get("garage");
  if (!garage) return json({ error: "garage is required" }, 400);

  const bucket = url.searchParams.get("bucket") || "raw";
  if (!RANGE_CAP_SECONDS[bucket]) {
    return json({ error: "bucket must be raw, hour, or day" }, 400);
  }

  const until = parseEpochParam(url, "until") ?? nowSec();
  const since = parseEpochParam(url, "since");
  if (since == null) return json({ error: "since is required" }, 400);
  if (since >= until) return json({ error: "since must precede until" }, 400);
  if (until - since > RANGE_CAP_SECONDS[bucket]) {
    return json({ error: `range too large for bucket=${bucket}` }, 400);
  }

  const rows =
    bucket === "raw"
      ? await queryRaw(env, garage, since, until)
      : await queryBucketed(env, garage, since, until, bucket);

  // History is immutable once written. Ranges that end well in the past can be
  // cached hard; ranges touching "now" only briefly.
  const settled = until < nowSec() - CLIENT_MAX_AGE_SECONDS;
  const cacheControl = settled
    ? "public, max-age=86400, immutable"
    : `public, max-age=${CLIENT_MAX_AGE_SECONDS}`;

  return json({ garage, bucket, since, until, points: rows }, 200, {
    "Cache-Control": cacheControl,
  });
}

async function queryRaw(env, garage, since, until) {
  const { results } = await env.madison_parking.prepare(
    "SELECT observed_at, available_spaces FROM samples WHERE garage_id = ? AND observed_at >= ? AND observed_at < ? ORDER BY observed_at"
  )
    .bind(garage, since, until)
    .all();
  return results.map((r) => ({ ts: r.observed_at, avg: r.available_spaces }));
}

async function queryBucketed(env, garage, since, until, bucket) {
  // Inline the bucket size as an integer literal (it's a fixed internal
  // constant, never user input): a bound parameter binds as REAL and turns the
  // "/" into floating-point division, so buckets wouldn't align to boundaries.
  const size = bucket === "hour" ? 3600 : 86400;
  const { results } = await env.madison_parking.prepare(
    `SELECT (observed_at / ${size}) * ${size} AS bucket,
            AVG(available_spaces) AS avg, MIN(available_spaces) AS min,
            MAX(available_spaces) AS max, COUNT(*) AS n
       FROM samples
      WHERE garage_id = ? AND observed_at >= ? AND observed_at < ?
      GROUP BY bucket
      ORDER BY bucket`
  )
    .bind(garage, since, until)
    .all();
  return results.map((r) => ({
    ts: r.bucket,
    avg: Math.round(r.avg),
    min: r.min,
    max: r.max,
    n: r.n,
  }));
}

// --- /history/sync -----------------------------------------------------------

// All garages' raw samples newer than `since`, for incremental client sync.
async function handleSync(url, env) {
  const since = parseEpochParam(url, "since") ?? 0;
  const { results } = await env.madison_parking.prepare(
    "SELECT garage_id, observed_at, available_spaces FROM samples WHERE observed_at > ? ORDER BY observed_at LIMIT ?"
  )
    .bind(since, SYNC_PAGE_LIMIT_ROWS)
    .all();

  // Compact [garage_id, ts, available] tuples keep the payload small.
  const samples = results.map((r) => [r.garage_id, r.observed_at, r.available_spaces]);
  const complete = samples.length < SYNC_PAGE_LIMIT_ROWS;
  const until = samples.length ? samples[samples.length - 1][1] : since;

  return json({ since, until, complete, samples }, 200, {
    "Cache-Control": `public, max-age=${CLIENT_MAX_AGE_SECONDS}`,
  });
}

// --- /stats ------------------------------------------------------------------

// Read the precomputed baselines for a garage. Cheap indexed lookup (<= 7*24
// tiny rows); the expensive computation happens in the daily rebuildStats cron.
async function handleStats(url, env) {
  const garage = url.searchParams.get("garage");
  if (!garage) return json({ error: "garage is required" }, 400);

  const { results } = await env.madison_parking.prepare(
    `SELECT day_of_week, hour, observations, p01, p10, p25, p50, p75, computed_at
       FROM stats_cells WHERE garage_id = ?`
  )
    .bind(garage)
    .all();

  const cells = {};
  let generatedAt = 0;
  for (const r of results) {
    cells[`${r.day_of_week}-${r.hour}`] = {
      n: r.observations,
      p01: r.p01, p10: r.p10, p25: r.p25, p50: r.p50, p75: r.p75,
    };
    if (r.computed_at > generatedAt) generatedAt = r.computed_at;
  }

  return json(
    { garage, generated_at: generatedAt, cells },
    200,
    { "Cache-Control": `public, max-age=${STATS_CACHE_TTL_SECONDS}` }
  );
}

// Pool each cell with the hour on either side (clamped to the day). Within an
// hour the 5-min samples are highly autocorrelated — people park for a while, so
// consecutive readings barely move — meaning a single (day, hour) has far fewer
// *independent* observations than raw counts imply, too few to place an extreme
// percentile like p01. Adjacent hours are similar, so pooling them bulks up the
// support and smooths the baseline. Widen for more support at the cost of
// blurring the time-of-day signal.
const HOUR_SMOOTHING = 1;

// Bucket a garage's samples into (day_of_week, hour) cells and summarize each as
// percentiles over its smoothing window. Pure: rows in, cells out. SQLite has no
// PERCENTILE_CONT, so this runs in JS in the cron.
function computeCells(rows, toCell) {
  const byCell = new Map();
  for (const { observed_at, available_spaces } of rows) {
    const { dow, hour } = toCell(observed_at);
    const key = `${dow}-${hour}`;
    let values = byCell.get(key);
    if (!values) byCell.set(key, (values = []));
    values.push(available_spaces);
  }

  const cells = {};
  for (const key of byCell.keys()) {
    const [dow, hour] = key.split("-").map(Number);
    const pooled = [];
    const lo = Math.max(0, hour - HOUR_SMOOTHING);
    const hi = Math.min(23, hour + HOUR_SMOOTHING);
    for (let h = lo; h <= hi; h++) {
      const values = byCell.get(`${dow}-${h}`);
      if (values) pooled.push(...values);
    }
    pooled.sort((a, b) => a - b);
    cells[key] = {
      n: pooled.length,
      p01: percentile(pooled, 0.01),
      p10: percentile(pooled, 0.1),
      p25: percentile(pooled, 0.25),
      p50: percentile(pooled, 0.5),
      p75: percentile(pooled, 0.75),
    };
  }
  return cells;
}

// Weekly cron: recompute every garage's baselines from all retained history and
// upsert them, then drop cells not refreshed this run (a garage that stopped
// reporting, or a cell whose samples have all aged out of retention).
async function rebuildStats(env, scheduledTimeMs) {
  const computedAt = Math.floor(scheduledTimeMs / 1000);
  const toCell = makeLocalCellResolver(FEED_TZ);

  const garages = (
    await env.madison_parking.prepare("SELECT DISTINCT garage_id FROM samples").all()
  ).results.map((r) => r.garage_id);

  const upsert = env.madison_parking.prepare(
    `INSERT OR REPLACE INTO stats_cells
       (garage_id, day_of_week, hour, observations, p01, p10, p25, p50, p75, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const writes = [];
  for (const garage of garages) {
    const { results } = await env.madison_parking
      .prepare("SELECT observed_at, available_spaces FROM samples WHERE garage_id = ?")
      .bind(garage)
      .all();
    for (const [key, c] of Object.entries(computeCells(results, toCell))) {
      const [dow, hour] = key.split("-").map(Number);
      writes.push(upsert.bind(garage, dow, hour, c.n, c.p01, c.p10, c.p25, c.p50, c.p75, computedAt));
    }
  }
  if (writes.length) await env.madison_parking.batch(writes);

  await env.madison_parking
    .prepare("DELETE FROM stats_cells WHERE computed_at < ?")
    .bind(computedAt)
    .run();
  console.log(`rebuildStats: ${writes.length} cells across ${garages.length} garages`);
}

// Linear-interpolated percentile over a pre-sorted array. p in [0,1].
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}

// --- helpers -----------------------------------------------------------------

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function parseEpochParam(url, name) {
  const raw = url.searchParams.get(name);
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS,
      ...extraHeaders,
    },
  });
}

// Pure helpers, exported for the test harness (test/worker.test.mjs). Importing
// this module does not touch any Cloudflare runtime API; those are referenced
// only inside the request/scheduled handlers.
// Only functions may be exported from a Worker module besides `default` — the
// runtime treats other named exports as entrypoints. So the pure helpers are
// exported for tests, but constants like RETENTION_SECONDS are not.
export {
  parseFeedModified,
  wallTimeToEpochSec,
  zoneOffsetSec,
  makeLocalCellResolver,
  percentile,
  computeCells,
  cronAction,
  retentionCutoffSec,
};
