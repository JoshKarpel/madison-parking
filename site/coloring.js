// Relative coloring: where does a garage's current availability sit against its
// own history for this day-of-week and hour? Pure functions, no DOM, no I/O —
// tested directly in test/coloring.test.mjs.
//
// There is deliberately no absolute-threshold fallback. If a cell hasn't been
// observed enough, we return null and the caller renders the count uncolored
// with no comparison claim, rather than guessing.

export const MIN_CELL_OBSERVATIONS = 4;

// Band keys map to CSS classes (see style.css). Ordered fullest -> emptiest.
// Resolution is concentrated at the scarce end (what someone checking parking
// cares about); everything comfortably open collapses into one "plenty" band.
export const BANDS = {
  packed: { phrase: "packed — barely any spots" },
  full: { phrase: "much fuller than usual" },
  busy: { phrase: "busier than usual" },
  typical: { phrase: "typical" },
  open: { phrase: "plenty of room" },
};

export function cellKey(dow, hour) {
  return `${dow}-${hour}`;
}

// The (day_of_week, hour) cell for an instant. Uses the browser's local clock;
// the app's users are in Madison (Central), matching how /stats keys its cells.
export function localCell(date) {
  return { dow: date.getDay(), hour: date.getHours() };
}

// Classify `available` against a stats cell {n, p01, p10, p25, p50, p75}.
// Returns { band, phrase } or null when there isn't enough history to judge.
// Percentiles are of available spaces, so lower `available` is a fuller garage.
export function classify(available, cell) {
  if (available == null) return null;
  if (!cell || cell.n < MIN_CELL_OBSERVATIONS) return null;

  const { p01, p10, p25, p75 } = cell;
  let band;
  if (available <= p01) band = "packed";
  else if (available <= p10) band = "full";
  else if (available <= p25) band = "busy";
  else if (available <= p75) band = "typical";
  else band = "open";

  return { band, phrase: BANDS[band].phrase };
}

const WEEKDAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

function dayPart(hour) {
  if (hour < 6) return "night";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 21) return "evening";
  return "night";
}

// "a Saturday evening" — the human context a "typical" verdict refers to.
export function describeWhen(date) {
  return `a ${WEEKDAYS[date.getDay()]} ${dayPart(date.getHours())}`;
}

// The full comparison line under a count, e.g.
//   "typical for a Saturday evening"  |  "much fuller than usual"
// Returns null when there's no verdict (caller shows nothing).
export function comparisonLabel(available, cell, date) {
  const verdict = classify(available, cell);
  if (!verdict) return null;
  if (verdict.band === "typical") {
    return `typical for ${describeWhen(date)}`;
  }
  return verdict.phrase;
}

// --- forecast ----------------------------------------------------------------
// Grounded in the same baseline cells as the coloring: no invented thresholds,
// only "when is this garage's median availability at its lowest later today".

function formatHour(hour) {
  const period = hour < 12 ? "am" : "pm";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}${period}`;
}

// The hour later today (from `date`'s hour onward, same day-of-week) when this
// garage is typically busiest — the lowest median availability among cells with
// enough support. Returns { hour, p50 } or null. Pure: cells in, result out.
export function busiestUpcomingHour(cells, date) {
  if (!cells) return null;
  const dow = date.getDay();
  let best = null;
  for (let hour = date.getHours(); hour <= 23; hour++) {
    const cell = cells[cellKey(dow, hour)];
    if (!cell || cell.n < MIN_CELL_OBSERVATIONS) continue;
    if (best == null || cell.p50 < best.p50) best = { hour, p50: cell.p50 };
  }
  return best;
}

// A forward-looking heads-up like "usually busiest around 6pm", or null.
// busiestUpcomingHour includes the current hour and breaks ties toward the
// earliest, so a result strictly later than now is genuinely busier than now —
// actionable, not a restatement of the current state.
export function forecastLabel(cells, date) {
  const busiest = busiestUpcomingHour(cells, date);
  if (!busiest || busiest.hour <= date.getHours()) return null;
  return `usually busiest around ${formatHour(busiest.hour)}`;
}
