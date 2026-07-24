---
name: add-event
description: >
  Add a curated static or recurring event to the parking PWA's /events feed
  (a farmers' market, festival, parade, concert series, or anything not in
  Ticketmaster and too irregular to scrape). MUST be invoked whenever adding,
  editing, or removing a hand-curated event, touching STATIC_EVENTS in
  worker/src/index.js, or when the user asks to "add an event", "add the market",
  "add a recurring event", "make an event show up on the cards", or mentions a
  specific downtown happening that should surface on a garage. Covers the weekly
  and one-off descriptor shapes, the DST/0-indexed-month gotchas, verifying the
  event maps to the right garages, and the emoji step.
---

# Adding a curated static event

The Worker's `/events` merges a live Ticketmaster proxy with a hand-curated list,
`STATIC_EVENTS` in `worker/src/index.js`, expanded per request by
`expandStaticEvents`. To add an event, append one descriptor to that list. Each is
either a `weekly` seasonal recurrence or a `one-off`, and both expand to the same
row shape the proxy emits: `{ id, title, venue, lat, lon, starts_at, ends_at, url,
classification }`. The client maps each row to nearby garages by proximity and
draws a badge + chart marker.

Static events are our own facts, so no Ticketmaster retention constraint applies,
but they are still generated live per request, never stored. Do not add an events
table or cron.

## Descriptor shape

Common fields (both kinds):

- `kind`: `"weekly"` or `"one-off"`.
- `id`: stable, unique kebab-case base id (e.g. `"dcfm-saturday-square"`). Each
  occurrence's row id gets a `-YYYYMMDD` suffix automatically; keep the base stable.
- `title`, `venue`: strings shown on the card.
- `lat`, `lon`: the venue's real coordinates (drive the garage proximity match).
- `startTime`: `[hour, minute]`, 24-hour, Central wall-clock (e.g. `[6, 15]`).
- `endTime` (optional): `[hour, minute]`, Central. Include it for anything running
  longer than a few hours (see the `ends_at` gotcha). Omit for a point-in-time event.
- `url` (optional): the event's page, for attribution / tap-through.
- `classification` (optional): the segment name driving the badge emoji.

`weekly` adds:

- `weekday`: `0`=Sunday .. `6`=Saturday.
- `seasonStart`, `seasonEnd`: `[year, month, day]`, **month 0-indexed** (Jan=0,
  Dec=11). Inclusive bounds.

`one-off` adds:

- `date`: `[year, month, day]`, **month 0-indexed**.

Worked example (the Dane County Farmers' Market: Saturdays, 6:15am–1:45pm, mid-April
through mid-November 2026):

```js
{
  kind: "weekly",
  id: "dcfm-saturday-square",
  title: "Dane County Farmers' Market",
  venue: "Capitol Square",
  lat: 43.0747,
  lon: -89.3844,
  url: "https://dcfm.org/markets/saturday-on-the-square",
  classification: "Market",
  weekday: 6, // Saturday
  startTime: [6, 15],
  endTime: [13, 45],
  seasonStart: [2026, 3, 11], // April 11, 2026 (month 3 = April)
  seasonEnd: [2026, 10, 14], // November 14, 2026 (month 10 = November)
}
```

## Verify before you commit

Run the descriptor through the project's real expansion + garage-mapping code
**before** pasting it into `STATIC_EVENTS`. From the repo root, pass a JSON file
(easiest, avoids shell-quoting apostrophes) or an inline JSON string:

```bash
node .claude/skills/add-event/scripts/verify-event.mjs --days 30 path/to/descriptor.json
```

It prints each occurrence's start/end in Central time (eyeball the day and clock),
the garages it maps to (loud warning if none), and the badge emoji (warning if the
classification has none). This catches the two silent failures: a wrong
weekday/season/date, and coordinates that map to zero garages.

Then, if the event exercises a new shape or you want a regression guard, add a case
to the `expandStaticEvents` tests in `test/worker.test.mjs` (they pass descriptors
directly, since `STATIC_EVENTS` is not exported). Run `just test`. Optionally boot
the Worker (`just worker-dev`) and `curl localhost:8787/events` to see it merged live.

## Gotchas

- **Months are 0-indexed** in `seasonStart` / `seasonEnd` / `date` (matching
  `Date.UTC`): April is `3`, November is `10`, December is `11`. This is the easiest
  mistake to make and the verify script's printed dates are how you catch it.
- **Times are Central wall-clock, never a UTC offset.** The Worker converts each
  occurrence via `wallTimeToEpochSec`, which is DST-correct, so the same `[6, 15]`
  yields 11:15Z in summer (CDT) and 12:15Z in winter (CST). Never hand-roll a ±5/6
  offset or pre-convert to UTC.
- **Coordinates must be within 500 m of a garage** (`EVENT_RADIUS_METERS`) or the
  event shows on nothing. A Capitol Square center point maps to four downtown ramps;
  a venue far from any ramp maps to none, which is a valid outcome for a distant
  venue but a bug if you meant it to appear. The verify script warns on zero.
- **A new `classification` needs an emoji.** Add it to `SEGMENT_EMOJI` in
  `site/events.js`, or the badge falls back to a generic 📅. Existing segments:
  Music 🎵, Sports 🏟️, Arts & Theatre 🎭, Film 🎬, Market 🧺, Miscellaneous 📌.
- **`endTime` controls the "ongoing" window.** With it, the card keeps showing the
  event until it truly ends; without it, the client falls back to a ~3h grace after
  the start (`EVENT_ONGOING_GRACE_SECONDS`), which is fine for a short show but wrong
  for an all-day market.
- **A `weekly` season pins a specific year and needs a yearly bump.** Season
  boundaries drift year to year, so hardcode the verified dates for the current year
  and add a comment saying so. Do not encode month-day-only ranges: that fabricates
  future years' boundaries.
- **Verify facts at the primary source, not aggregators.** Event aggregators disagree
  and hallucinate (dates, relocations, hours). Confirm season, hours, and any
  exceptions against the organizer's own page, and do not encode a detail (e.g. a
  one-week venue relocation) you cannot confirm there.
- **Do not export `STATIC_EVENTS`.** The Worker runtime treats any non-function named
  export as an entrypoint, so only functions may be exported. Tests and the verify
  script take descriptors as arguments instead.
