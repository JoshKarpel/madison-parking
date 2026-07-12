import { test, eq } from "./harness.mjs";
import {
  classify,
  comparisonLabel,
  describeWhen,
  localCell,
  cellKey,
  MIN_CELL_OBSERVATIONS,
} from "../site/coloring.js";

// A well-populated cell: 60 obs, spread from a packed p01 up to p75.
const cell = { n: 60, p01: 20, p10: 60, p25: 90, p50: 130, p75: 170 };

test("classifies availability at or below p01 as packed", () => {
  eq(classify(15, cell), { band: "packed", phrase: "packed — barely any spots" });
});

test("classifies availability between p01 and p10 as much fuller than usual", () => {
  eq(classify(45, cell), { band: "full", phrase: "much fuller than usual" });
});

test("classifies availability between p10 and p25 as busier than usual", () => {
  eq(classify(75, cell), { band: "busy", phrase: "busier than usual" });
});

test("classifies availability in the p25..p75 middle as typical", () => {
  eq(classify(130, cell), { band: "typical", phrase: "typical" });
});

test("collapses everything above p75 into a single plenty-of-room band", () => {
  eq(classify(180, cell), { band: "open", phrase: "plenty of room" });
  eq(classify(9999, cell), { band: "open", phrase: "plenty of room" });
});

test("band boundaries are inclusive at each upper percentile", () => {
  eq(classify(cell.p01, cell).band, "packed");
  eq(classify(cell.p10, cell).band, "full");
  eq(classify(cell.p25, cell).band, "busy");
  eq(classify(cell.p75, cell).band, "typical");
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

test("typical verdict includes the day-and-daypart context", () => {
  const sat8pm = new Date(2026, 6, 4, 20, 0); // Sat Jul 4 2026, 8pm local
  eq(comparisonLabel(130, cell, sat8pm), "typical for a Saturday evening");
});

test("non-typical verdict is a bare comparative with no day context", () => {
  const sat8pm = new Date(2026, 6, 4, 20, 0);
  eq(comparisonLabel(45, cell, sat8pm), "much fuller than usual");
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
