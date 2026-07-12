import { test, eq, ok } from "./harness.mjs";
import {
  parseFeedModified,
  wallTimeToEpochSec,
  makeLocalCellResolver,
  percentile,
  computeCells,
  cronAction,
  retentionCutoffSec,
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
