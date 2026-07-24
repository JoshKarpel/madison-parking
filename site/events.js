// Pure helpers for correlating venue events with garages. The Worker proxies
// upcoming events from the Ticketmaster Discovery API (it never stores them, per
// Ticketmaster's terms); each event carries its venue's coordinates. Here the
// client maps events to the garages within walking distance, using the coords in
// garages.js. No DOM, no I/O — tested in test/events.test.mjs.

import { GARAGES } from "./garages.js";

// A garage "serves" a venue when it's within this many meters: a short walk.
// Tuned (against real venue coordinates) so the core downtown venues land on one
// or two ramps each and the far-flung ones (Barrymore, UW Field House) map to
// none. An event shows on *every* garage within range, since people spread
// across the nearby ramps for a big show.
export const EVENT_RADIUS_METERS = 500;

// Great-circle distance in meters between two { lat, lon } points (haversine).
// Pure: two points in, meters out.
export function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// The ids of every garage within `radius` meters of the event's venue. Garages
// without coordinates are skipped. Pure: event + garage table in, ids out.
export function garagesForEvent(event, garages = GARAGES, radius = EVENT_RADIUS_METERS) {
  const ids = [];
  for (const [id, garage] of Object.entries(garages)) {
    if (typeof garage.lat !== "number" || typeof garage.lon !== "number") continue;
    if (distanceMeters(event, garage) <= radius) ids.push(id);
  }
  return ids;
}

// The events to surface on a garage's card, soonest first: any still ongoing
// (what explains a full ramp *now*) plus the soonest upcoming within
// `horizonSeconds` ahead, capped at `limit` for a short heads-up. Pure.
export function cardEventsForGarage(
  events,
  garageId,
  now,
  { ongoingSeconds, horizonSeconds, limit },
  garages = GARAGES,
  radius = EVENT_RADIUS_METERS
) {
  return eventsForGarage(events, garageId, garages, radius) // sorted ascending
    .filter((event) => event.starts_at <= now + horizonSeconds && !hasEnded(event, now, ongoingSeconds))
    .slice(0, limit);
}

// Whether an event has passed and should drop off the card. A curated event with
// a known end time (`ends_at`) stays until it truly ends; a Ticketmaster event
// has no reliable end, so it falls back to a grace window after its start.
function hasEnded(event, now, ongoingSeconds) {
  if (typeof event.ends_at === "number") return event.ends_at < now;
  return event.starts_at < now - ongoingSeconds;
}

// Every event near a garage, upcoming or recently past, soonest first — for the
// trend chart, which draws markers across its whole visible window (the proxy
// keeps a few hours of just-passed events). Pure.
export function eventsForGarage(
  events,
  garageId,
  garages = GARAGES,
  radius = EVENT_RADIUS_METERS
) {
  if (!Array.isArray(events)) return [];
  return events
    .filter((event) => garagesForEvent(event, garages, radius).includes(garageId))
    .sort((a, b) => a.starts_at - b.starts_at);
}

// A classification segment -> emoji, for the card badge and chart marker.
// Unknown or absent -> a neutral calendar.
const SEGMENT_EMOJI = {
  Music: "🎵",
  Sports: "🏟️",
  "Arts & Theatre": "🎭",
  Film: "🎬",
  Market: "🧺",
  Miscellaneous: "📌",
};

export function eventEmoji(classification) {
  return SEGMENT_EMOJI[classification] || "📅";
}
