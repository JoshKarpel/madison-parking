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
`/history*` + `/stats` → IndexedDB cache → graphs, fullness coloring, and the
slot-comparison tidbit. The only persistence is the Worker's D1 history store;
the client is purely a reader (it never collects data itself).

## Hard constraints (do not violate)

- **No build toolchain, bundler, or npm deps in `site/`.** It must deploy as raw
  static files. Keep it vanilla ES modules.
- **Only the Worker touches the upstream feed's `modified` timestamp.** It is a
  human-formatted local (Central) string with an en-dash, not ISO. The Worker
  parses it carefully: as naive `America/Chicago` wall-clock time converted to a
  UTC epoch with a DST-correct offset (`parseFeedModified` in
  `worker/src/index.js`), both for storing `observed_at` and for exposing that
  epoch as `observed_at` in the live snapshot response. The client works solely
  from that epoch: it formats the "Updated" line (localized to the viewer: time
  only when it's today, date and time otherwise) and its relative "N minutes ago"
  trailer from `observed_at`, and shows "unknown" when the epoch is absent. It
  never reads the `modified` string; never hand-roll a ±5/6 offset.
- **There is no *real* total-capacity figure anywhere; capacity is estimated,
  and any fullness number is labeled an estimate.** The feed gives vacancy
  *counts only*. We estimate each garage's capacity as a high-water mark (the
  99th percentile of availability over a trailing ~30-day window: a downtown ramp
  empties out overnight, so its emptiest observed state approximates its total),
  computed by the weekly cron and stored per garage in `stats_garage`, served on
  `/stats` as `capacity`. The **card headline answers "could I park here right
  now?"**: `classifyFullness`/`freePercent` (`site/coloring.js`) color the card by
  estimated fullness and fill its background left-to-right to the *available*
  percent (a longer fill = more room), with an "≈N% free (est.)" line. Always
  label it an estimate;
  never present an exact capacity or a precise gauge. A garage with no capacity
  estimate yet renders **uncolored/unfilled**. How the current count compares to
  the garage's *own history* for the current `(day_of_week, hour)` is a
  **secondary "unusual conditions" tidbit** (the comparison line, `classify`),
  never the color; a cell without enough history shows no tidbit (never invent a
  baseline).

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
full cards, and the row's `＋` button restores it (moving it to the end
of the order so it lands at the bottom of the full cards). New feed IDs append to
the order and render full by default.

The footer's help paragraph (`index.html`) names these controls in prose (which
glyph does what, how to reorder/minimize/restore). When you change a control (the
button, its glyph, or its gesture), update that paragraph to match: it drifts
silently because nothing enforces the correspondence.

A chart-toggle emoji button in the card's bottom-right corner toggles its
**trend view inline** in place (tap again to collapse); at most one is expanded
(`expandedId`). Its glyph mirrors the short-term trend (📈 emptying / 📉 filling
/ 〰️ steady or unknown). The Google Maps link sits in the top-right corner. The
view
(`site/graph.js`, `createGraphView`) is a factory that mounts a single reusable
element the app re-appends into the expanded card on each re-render, so the
selected range and loaded chart survive a background refresh. A short-term
**trend indicator** per card (filling / emptying / holding steady) comes from
`computeTrend` over the last `TREND_WINDOW_SECONDS` of locally-synced samples,
with a *relative* threshold (a fraction of the start/end average, so it scales
across small lots and large ramps); `refreshHistory` tops up the sample cache
and recomputes trends off the live-snapshot path.

## History (collection, API, client cache)

The Worker records a long-term history and the client reads it for trend graphs,
fullness coloring, and the slot-comparison tidbit. Full detail in
`worker/README.md`; the essentials:

- **Collection** (`scheduled` handler, `worker/src/index.js`): two cron rates
  dispatched by `event.cron`. Every minute it inserts one row per garage into
  the D1 `samples` table (`STRICT, WITHOUT ROWID`); weekly it does maintenance
  (prune past the 5-year retention window, then rebuild the stats). The primary
  key is `(garage_id, observed_at)` where `observed_at` is the feed's own
  timestamp as a UTC epoch, so polling faster than the feed refreshes is
  idempotent via `INSERT OR IGNORE`. The `samples` table has no `capacity` column
  (the feed reports none); capacity is *estimated* and kept separately (below).
- **Capacity estimate** (`stats_garage` table): the weekly cron estimates each
  garage's total capacity as a high-water mark of availability, the 99th
  percentile of `available_spaces` over a trailing ~30-day window
  (`CAPACITY_WINDOW_SECONDS`, `estimateCapacity`). p99 not the raw max, to shrug
  off a stray high reading; a trailing window not all history, so the estimate
  follows a real capacity change (a floor closing). It powers the "could I park?"
  fullness color and "≈N% free" readout, always labeled an estimate.
- **Stats baselines** (`stats_cells` table): the weekly cron precomputes, over
  *all* retained history, each garage's `(day_of_week, hour)` percentiles
  (`p01, p10, p25, p50, p75`, local Central), pooling each cell with the adjacent
  hours for support (within-hour 5-min samples are autocorrelated). All history,
  not a trailing window, so rare yearly/seasonal events register in the tail.
  Resolution is at the scarce (low-availability) end: `p01` is event-level
  packing. These drive the *secondary* slot-comparison tidbit ("busier than usual
  for a Sunday afternoon"), not the card color.
- **API**: `/history` (raw or SQL-bucketed hour/day aggregates), `/history/sync`
  (all garages' raw samples newer than `since`, for incremental client sync),
  `/stats` (a cheap read of `stats_cells` plus the garage's `capacity` estimate
  and a `generated_at` the client footer surfaces, flagged stale past ~a week as a
  dead-cron alarm). `POST /admin/rebuild-stats` runs the rebuild on demand
  (bearer token vs. the `ADMIN_TOKEN` secret, fails closed when unset) to
  bootstrap the stats before the first weekly cron. `just worker-rotate-token`
  sets the secret + `.env`; `just worker-rebuild-stats` invokes it.
- **Client cache** (`site/history.js`): IndexedDB stores raw samples (`samples`,
  keyed `[garage_id, ts]`) plus a cache of server bucket aggregates and stats.
  On open it syncs forward from its max `ts`, backfilling only a trailing raw
  window on a cold start, and prunes past one year. Everything degrades: if
  IndexedDB is unavailable or a fetch fails, callers fall back to the Worker and
  the live view still renders.
- **Graphs** (`site/chart.js`): hand-rolled SVG, one line plus a shaded band
  (min/max, or the "typical" p25–p75 overlay from the baseline cells), day/week/
  month/year toggle picking raw/hour/day buckets. The y-axis fits the data's own
  range (padded, floored at 0), not anchored at 0, so a garage sitting far from
  empty still fills the plot. Reads IndexedDB first for the covered window, hits
  the Worker for the rest.

## Service worker updates (important)

`site/sw.js` is cache-first for the app shell, so a new deploy is invisible to
installed clients unless the worker itself changes. The literal `__BUILD_ID__`
is the single build stamp: `sw.js` holds its own copy (its `CACHE_VERSION`) and
`site/version.js` exports it as `BUILD_ID` for the client. The deploy workflow
rewrites the token to the commit SHA in *every* file that carries it (the
`grep -rl __BUILD_ID__ site | xargs sed` step in `deploy.yml`), so every deploy
installs a fresh worker + shell cache. `app.js` reloads once on
`controllerchange` to apply the update live, and re-checks for a new worker
(`registration.update()`) both right after registering on `load` (so a cold
launch proactively catches a deploy) and when the tab is refocused (throttled to
once every 30 minutes, so a long-open session picks up a deploy without a
close/reopen). A collapsed **Debug** menu in the footer surfaces the running
`BUILD_ID`, the storage estimate, and a **reset** button that clears every layer
of client state (localStorage, IndexedDB, Cache Storage, service-worker
registrations) then reloads: the escape hatch for a client wedged on a stale
shell or stale cached data that a fresh (incognito) context wouldn't have. If you
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
percentiles, capacity estimate, cron dispatch and retention (`worker/src/index.js`
exports these); the client's fullness bands and free percent, slot-comparison
bands, and busiest-hour forecast (`site/coloring.js`), the recent-trend classifier
and relative-time/stats-freshness helpers (`site/history.js`); and the service
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
