import { test, eq } from "./harness.mjs";
import { computeTrend, statsFreshness, STATS_STALE_SECONDS, humanizeAgo } from "../site/history.js";

// Samples are {ts, avg} ascending by ts; the trend compares the last against the
// first over the window. Positive delta = spots opening up (emptying). The
// steady band is a fraction of the start/end average (default 10%), so the same
// absolute swing is significant on a small lot and noise on a large ramp.

test("computeTrend reports emptying when the gain exceeds the relative band", () => {
  // avg 115, 10% band = 11.5; a +30 swing clears it.
  const samples = [{ ts: 100, avg: 100 }, { ts: 400, avg: 130 }];
  eq(computeTrend(samples), { direction: "emptying", delta: 30 });
});

test("computeTrend reports filling when the loss exceeds the relative band", () => {
  // avg 180, 10% band = 18; a -40 swing clears it.
  const samples = [{ ts: 100, avg: 200 }, { ts: 300, avg: 175 }, { ts: 500, avg: 160 }];
  eq(computeTrend(samples), { direction: "filling", delta: -40 });
});

test("computeTrend reads a small swing on a large ramp as steady", () => {
  // avg 500, 10% band = 50; a -20 swing stays inside it.
  const samples = [{ ts: 100, avg: 510 }, { ts: 400, avg: 490 }];
  eq(computeTrend(samples), { direction: "steady", delta: -20 });
});

test("computeTrend reads the same swing on a small lot as a real move", () => {
  // avg 30, 10% band = 3; the same -20 swing is a big deal here.
  const samples = [{ ts: 100, avg: 40 }, { ts: 400, avg: 20 }];
  eq(computeTrend(samples), { direction: "filling", delta: -20 });
});

test("computeTrend treats a change exactly at the band as steady", () => {
  // avg 100, 10% band = 10; a +10 swing sits on the boundary.
  const samples = [{ ts: 100, avg: 95 }, { ts: 400, avg: 105 }];
  eq(computeTrend(samples), { direction: "steady", delta: 10 });
});

test("computeTrend honors a custom fraction", () => {
  // avg 100, 50% band = 50; a +30 swing is steady under a looser band.
  const samples = [{ ts: 100, avg: 85 }, { ts: 400, avg: 115 }];
  eq(computeTrend(samples, 0.5), { direction: "steady", delta: 30 });
});

test("computeTrend reads an empty garage as steady, not a division blowup", () => {
  eq(computeTrend([{ ts: 100, avg: 0 }, { ts: 400, avg: 0 }]), { direction: "steady", delta: 0 });
});

test("computeTrend needs two samples to judge", () => {
  eq(computeTrend([{ ts: 100, avg: 12 }]), null);
  eq(computeTrend([]), null);
  eq(computeTrend(null), null);
});

// statsFreshness flags baselines that have gone stale (the weekly rebuild cron
// stopped). generatedAt/now are UTC epoch seconds; stale past STATS_STALE_SECONDS.

test("statsFreshness reports a recent baseline as fresh", () => {
  const generatedAt = 1_000_000;
  const now = generatedAt + 3 * 86400; // 3 days old
  eq(statsFreshness(generatedAt, now), {
    generatedAt,
    ageSeconds: 3 * 86400,
    stale: false,
  });
});

test("statsFreshness flags a baseline older than the stale bound", () => {
  const generatedAt = 1_000_000;
  const now = generatedAt + STATS_STALE_SECONDS + 86400; // a day past the bound
  eq(statsFreshness(generatedAt, now), {
    generatedAt,
    ageSeconds: STATS_STALE_SECONDS + 86400,
    stale: true,
  });
});

test("statsFreshness treats an age exactly at the bound as still fresh", () => {
  const generatedAt = 1_000_000;
  const now = generatedAt + STATS_STALE_SECONDS;
  eq(statsFreshness(generatedAt, now).stale, false);
});

test("statsFreshness has nothing to judge without a timestamp", () => {
  eq(statsFreshness(0, 1_000_000), null);
  eq(statsFreshness(null, 1_000_000), null);
});

// humanizeAgo coarsens an age in seconds into a "time since" label, singular at
// the boundary and clamping a negative (feed clock slightly ahead) to "just now".

test("humanizeAgo reads under a minute as just now", () => {
  eq(humanizeAgo(0), "just now");
  eq(humanizeAgo(59), "just now");
});

test("humanizeAgo reports whole minutes, singular at one", () => {
  eq(humanizeAgo(60), "1 minute ago");
  eq(humanizeAgo(185), "3 minutes ago");
});

test("humanizeAgo rolls up to hours past 60 minutes", () => {
  eq(humanizeAgo(3600), "1 hour ago");
  eq(humanizeAgo(9000), "2 hours ago");
});

test("humanizeAgo rolls up to days past 24 hours", () => {
  eq(humanizeAgo(86400), "1 day ago");
  eq(humanizeAgo(3 * 86400 + 500), "3 days ago");
});

test("humanizeAgo clamps a negative age to just now", () => {
  eq(humanizeAgo(-42), "just now");
});
