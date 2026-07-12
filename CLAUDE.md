# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An installable PWA showing live vacancy counts for downtown Madison's public
parking garages, for two users on Android. Three pieces, deployed together:

- **`site/`** — the PWA: vanilla JS + ES modules, **no build step**, deployed to
  GitHub Pages as raw static files.
- **`worker/`** — a Cloudflare Worker that proxies the city's JSON feed (adds
  CORS, edge-caches 60s, returns 502 on upstream failure) and, on cron triggers,
  records history into a D1 database and serves it back (see History below).
- **`.github/workflows/deploy.yml`** — one workflow: a `test` job (plain `node`)
  gates `deploy-site` (Pages) and `deploy-worker` (`wrangler deploy`), all on
  push to `main`.

Data flow (live): city feed → Worker (`API_URL`) → browser `fetch` →
`localStorage` cache + render. History: Worker cron → D1; browser →
`/history*` + `/stats` → IndexedDB cache → graphs and relative coloring. The
only persistence is the Worker's D1 history store; the client is purely a
reader (it never collects data itself).

## Hard constraints (do not violate)

- **No build toolchain, bundler, or npm deps in `site/`.** It must deploy as raw
  static files. Keep it vanilla ES modules.
- **The client never parses the upstream `modified` string into a `Date`.** It
  is a human-formatted local (Central) string with an en-dash, not ISO; the
  client displays it verbatim. The Worker *does* parse it, but carefully: as
  naive `America/Chicago` wall-clock time converted to a UTC epoch with a
  DST-correct offset (`parseFeedModified` in `worker/src/index.js`), only for
  storing `observed_at`. Never hand-roll a ±5/6 offset.
- **No capacity/percentage/gauge UI.** The feed gives vacancy *counts only*;
  there is no total-capacity data anywhere, and none is stored. Cards are
  colored *relative to each garage's own history* for the current
  `(day_of_week, hour)` (`site/coloring.js`), not by absolute thresholds. A
  garage without enough history for its cell renders **uncolored**, with no
  comparison claim: never invent a baseline.

## Garage identity

`site/garages.js` is the single source of truth mapping feed IDs to
`{ name, address, note }`. Addresses are the city's official ones and drive the
Google Maps links; notes are optional landmark hints.

Rendering (`garageEntries` in `app.js`) unions known garages with whatever the
feed returns, so an unmapped ID renders as `Ramp <id>` and a mapped ID missing
from a response renders as unavailable (never dropped). `HIDDEN_IDS` suppresses
IDs that are in the feed but shouldn't show (currently `9`, an unidentified ramp
the city itself doesn't label).

## Client refresh model (`site/app.js`)

Paint-from-cache-then-fetch: render immediately from `localStorage` last-known
data (marked stale), then fetch fresh. Refresh triggers: a self-rescheduling
timer while the tab is visible (`REFRESH_INTERVAL_MS`, also drives the countdown
bar/label), `visibilitychange` to visible, and pull-to-refresh. Fetch failure
keeps showing cached numbers marked stale; never blanks the screen.

Cards are one full-width list in a **user-adjustable order** (`parking:order`, an
ordered list of all IDs), reordered by the up/down arrows in a card's left
corners (`moveCard` swaps neighbors); the end cards' out-of-range arrow is
disabled. Any garage can be **minimized** (`parking:minimized`, a set of IDs):
the `−` button collapses its card to a compact one-line row that drops below the
full cards, and the row itself is a button that restores it (moving it to the end
of the order so it lands at the bottom of the full cards). New feed IDs append to
the order and render full by default.

Tapping a card body toggles its **trend view inline** in place (tap the header
again to collapse); at most one is expanded (`expandedId`). The view
(`site/graph.js`, `createGraphView`) is a factory that mounts a single reusable
element the app re-appends into the expanded card on each re-render, so the
selected range and loaded chart survive a background refresh. A short-term
**trend indicator** per card (filling / emptying / holding steady) comes from
`computeTrend` over the last `TREND_WINDOW_SECONDS` of locally-synced samples,
with a *relative* threshold (a fraction of the start/end average, so it scales
across small lots and large ramps); `refreshHistory` tops up the sample cache
and recomputes trends off the live-snapshot path.

## History (collection, API, client cache)

The Worker records a long-term history and the client reads it for trend graphs
and relative coloring. Full detail in `worker/README.md`; the essentials:

- **Collection** (`scheduled` handler, `worker/src/index.js`): two cron rates
  dispatched by `event.cron`. Every minute it inserts one row per garage into
  the D1 `samples` table (`STRICT, WITHOUT ROWID`); weekly it does maintenance
  (prune past the 5-year retention window, then rebuild the stats baselines).
  The primary key is `(garage_id, observed_at)` where `observed_at` is the feed's
  own timestamp as a UTC epoch, so polling faster than the feed refreshes is
  idempotent via `INSERT OR IGNORE`. There is no `capacity` column (the feed has
  none; it would be static, not time-series).
- **Stats baselines** (`stats_cells` table): the weekly cron precomputes, over
  *all* retained history, each garage's `(day_of_week, hour)` percentiles
  (`p01, p10, p25, p50, p75`, local Central), pooling each cell with the adjacent
  hours for support (within-hour 5-min samples are autocorrelated). All history,
  not a trailing window, so rare yearly/seasonal events register in the tail.
  Resolution is at the scarce end: `p01` is event-level packing; there is no
  high-tail baseline. If more cyclical resolution is ever needed (a season bin),
  it's a migration plus a change to the cell key, not a rewrite.
- **API**: `/history` (raw or SQL-bucketed hour/day aggregates), `/history/sync`
  (all garages' raw samples newer than `since`, for incremental client sync),
  `/stats` (a cheap read of the precomputed `stats_cells`).
- **Client cache** (`site/history.js`): IndexedDB stores raw samples (`samples`,
  keyed `[garage_id, ts]`) plus a cache of server bucket aggregates and stats.
  On open it syncs forward from its max `ts`, backfilling only a trailing raw
  window on a cold start, and prunes past one year. Everything degrades: if
  IndexedDB is unavailable or a fetch fails, callers fall back to the Worker and
  the live view still renders.
- **Graphs** (`site/chart.js`): hand-rolled SVG, one line plus a shaded
  min/max band, day/week/month/year toggle picking raw/hour/day buckets. Reads
  IndexedDB first for the covered window, hits the Worker for the rest.

## Service worker updates (important)

`site/sw.js` is cache-first for the app shell, so a new deploy is invisible to
installed clients unless the worker itself changes. The literal `__BUILD_ID__`
is the single build stamp: `sw.js` holds its own copy (its `CACHE_VERSION`) and
`site/version.js` exports it as `BUILD_ID` for the client. The deploy workflow
rewrites the token to the commit SHA in *every* file that carries it (the
`grep -rl __BUILD_ID__ site | xargs sed` step in `deploy.yml`), so every deploy
installs a fresh worker + shell cache. `app.js` reloads once on
`controllerchange` to apply the update live, and re-checks for a new worker
(`registration.update()`) when the tab is refocused, throttled to once every 30
minutes, so a long-open session picks up a deploy without a close/reopen. If you
touch caching, preserve
this: changing shell assets without changing `sw.js` means clients keep serving
stale files. The `SHELL` list must include every ES module the app imports
(`app.js`, `version.js`, `history.js`, `coloring.js`, `chart.js`, `graph.js`,
`garages.js`); a module missing from it won't be available offline.

A second stamp, `__ICON_HASH__`, versions the PWA icon URLs. The icon
references in `manifest.webmanifest`, `index.html`, and the `sw.js` `SHELL`
carry `./icons/icon-*.png?v=__ICON_HASH__`; the deploy replaces the token with a
content hash of the committed PNGs (`Stamp icon version` step). Android freezes
the installed WebAPK's icon at install and only re-mints when the icon *URL*
changes, so a same-path byte swap never propagates: bumping the query when (and
only when) the bytes change is what lets a new icon reach installed phones
without a reinstall. Regenerate the PNGs from the SVG source with `just icons`
after editing `site/icons/icon.svg`, and commit them so the hash reflects them.

The client's derived IndexedDB caches (bucket aggregates and `/stats` blobs)
hold values shaped by the Worker's response format. `reconcileBuildVersion`
(`site/history.js`, run once at startup before any cache read) drops them
whenever `BUILD_ID` changes, so a response-shape change across a deploy can't
leave stale-shaped entries to be served (up to their TTL) and crash a consumer.
Raw samples are schema-stable and costly to refetch, so they survive across
builds.

The API branch of the fetch handler is network-first with a cache fallback, and
must always resolve to a `Response` (a cache miss falls back to `Response.error()`,
never `undefined`, which would throw inside `respondWith`).

## Commands

Recipes live in the `justfile` (`just --list`):

- `just test` — run the test suite (plain `node`, no framework; see Testing).
- `just serve` — serve `site/` at http://localhost:8137 (hits the live Worker,
  which sends `Access-Control-Allow-Origin: *`, so localhost gets real data). To
  test against a local Worker without editing source, append
  `?api=http://localhost:8798` once (honored on localhost only, persisted in
  `localStorage`; `?api=` clears it).
- `just dump` / `just shot [file]` — headless-Chrome DOM dump / screenshot of the
  local site (boot a temp server, capture, tear down).
- `just worker-dev` — Worker locally (add `--test-scheduled` to exercise cron
  via `GET /__scheduled?cron=...`); `worker-db-create`, `worker-migrate[-local]`,
  `worker-deploy`, `worker-tail`, `worker-login` — wrangler.

## Testing

`test/` holds a no-framework harness (`harness.mjs`) run by `test/run.mjs`
(`just test`), covering the pure logic: the Worker's timestamp/timezone parsing,
percentiles, cron dispatch and retention (`worker/src/index.js` exports these);
the client's relative-coloring bands and busiest-hour forecast (`site/coloring.js`),
the recent-trend classifier (`computeTrend` in `site/history.js`); and the service
worker's offline fetch fallback (loaded into a `vm` with mocked globals). Only
functions may be exported from the Worker module besides `default` (the runtime
treats other named exports as entrypoints), so export helpers, not constants.

For runtime behavior, `node --check` each module, then drive the rendered page
in headless Chrome. See the `testing-parking-pwa` project memory for the full
playbook, including CDP driving (expand a card's inline graph, cycle ranges),
testing offline against a mock Worker, and exercising the reorder and
minimize/restore controls.

Headless Chrome on this machine needs `--password-store=basic --use-mock-keychain`
(avoids a GNOME keyring popup) and `--no-sandbox` (WSL); the `just` recipes
already include these.

## Deploying

- Point the site at the Worker via the `DEFAULT_API_URL` constant at the top of
  `site/app.js`.
- The `test` job gates both deploys (`needs: test`), so a red test suite blocks
  the deploy.
- The `deploy-worker` job needs a `CLOUDFLARE_API_TOKEN` repo secret; see
  `worker/README.md`. That job applies D1 migrations before deploying (idempotent
  `preCommands`), so a schema change ships automatically; `just worker-migrate`
  is only for local or out-of-band application.
- The D1 binding is `env.madison_parking` (set in `wrangler.toml`).
- GitHub Actions are pinned to full patch versions (per the github-actions rule),
  and Dependabot bumps them weekly.
