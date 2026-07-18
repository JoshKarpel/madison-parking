import { test, eq } from "./harness.mjs";
import { nearestIndex } from "../site/chart.js";

// The crosshair snaps a pointer's x to the nearest sample's x. Values are the
// per-point pixel positions, ascending; the target is the pointer's x.

test("nearestIndex picks the closest value", () => {
  eq(nearestIndex([10, 40, 90, 150], 100), 2);
});

test("nearestIndex snaps to the first value left of the plot", () => {
  eq(nearestIndex([10, 40, 90, 150], -20), 0);
});

test("nearestIndex snaps to the last value right of the plot", () => {
  eq(nearestIndex([10, 40, 90, 150], 999), 3);
});

test("nearestIndex resolves an exact midpoint tie to the earlier index", () => {
  // 55 is equidistant from 40 and 70; the earlier index wins.
  eq(nearestIndex([40, 70], 55), 0);
});
