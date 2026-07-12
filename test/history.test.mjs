import { test, eq } from "./harness.mjs";
import { computeTrend } from "../site/history.js";

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
