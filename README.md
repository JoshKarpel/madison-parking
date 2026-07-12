# Downtown Madison Public Parking

A small, installable PWA that shows live vacancy counts for downtown Madison's
public parking garages at a glance, with per-garage trend charts and coloring
relative to each garage's own history. Static files on GitHub Pages, fed by a
Cloudflare Worker that proxies the City of Madison's data (the upstream endpoint
sends no CORS headers) and records history into a D1 database.

No framework, no bundler. Vanilla JS + ES modules deployed as raw static files.

## How it works

- **`site/`** — the PWA. Renders instantly from `localStorage`-cached last-known
  data, then fetches fresh from the Worker. Garages show as one full-width list
  in a user-adjustable order: reorder with the ▲▼ arrows, and minimize any garage
  you don't need with − to a compact row at the bottom (tap the row to restore
  it). Each garage links to Google Maps (🗺️) and can carry a landmark note, and a
  chart button (📈/📉/〰️, mirroring the short-term trend) expands an inline trend
  graph in place. While open and visible it auto-refreshes on a timer
  (`REFRESH_INTERVAL_MS`, shown as a countdown bar and a "checking for update in
  Ns" label next to the status), and also on tab focus and pull-to-refresh. Works
  offline (shows the last-known numbers, clearly marked stale).
- **`worker/`** — a Cloudflare Worker that fetches the upstream JSON, adds CORS,
  caches at the edge for 60s, and returns a `502` on upstream failure. On a cron
  schedule it also records each garage's vacancy into a D1 database and serves
  that history back, powering the trend charts, the fullness coloring, and the
  slot-comparison tidbit. See [`worker/README.md`](worker/README.md) for the
  history and stats detail.

The upstream data is **vacancy counts only** — the feed reports no total
capacity. So the app *estimates* each garage's capacity (a high-water mark of
availability over recent history) and uses it for the headline question, "could I
park here right now?": each card is colored and its background filled left-to-right
by how much room is left (a longer fill = more open), with an "≈N% free (est.)"
line — always labeled an estimate, never an exact gauge. How the current count compares to that garage's
*own* history for the day-of-week and hour is a smaller secondary tidbit ("busier
than usual for a Sunday afternoon"), for spotting unusual conditions. A garage
with no capacity estimate yet renders uncolored. See
[`site/coloring.js`](site/coloring.js).

The upstream `modified` timestamp is an ambiguous human-formatted local (Central)
string with an en-dash, not ISO. Only the Worker parses it, to a DST-correct UTC
epoch (`observed_at`); the client shows a localized "Updated" time plus a relative
"N minutes ago" derived from that epoch, and never parses the string itself.

## Garage ID mapping

Derived by correlating the JSON against the city's
[current hourly parking availability](https://www.cityofmadison.com/parking/garages-lots/current-hourly-parking-availability)
table.

| ID | Garage |
|----|--------|
| 1  | Overture Center |
| 2  | State Street Capitol |
| 5  | State Street Campus |
| 6  | Capitol Square North |
| 18 | South Livingston St |
| 19 | Wilson Street |

**ID 9 caveat:** ID 9 appears in the data feed but not in the city's HTML table,
so we don't know which garage it is. It is hidden from the display via the
`HIDDEN_IDS` set in [`site/app.js`](site/app.js); remove it there if the city
ever documents what it is. Any other unmapped ID still renders as `Ramp <id>`
(rather than crashing), and any mapped ID missing from a response renders as
unavailable (rather than being dropped).

Edit the mapping (and per-garage landmark `note`s) in
[`site/garages.js`](site/garages.js).

## Deploy

Both the site and the Worker deploy from the same GitHub Actions workflow
([`deploy.yml`](.github/workflows/deploy.yml)) on every push to `main`, gated by
a `test` job that must pass first.

### 1. One-time setup

- **Pages:** in **Settings → Pages**, set the source to **GitHub Actions**.
- **Worker:** add a `CLOUDFLARE_API_TOKEN` repo secret so the `deploy-worker`
  job can publish. Full steps in [`worker/README.md`](worker/README.md). For the
  very first deploy (to learn your `*.workers.dev` subdomain) you can also run
  `just worker-login && just worker-deploy` locally.

### 2. Point the site at the Worker

Edit the `DEFAULT_API_URL` constant at the top of [`site/app.js`](site/app.js):

```js
const DEFAULT_API_URL = "https://madison-parking.josh-karpel.workers.dev";
```

The subdomain is stable once your account has one, so this is a one-time edit.

### 3. Push

Push to `main`. The `test` job runs first and gates two deploy jobs: `deploy-site`
(uploads `site/` to GitHub Pages, no bundler) and `deploy-worker` (`wrangler
deploy`, applying D1 migrations first).

## Install on Android

1. Open the GitHub Pages URL in Chrome.
2. Tap the **⋮** menu → **Add to Home screen** (or accept the install prompt).
3. Launch it from the home screen — it opens standalone, fetches fresh data on
   open, and works offline with the last-known numbers.

Reorder garages with the ▲▼ arrows and minimize the ones you don't need with −
(tap a minimized row to restore it). Tap 🗺️ to open a garage in Google Maps, and
the chart button for its trends. Your order and which garages are minimized are
stored only on your own phone (`localStorage`), so you and your partner can each
arrange your own: no accounts, no sync.
