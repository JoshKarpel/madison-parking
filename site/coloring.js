// Two independent signals about a garage, both pure (no DOM, no I/O) and tested
// in test/coloring.test.mjs:
//
// 1. Headline — "could I park here right now?": how full the garage is against an
//    ESTIMATE of its total capacity (the Worker derives capacity as a high-water
//    mark of availability; there is no real capacity figure in the feed). Drives
//    the card color, the background fill, and the "≈N% free" readout.
// 2. Tidbit — "is this unusual for the time?": where the current count sits in the
//    garage's own history for this (day_of_week, hour). A small comparative line
//    for spotting out-of-the-ordinary conditions, deliberately NOT the color.

export const MIN_CELL_OBSERVATIONS = 4;

// --- headline: fullness vs estimated capacity --------------------------------

// Bands are named for how much parking is left (nouns, fullest -> emptiest), and
// map to CSS classes (see style.css). Thresholds are on the fraction of the
// (estimated) capacity still open, so a single set holds across a 20-space lot
// and a 600-space ramp alike. Tune here.
const FULLNESS_BANDS = [
  { band: "none",    maxOpen: 0.03, phrase: "essentially full" },
  { band: "sliver",  maxOpen: 0.08, phrase: "nearly full" },
  { band: "handful", maxOpen: 0.15, phrase: "filling up" },
  { band: "room",    maxOpen: 0.3,  phrase: "space available" },
  { band: "plenty",  maxOpen: Infinity, phrase: "plenty of room" },
];

// Classify how full a garage is against its estimated capacity. `available` is
// spaces open now; `capacity` is the estimated total. Returns { band, phrase } or
// null when there's no basis (no count, or no capacity estimate yet).
export function classifyFullness(available, capacity) {
  if (available == null || !capacity || capacity <= 0) return null;
  const openFraction = available / capacity;
  const bucket = FULLNESS_BANDS.find((b) => openFraction <= b.maxOpen);
  return { band: bucket.band, phrase: bucket.phrase };
}

// Estimated share of the garage still open right now (0..100), or null when the
// inputs don't support it. Clamped: a live count can momentarily exceed the
// trailing-window capacity estimate (p99), which would otherwise read over 100%.
export function freePercent(available, capacity) {
  if (available == null || !capacity || capacity <= 0) return null;
  const pct = Math.round((available / capacity) * 100);
  return Math.max(0, Math.min(100, pct));
}

// --- tidbit: unusual for this (day, hour)? -----------------------------------

export function cellKey(dow, hour) {
  return `${dow}-${hour}`;
}

// The (day_of_week, hour) cell for an instant. Uses the browser's local clock;
// the app's users are in Madison (Central), matching how /stats keys its cells.
export function localCell(date) {
  return { dow: date.getDay(), hour: date.getHours() };
}

// Bands name where availability sits in this cell's own history (lowest -> high),
// which is a comparative/statistical position, not a fullness. Fewer spaces than
// usual for this slot reads as busier than usual.
const SLOT_BANDS = {
  lowest: "far busier than usual",
  low: "busier than usual",
  below: "a bit busier than usual",
  usual: "about typical",
  high: "quieter than usual",
};

// Classify `available` against a stats cell {n, p01, p10, p25, p50, p75}.
// Returns { band, phrase } (comparative) or null when there isn't enough history.
// Percentiles are of available spaces, so lower `available` is a fuller garage.
export function classify(available, cell) {
  if (available == null) return null;
  if (!cell || cell.n < MIN_CELL_OBSERVATIONS) return null;

  const { p01, p10, p25, p75 } = cell;
  let band;
  if (available <= p01) band = "lowest";
  else if (available <= p10) band = "low";
  else if (available <= p25) band = "below";
  else if (available <= p75) band = "usual";
  else band = "high";

  return { band, phrase: SLOT_BANDS[band] };
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

// "a Saturday evening" — the human context a comparison refers to.
export function describeWhen(date) {
  return `a ${WEEKDAYS[date.getDay()]} ${dayPart(date.getHours())}`;
}

// The comparative slot line, e.g. "busier than usual for a Saturday evening".
// Null when there isn't enough history to say.
export function comparisonLabel(available, cell, date) {
  const verdict = classify(available, cell);
  if (!verdict) return null;
  return `${verdict.phrase} for ${describeWhen(date)}`;
}

// --- forecast ----------------------------------------------------------------
// Grounded in the same baseline cells: no invented thresholds, only "when is this
// garage's median availability at its lowest later today".

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
