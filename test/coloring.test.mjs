import { test, eq } from "./harness.mjs";
import {
  classify,
  classifyFullness,
  occupancyPercent,
  comparisonLabel,
  describeWhen,
  busiestUpcomingHour,
  forecastLabel,
  localCell,
  cellKey,
  MIN_CELL_OBSERVATIONS,
} from "../site/coloring.js";

// --- headline: fullness vs estimated capacity --------------------------------

test("classifyFullness reads a near-empty garage as plenty of room", () => {
  // 450 of an estimated 600 open = 75% open, well above every fuller threshold.
  eq(classifyFullness(450, 600), { band: "plenty", phrase: "plenty of room" });
});

test("classifyFullness bands scale with the estimated capacity, not raw count", () => {
  // 12 open reads as no room against a 600 total (2% open) but plenty against a
  // small 30-space lot (40% open).
  eq(classifyFullness(12, 600).band, "none");
  eq(classifyFullness(12, 30).band, "plenty");
});

test("classifyFullness walks the fraction thresholds", () => {
  eq(classifyFullness(2, 100).band, "none"); // 2% open
  eq(classifyFullness(6, 100).band, "sliver"); // 6% open
  eq(classifyFullness(12, 100).band, "handful"); // 12% open
  eq(classifyFullness(25, 100).band, "room"); // 25% open
  eq(classifyFullness(40, 100).band, "plenty"); // 40% open
});

test("classifyFullness returns null without a count or a capacity estimate", () => {
  eq(classifyFullness(null, 600), null);
  eq(classifyFullness(300, null), null);
  eq(classifyFullness(300, 0), null);
});

test("occupancyPercent is the occupied share, rounded and clamped", () => {
  eq(occupancyPercent(150, 600), 75); // (600-150)/600
  eq(occupancyPercent(0, 480), 100); // full
  eq(occupancyPercent(500, 480), 0); // count above the estimate clamps, not negative
  eq(occupancyPercent(200, null), null);
});

// --- tidbit: unusual for this (day, hour)? -----------------------------------

// A well-populated cell: 60 obs, spread from a packed p01 up to p75.
const cell = { n: 60, p01: 20, p10: 60, p25: 90, p50: 130, p75: 170 };

test("classifies availability at or below p01 as far busier than usual", () => {
  eq(classify(15, cell), { band: "lowest", phrase: "far busier than usual" });
});

test("classifies availability between p01 and p10 as busier than usual", () => {
  eq(classify(45, cell), { band: "low", phrase: "busier than usual" });
});

test("classifies availability between p10 and p25 as a bit busier than usual", () => {
  eq(classify(75, cell), { band: "below", phrase: "a bit busier than usual" });
});

test("classifies availability in the p25..p75 middle as about typical", () => {
  eq(classify(130, cell), { band: "usual", phrase: "about typical" });
});

test("collapses everything above p75 into a single quieter-than-usual band", () => {
  eq(classify(180, cell), { band: "high", phrase: "quieter than usual" });
  eq(classify(9999, cell), { band: "high", phrase: "quieter than usual" });
});

test("band boundaries are inclusive at each upper percentile", () => {
  eq(classify(cell.p01, cell).band, "lowest");
  eq(classify(cell.p10, cell).band, "low");
  eq(classify(cell.p25, cell).band, "below");
  eq(classify(cell.p75, cell).band, "usual");
});

test("returns null when the cell has too few observations", () => {
  const thin = { ...cell, n: MIN_CELL_OBSERVATIONS - 1 };
  eq(classify(130, thin), null);
});

test("returns null for a missing cell or missing availability", () => {
  eq(classify(130, undefined), null);
  eq(classify(null, cell), null);
});

// --- human-facing labels -----------------------------------------------------

test("a typical count reads as about typical for the day-and-daypart", () => {
  const sat8pm = new Date(2026, 6, 4, 20, 0); // Sat Jul 4 2026, 8pm local
  eq(comparisonLabel(130, cell, sat8pm), "about typical for a Saturday evening");
});

test("a fuller-than-usual count reads as busier than usual for the slot", () => {
  const sat8pm = new Date(2026, 6, 4, 20, 0);
  eq(comparisonLabel(45, cell, sat8pm), "busier than usual for a Saturday evening");
});

test("comparisonLabel returns null when there's no verdict", () => {
  eq(comparisonLabel(130, { ...cell, n: 1 }, new Date()), null);
});

test("describeWhen names weekday and daypart from a local date", () => {
  eq(describeWhen(new Date(2026, 6, 6, 9, 0)), "a Monday morning"); // Mon 9am
  eq(describeWhen(new Date(2026, 6, 6, 2, 0)), "a Monday night"); // Mon 2am
  eq(describeWhen(new Date(2026, 6, 5, 14, 0)), "a Sunday afternoon"); // Sun 2pm
});

test("localCell / cellKey derive the (dow,hour) key from a date", () => {
  const d = new Date(2026, 6, 4, 20, 0); // Saturday, hour 20
  const { dow, hour } = localCell(d);
  eq(cellKey(dow, hour), "6-20");
});

// --- forecast ----------------------------------------------------------------
// A supported cell for a given median availability (busiest = lowest p50). Only
// n and p50 matter to the forecast; the other percentiles are filler.
const supported = (p50) => ({ n: 20, p01: 0, p10: 0, p25: 0, p50, p75: 0 });

// Mon Jul 6 2026 (dow=1): typically tightens through the afternoon, loosens by 8pm.
const mondayCells = {
  "1-8": supported(90),
  "1-14": supported(100),
  "1-15": supported(80),
  "1-18": supported(30), // busiest
  "1-20": supported(60),
};

test("busiestUpcomingHour finds the lowest-median hour still ahead today", () => {
  const mon2pm = new Date(2026, 6, 6, 14, 0);
  eq(busiestUpcomingHour(mondayCells, mon2pm), { hour: 18, p50: 30 });
});

test("busiestUpcomingHour ignores hours already past this afternoon", () => {
  // At 7pm only 8pm remains ahead; the busier 6pm is behind us.
  const mon7pm = new Date(2026, 6, 6, 19, 0);
  eq(busiestUpcomingHour(mondayCells, mon7pm), { hour: 20, p50: 60 });
});

test("busiestUpcomingHour skips cells without enough support", () => {
  const thin = { "1-18": { ...supported(30), n: MIN_CELL_OBSERVATIONS - 1 } };
  eq(busiestUpcomingHour(thin, new Date(2026, 6, 6, 14, 0)), null);
});

test("forecastLabel names the upcoming busiest hour in wall-clock form", () => {
  eq(forecastLabel(mondayCells, new Date(2026, 6, 6, 14, 0)), "usually busiest around 6pm");
});

test("forecastLabel formats a morning peak with am", () => {
  // A garage that peaks at the morning commute: 8am is the busiest supported
  // hour, and pre-dawn the current hour has no baseline of its own.
  const morningPeak = { "1-8": supported(10), "1-9": supported(40) };
  eq(forecastLabel(morningPeak, new Date(2026, 6, 6, 5, 0)), "usually busiest around 8am");
});

test("forecastLabel is null once the busiest hour is now or behind us", () => {
  eq(forecastLabel(mondayCells, new Date(2026, 6, 6, 18, 0)), null);
});

test("forecastLabel is null with no baseline cells", () => {
  eq(forecastLabel(null, new Date(2026, 6, 6, 14, 0)), null);
});
