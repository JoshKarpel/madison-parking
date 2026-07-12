# Downtown Madison Parking

A small, installable PWA that shows live downtown Madison parking-garage vacancy
counts at a glance. Static files on GitHub Pages, fed by a Cloudflare Worker that
proxies the City of Madison's data (the upstream endpoint sends no CORS headers).

No frameworks, no build step. Vanilla JS + ES modules deployed as raw static files.

## How it works

- **`site/`** — the PWA. Renders instantly from `localStorage`-cached last-known
  data, then fetches fresh from the Worker. Favorites pin to the top (drag their
  ⠿ grip to reorder) and everything else collapses into a smaller grid below.
  Each known garage links to Google Maps and can carry a landmark note. While
  open and visible it auto-refreshes on a timer (`REFRESH_INTERVAL_MS`, shown as a
  countdown bar and "checking for update in Ns" label next to the status), and also refreshes on tab focus and on
  pull-to-refresh. Works offline (shows last-known numbers, clearly marked stale).
- **`worker/`** — a Cloudflare Worker that fetches the upstream JSON, adds CORS,
  caches at the edge for 60s, and returns a `502` on upstream failure.

The upstream data is **vacancy counts only** — there is no capacity/total data
anywhere, so there are no percentages or fullness gauges, just raw counts,
color-coded by a simple threshold (green > 150, amber 50–150, red < 50; tune the
`THRESHOLDS` constant in `site/app.js`).

The upstream `modified` timestamp is a human-formatted local (Central) string
with an en-dash, not ISO. It is displayed verbatim, never parsed into a `Date`.

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
([`deploy.yml`](.github/workflows/deploy.yml)) on every push to `main`.

### 1. One-time setup

- **Pages:** in **Settings → Pages**, set the source to **GitHub Actions**.
- **Worker:** add a `CLOUDFLARE_API_TOKEN` repo secret so the `deploy-worker`
  job can publish. Full steps in [`worker/README.md`](worker/README.md). For the
  very first deploy (to learn your `*.workers.dev` subdomain) you can also run
  `npx wrangler login && npx wrangler deploy` from `worker/` locally.

### 2. Point the site at the Worker

Edit the `API_URL` constant at the top of [`site/app.js`](site/app.js):

```js
const API_URL = "https://madison-parking.josh-karpel.workers.dev";
```

The subdomain is stable once your account has one, so this is a one-time edit.

### 3. Push

Push to `main`. The workflow runs two jobs: `deploy-site` (uploads `site/` to
GitHub Pages, no build step) and `deploy-worker` (`wrangler deploy`).

## Install on Android

1. Open the GitHub Pages URL in Chrome.
2. Tap the **⋮** menu → **Add to Home screen** (or accept the install prompt).
3. Launch it from the home screen — it opens standalone, fetches fresh data on
   open, and works offline with the last-known numbers.

Tap the ☆ on any garage to pin it to your favorites, and drag the ⠿ grip to
reorder them. Tap a garage's name to open it in Google Maps. Favorites and their
order are stored only on your own phone (`localStorage`), so you and your partner
can each pick your own: no accounts, no sync.
