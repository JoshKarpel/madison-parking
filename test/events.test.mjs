import { test, eq, ok } from "./harness.mjs";
import {
  distanceMeters,
  garagesForEvent,
  cardEventsForGarage,
  eventsForGarage,
  eventEmoji,
} from "../site/events.js";

// A small stand-in garage table with real downtown coordinates, so the mapping
// is exercised against the same geometry the app uses without coupling to the
// live garages.js.
const GARAGES = {
  overture: { lat: 43.073236, lon: -89.388706 },
  capitol: { lat: 43.075413, lon: -89.387488 },
  livingston: { lat: 43.080032, lon: -89.373120 },
  campus: { lat: 43.073759, lon: -89.395922 },
};

// Venues, with the coordinates Ticketmaster reports for them.
const ORPHEUM = { lat: 43.075236, lon: -89.388708 }; // between overture & capitol
const SYLVEE = { lat: 43.080888, lon: -89.374566 }; // next to livingston
const KOHL = { lat: 43.069828, lon: -89.395924 }; // near campus
const BARRYMORE = { lat: 43.09312, lon: -89.352265 }; // far east, no ramp near

// --- distance ----------------------------------------------------------------

test("distanceMeters is zero for a point against itself", () => {
  eq(distanceMeters({ lat: 43.07, lon: -89.38 }, { lat: 43.07, lon: -89.38 }), 0);
});

test("distanceMeters matches a one-degree latitude span (~111 km)", () => {
  const d = distanceMeters({ lat: 43, lon: -89 }, { lat: 44, lon: -89 });
  ok(Math.abs(d - 111195) < 1500, `expected ~111195 m, got ${Math.round(d)}`);
});

test("distanceMeters shrinks a longitude span by the latitude's cosine", () => {
  // One degree of longitude at 43°N ≈ 111320 * cos(43°) ≈ 81400 m.
  const d = distanceMeters({ lat: 43, lon: -89 }, { lat: 43, lon: -90 });
  ok(Math.abs(d - 81400) < 1500, `expected ~81400 m, got ${Math.round(d)}`);
});

// --- garage mapping ----------------------------------------------------------

test("an event maps to every garage within the radius, in garage order", () => {
  // The Orpheum sits between the Overture and Capitol ramps, within 500 m of both.
  eq(garagesForEvent(ORPHEUM, GARAGES), ["overture", "capitol"]);
});

test("an event maps to the single ramp beside its venue", () => {
  eq(garagesForEvent(SYLVEE, GARAGES), ["livingston"]);
  eq(garagesForEvent(KOHL, GARAGES), ["campus"]);
});

test("a far-flung venue maps to no garage", () => {
  eq(garagesForEvent(BARRYMORE, GARAGES), []);
});

test("a wider radius reaches more garages", () => {
  // The Sylvee is ~1 km from the Capitol ramp: out at 500 m, in at 1500 m.
  ok(!garagesForEvent(SYLVEE, GARAGES, 500).includes("capitol"));
  ok(garagesForEvent(SYLVEE, GARAGES, 1500).includes("capitol"));
});

// --- per-garage selection ----------------------------------------------------

const NOW = 1_800_000_000;
const HOUR = 3600;
const DAY = 86400;
const OPTS = { ongoingSeconds: 3 * HOUR, horizonSeconds: 7 * DAY, limit: 3 };

const EVENTS = [
  { id: "ongoing", starts_at: NOW - 2 * HOUR, ...ORPHEUM, classification: "Music" }, // started 2h ago
  { id: "soon", starts_at: NOW + 2 * HOUR, ...ORPHEUM, classification: "Arts & Theatre" }, // later today
  { id: "thisweek", starts_at: NOW + 3 * DAY, ...ORPHEUM, classification: "Music" }, // within the week
  { id: "nextweek", starts_at: NOW + 9 * DAY, ...ORPHEUM, classification: "Music" }, // past the horizon
  { id: "stale", starts_at: NOW - 5 * HOUR, ...ORPHEUM, classification: "Music" }, // past the grace
  { id: "sylvee", starts_at: NOW + HOUR, ...SYLVEE, classification: "Music" }, // near livingston, not overture
];

test("cardEventsForGarage keeps ongoing + upcoming within the window, soonest first", () => {
  // Overture: the just-started show, then the two upcoming within a week. The
  // long-past (stale), far-future (nextweek), and out-of-range (sylvee) drop out.
  eq(
    cardEventsForGarage(EVENTS, "overture", NOW, OPTS, GARAGES).map((e) => e.id),
    ["ongoing", "soon", "thisweek"]
  );
});

test("cardEventsForGarage caps the list at the limit", () => {
  eq(
    cardEventsForGarage(EVENTS, "overture", NOW, { ...OPTS, limit: 2 }, GARAGES).map((e) => e.id),
    ["ongoing", "soon"]
  );
});

test("cardEventsForGarage only returns a garage's own in-range events", () => {
  eq(
    cardEventsForGarage(EVENTS, "livingston", NOW, OPTS, GARAGES).map((e) => e.id),
    ["sylvee"]
  );
});

// A curated event carries an explicit end time; the card shows it until then,
// past the short ongoing grace a Ticketmaster event (no end time) would use.
const LONG = [
  { id: "market", starts_at: NOW - 5 * HOUR, ends_at: NOW + 2 * HOUR, ...ORPHEUM, classification: "Market" },
  { id: "closed", starts_at: NOW - 6 * HOUR, ends_at: NOW - HOUR, ...ORPHEUM, classification: "Market" },
];

test("cardEventsForGarage keeps a long event with a known end time still in progress", () => {
  // Started 5h ago — past the 3h grace — but ends_at is 2h ahead, so it stays.
  eq(
    cardEventsForGarage(LONG, "overture", NOW, OPTS, GARAGES).map((e) => e.id),
    ["market"]
  );
});

test("cardEventsForGarage drops an event whose known end time has passed", () => {
  eq(
    cardEventsForGarage([LONG[1]], "overture", NOW, OPTS, GARAGES).map((e) => e.id),
    []
  );
});

test("eventsForGarage includes recently-passed events too, sorted by start", () => {
  eq(
    eventsForGarage(EVENTS, "overture", GARAGES).map((e) => e.id),
    ["stale", "ongoing", "soon", "thisweek", "nextweek"]
  );
});

// --- emoji -------------------------------------------------------------------

test("eventEmoji maps known segments and falls back for the rest", () => {
  eq(eventEmoji("Music"), "🎵");
  eq(eventEmoji("Sports"), "🏟️");
  eq(eventEmoji("Arts & Theatre"), "🎭");
  eq(eventEmoji("Market"), "🧺");
  eq(eventEmoji("Something New"), "📅");
  eq(eventEmoji(null), "📅");
});
