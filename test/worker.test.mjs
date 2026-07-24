import { test, eq, ok } from "./harness.mjs";
import {
  parseFeedModified,
  wallTimeToEpochSec,
  makeLocalCellResolver,
  percentile,
  computeCells,
  estimateCapacity,
  parseEvents,
  expandStaticEvents,
  cronAction,
  retentionCutoffSec,
  safeEqual,
  endpointLabel,
} from "../worker/src/index.js";

const FIVE_YEARS_SECONDS = 5 * 365 * 86400;

const epoch = (iso) => Math.floor(Date.parse(iso) / 1000);

// --- feed timestamp parsing (naive Central -> UTC epoch) ---------------------

test("parses a summer (CDT, UTC-5) feed timestamp", () => {
  eq(parseFeedModified("July 12, 2026 – 10:05am"), epoch("2026-07-12T15:05:00Z"));
});

test("parses a winter (CST, UTC-6) feed timestamp", () => {
  eq(parseFeedModified("January 12, 2026 – 10:05am"), epoch("2026-01-12T16:05:00Z"));
});

test("handles 12pm noon and 12am midnight", () => {
  eq(parseFeedModified("July 12, 2026 – 12:00pm"), epoch("2026-07-12T17:00:00Z"));
  eq(parseFeedModified("July 12, 2026 – 12:00am"), epoch("2026-07-12T05:00:00Z"));
});

test("converts a time just after spring-forward correctly", () => {
  // 2026-03-08: clocks jump 2:00am CST -> 3:00am CDT. 3:30am is CDT (UTC-5).
  eq(parseFeedModified("March 8, 2026 – 3:30am"), epoch("2026-03-08T08:30:00Z"));
});

test("converts a time after fall-back correctly", () => {
  // 2026-11-01: clocks fall 2:00am CDT -> 1:00am CST. 3:30am is unambiguously
  // CST (UTC-6), well past the repeated 1am hour.
  eq(parseFeedModified("November 1, 2026 – 3:30am"), epoch("2026-11-01T09:30:00Z"));
});

test("accepts a plain hyphen separator as well as the en-dash", () => {
  eq(parseFeedModified("July 12, 2026 - 9:00pm"), epoch("2026-07-13T02:00:00Z"));
});

test("returns null for unparseable or missing timestamps", () => {
  eq(parseFeedModified("garbage"), null);
  eq(parseFeedModified("Fo;bruary 3, 2026 – 1:00am"), null);
  eq(parseFeedModified(""), null);
  eq(parseFeedModified(null), null);
  eq(parseFeedModified(undefined), null);
});

test("rejects out-of-range clock components", () => {
  eq(parseFeedModified("July 12, 2026 – 13:00pm"), null);
  eq(parseFeedModified("July 12, 2026 – 10:75am"), null);
});

// --- wall-time round-trip ----------------------------------------------------

test("wallTimeToEpochSec round-trips through the local cell resolver", () => {
  const utc = wallTimeToEpochSec(2026, 6, 4, 20, 0, "America/Chicago"); // Jul 4, 8pm CDT
  eq(utc, epoch("2026-07-05T01:00:00Z"));
  const cell = makeLocalCellResolver("America/Chicago")(utc);
  eq(cell, { dow: 6, hour: 20 }); // Saturday, hour 20
});

test("local cell resolver reports Central day/hour across the UTC date line", () => {
  // 2026-07-06 is a Monday. 11pm Central Sunday = Monday 04:00 UTC.
  const utc = epoch("2026-07-06T04:00:00Z");
  const cell = makeLocalCellResolver("America/Chicago")(utc);
  eq(cell, { dow: 0, hour: 23 }); // still Sunday 11pm locally
});

// --- retention prune gating --------------------------------------------------

test("the every-minute cron collects and any other cron maintains", () => {
  eq(cronAction("* * * * *"), "collect");
  eq(cronAction("30 4 * * SUN"), "maintain");
  // Robust to however Cloudflare echoes the weekly cron back (SUN, 1, ...).
  eq(cronAction("30 4 * * 1"), "maintain");
});

test("computeCells pools adjacent hours and summarizes each cell as percentiles", () => {
  // toCell maps observed_at straight to (dow, hour) for a deterministic test.
  const toCell = (t) => ({ dow: 3, hour: t });
  const rows = [
    { observed_at: 8, available_spaces: 10 },
    { observed_at: 9, available_spaces: 20 },
    { observed_at: 9, available_spaces: 30 },
    { observed_at: 10, available_spaces: 40 },
  ];
  const cells = computeCells(rows, toCell);
  // Hour 9 pools hours 8, 9, 10 -> [10, 20, 30, 40].
  eq(cells["3-9"].n, 4);
  eq(cells["3-9"].p50, 25);
  eq(cells["3-9"].p01, 10);
  // Hour 8 pools 7 (none), 8, 9 -> [10, 20, 30]; the window clamps at the edge.
  eq(cells["3-8"].n, 3);
});

test("computeCells pools only within a day, never across the day boundary", () => {
  // Same clock hour, different days: hour 0 on Wed (dow 3) and hour 23 on Tue
  // (dow 2). Pooling is (dow, hour±1) clamped to [0,23], so these must not mix.
  const toCell = (t) => (t === 100 ? { dow: 3, hour: 0 } : { dow: 2, hour: 23 });
  const rows = [
    { observed_at: 100, available_spaces: 5 },  // Wed 00:xx
    { observed_at: 200, available_spaces: 90 },  // Tue 23:xx
  ];
  const cells = computeCells(rows, toCell);
  // Wed hour 0 pools hours 0 and 1 only (no hour -1 wrap into Tue 23).
  eq(cells["3-0"].n, 1);
  eq(cells["3-0"].p50, 5);
  // Tue hour 23 pools hours 22 and 23 only (no hour 24 wrap into Wed 0).
  eq(cells["2-23"].n, 1);
  eq(cells["2-23"].p50, 90);
});

test("retention cutoff is five years before the scheduled instant", () => {
  const scheduled = Date.UTC(2026, 6, 12, 0, 0, 0);
  eq(retentionCutoffSec(scheduled), Math.floor(scheduled / 1000) - FIVE_YEARS_SECONDS);
});

// --- percentiles -------------------------------------------------------------

test("percentile interpolates over a sorted array", () => {
  const s = [10, 20, 30, 40, 50];
  eq(percentile(s, 0), 10);
  eq(percentile(s, 0.5), 30);
  eq(percentile(s, 1), 50);
  eq(percentile(s, 0.25), 20);
});

test("percentile handles degenerate inputs", () => {
  eq(percentile([], 0.5), null);
  eq(percentile([42], 0.9), 42);
});

test("percentiles are monotonic on noisy data", () => {
  const s = Array.from({ length: 200 }, (_, i) => (i * 37) % 100).sort((a, b) => a - b);
  const p10 = percentile(s, 0.1);
  const p50 = percentile(s, 0.5);
  const p90 = percentile(s, 0.9);
  ok(p10 <= p50 && p50 <= p90, `expected p10<=p50<=p90, got ${p10},${p50},${p90}`);
});

// --- capacity estimate -------------------------------------------------------

test("estimateCapacity takes a high-water mark of availability within the window", () => {
  const rows = [
    { observed_at: 100, available_spaces: 500 },
    { observed_at: 120, available_spaces: 400 },
    { observed_at: 140, available_spaces: 480 },
  ];
  // p99 of [400, 480, 500] rounds to the high end (near the emptiest observed).
  eq(estimateCapacity(rows, 90), 500);
});

test("estimateCapacity ignores samples older than the window (e.g. a past glitch)", () => {
  const rows = [
    { observed_at: 50, available_spaces: 9999 }, // before the cutoff — excluded
    { observed_at: 100, available_spaces: 300 },
    { observed_at: 140, available_spaces: 350 },
  ];
  eq(estimateCapacity(rows, 90), 350);
});

test("estimateCapacity is null when the window holds no samples", () => {
  const rows = [{ observed_at: 10, available_spaces: 200 }];
  eq(estimateCapacity(rows, 500), null);
});

// --- admin token compare -----------------------------------------------------

test("safeEqual accepts an exact token match", () => {
  ok(safeEqual("s3cret-token-abc", "s3cret-token-abc"));
});

test("safeEqual rejects a wrong token of equal length", () => {
  ok(!safeEqual("s3cret-token-abc", "s3cret-token-xyz"));
});

test("safeEqual rejects a length mismatch", () => {
  ok(!safeEqual("short", "a-much-longer-token"));
});

test("safeEqual rejects non-strings (missing or malformed header)", () => {
  ok(!safeEqual(null, "expected-token"));
  ok(!safeEqual(undefined, "expected-token"));
});

// --- Ticketmaster event parsing ----------------------------------------------

// A window that comfortably holds the sample events below.
const EV_SINCE = epoch("2026-07-20T00:00:00Z");
const EV_UNTIL = EV_SINCE + 45 * 86400;

// A well-formed Discovery API event, with knobs to break each field in a test.
function tmEvent(overrides = {}) {
  const base = {
    id: "evt-1",
    name: "Concert at the Orpheum",
    url: "https://www.ticketmaster.com/evt-1",
    dates: { start: { dateTime: "2026-07-25T01:00:00Z" }, status: { code: "onsale" } },
    classifications: [{ primary: true, segment: { name: "Music" } }],
    _embedded: { venues: [{ name: "Orpheum Theater", location: { latitude: "43.0752", longitude: "-89.3887" } }] },
  };
  return { ...base, ...overrides };
}

function parseOne(overrides) {
  return parseEvents({ _embedded: { events: [tmEvent(overrides)] } }, EV_SINCE, EV_UNTIL);
}

test("parseEvents pulls the fields we need from a well-formed event", () => {
  const [row] = parseEvents({ _embedded: { events: [tmEvent()] } }, EV_SINCE, EV_UNTIL);
  eq(row.id, "evt-1");
  eq(row.title, "Concert at the Orpheum");
  eq(row.venue, "Orpheum Theater");
  eq(row.starts_at, epoch("2026-07-25T01:00:00Z"));
  eq(row.lat, 43.0752);
  eq(row.lon, -89.3887);
  eq(row.url, "https://www.ticketmaster.com/evt-1");
  eq(row.classification, "Music");
  eq(row.ends_at, null); // Ticketmaster gives no reliable end time
});

test("parseEvents drops a cancelled event", () => {
  eq(parseOne({ dates: { start: { dateTime: "2026-07-25T01:00:00Z" }, status: { code: "cancelled" } } }), []);
});

test("parseEvents drops an event with no specific start time (TBA)", () => {
  eq(parseOne({ dates: { start: { localDate: "2026-07-25", dateTBA: true } } }), []);
});

test("parseEvents drops events outside the [since, until] window", () => {
  eq(parseOne({ dates: { start: { dateTime: "2026-07-19T00:00:00Z" } } }), []); // before since
  eq(parseOne({ dates: { start: { dateTime: "2026-10-01T00:00:00Z" } } }), []); // after until
});

test("parseEvents drops an event whose venue has no coordinates", () => {
  eq(parseOne({ _embedded: { venues: [{ name: "Mystery Venue" }] } }), []);
});

test("parseEvents defaults a missing url and classification to null", () => {
  const [row] = parseOne({ url: undefined, classifications: [] });
  eq(row.url, null);
  eq(row.classification, null);
});

test("parseEvents returns nothing for a response with no events array", () => {
  eq(parseEvents({}, EV_SINCE, EV_UNTIL), []);
  eq(parseEvents({ _embedded: {} }, EV_SINCE, EV_UNTIL), []);
});

// --- static event expansion --------------------------------------------------

// A weekly seasonal descriptor shaped like the real farmers' market: Saturdays,
// 6:15am–1:45pm Central, mid-April through mid-November 2026.
const MARKET = {
  kind: "weekly",
  id: "market",
  title: "Farmers' Market",
  venue: "Capitol Square",
  lat: 43.0747,
  lon: -89.3844,
  url: "https://example.org/market",
  classification: "Market",
  weekday: 6, // Saturday (0=Sun..6=Sat)
  startTime: [6, 15],
  endTime: [13, 45],
  seasonStart: [2026, 3, 11], // April 11, 2026
  seasonEnd: [2026, 10, 14], // November 14, 2026
};

const win = (fromIso, toIso) => [epoch(fromIso), epoch(toIso)];

test("expandStaticEvents emits a weekly recurrence's occurrences within the window", () => {
  const rows = expandStaticEvents([MARKET], ...win("2026-07-13T00:00:00Z", "2026-08-02T00:00:00Z"));
  eq(rows.map((r) => r.id), ["market-20260718", "market-20260725", "market-20260801"]);
});

test("expandStaticEvents converts each occurrence's Central wall-clock time (summer, CDT)", () => {
  const [row, ...rest] = expandStaticEvents([MARKET], ...win("2026-07-18T00:00:00Z", "2026-07-19T00:00:00Z"));
  eq(rest, []);
  eq(row.starts_at, epoch("2026-07-18T11:15:00Z")); // 6:15am CDT (UTC-5)
  eq(row.ends_at, epoch("2026-07-18T18:45:00Z")); // 1:45pm CDT
  eq(row.title, "Farmers' Market");
  eq(row.venue, "Capitol Square");
  eq(row.lat, 43.0747);
  eq(row.classification, "Market");
  eq(row.url, "https://example.org/market");
});

test("expandStaticEvents follows the fall-back offset shift within one season", () => {
  // Oct 31 is still CDT (UTC-5); Nov 1 falls back, so Nov 7 and 14 are CST (UTC-6).
  const rows = expandStaticEvents([MARKET], ...win("2026-10-30T00:00:00Z", "2026-11-16T00:00:00Z"));
  eq(
    rows.map((r) => [r.id, r.starts_at]),
    [
      ["market-20261031", epoch("2026-10-31T11:15:00Z")],
      ["market-20261107", epoch("2026-11-07T12:15:00Z")],
      ["market-20261114", epoch("2026-11-14T12:15:00Z")],
    ]
  );
});

test("expandStaticEvents stops at the season's end date", () => {
  // The Nov 14 close, then nothing after (no Nov 21/28) even though the window covers them.
  const rows = expandStaticEvents([MARKET], ...win("2026-11-14T00:00:00Z", "2026-12-15T00:00:00Z"));
  eq(rows.map((r) => r.id), ["market-20261114"]);
});

test("expandStaticEvents drops an occurrence whose start falls outside the window", () => {
  // The window closes at 6:00am, before opening Saturday's 6:15am (11:15Z) start.
  eq(expandStaticEvents([MARKET], ...win("2026-04-11T00:00:00Z", "2026-04-11T06:00:00Z")), []);
});

test("expandStaticEvents places a one-off at its single Central datetime, no end", () => {
  const parade = {
    kind: "one-off",
    id: "parade",
    title: "Winter Parade",
    venue: "State Street",
    lat: 43.0743,
    lon: -89.3861,
    startTime: [17, 30],
    date: [2026, 1, 14], // February 14, 2026 (CST, UTC-6)
  };
  const [row, ...rest] = expandStaticEvents([parade], ...win("2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z"));
  eq(rest, []);
  eq(row.id, "parade-20260214");
  eq(row.starts_at, epoch("2026-02-14T23:30:00Z")); // 5:30pm CST
  eq(row.ends_at, null); // no endTime given
});

test("expandStaticEvents rejects an unknown descriptor kind", () => {
  let threw = false;
  try {
    expandStaticEvents([{ kind: "monthly" }], epoch("2026-01-01T00:00:00Z"), epoch("2026-02-01T00:00:00Z"));
  } catch {
    threw = true;
  }
  ok(threw, "expected an unknown descriptor kind to throw");
});

// --- usage metric labels -----------------------------------------------------

test("endpointLabel maps each route to a stable, bounded label", () => {
  eq(endpointLabel("/history"), "history");
  eq(endpointLabel("/history/sync"), "sync");
  eq(endpointLabel("/stats"), "stats");
  eq(endpointLabel("/events"), "events");
  eq(endpointLabel("/admin/rebuild-stats"), "admin");
});

test("endpointLabel collapses the snapshot path and any unknown path to snapshot", () => {
  eq(endpointLabel("/"), "snapshot");
  eq(endpointLabel("/anything-else"), "snapshot");
});
