# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An installable PWA showing live vacancy counts for downtown Madison's public
parking garages, for two users on Android. Three pieces, deployed together:

- **`site/`** — the PWA: vanilla JS + ES modules, **no build step**, deployed to
  GitHub Pages as raw static files.
- **`worker/`** — a Cloudflare Worker that proxies the city's JSON feed (adds
  CORS, edge-caches 60s, returns 502 on upstream failure) and, on cron triggers,
  records history into a D1 database and serves it back (see History below). It
  also proxies upcoming venue events from the Ticketmaster Discovery API
  (`/events`), **live and never stored** (their terms forbid retention), so the
  client can correlate a crowd with parking demand (see Events below). It also
  emits one aggregate Analytics Engine data point per request (endpoint + coarse
  country + status, no per-user identifier) for a rough usage signal; see
  `worker/README.md`.
- **`.github/workflows/deploy.yml`** — one workflow: a `test` job (plain `node`)
  gates `deploy-site` (Pages) and `deploy-worker` (`wrangler deploy`), all on
  push to `main`.

Data flow (live): city feed → Worker (`API_URL`) → browser `fetch` →
`localStorage` cache + render. History: Worker cron → D1; browser →
`/history*` + `/stats` → IndexedDB cache → graphs, fullness coloring, and the
slot-comparison tidbit. Events: Worker → Ticketmaster Discovery API (`/events`,
live proxy, never stored) → browser → short-lived IndexedDB cache → per-garage
event badges + chart markers. The only persistence is the Worker's D1 history
store; the client is purely a reader (it never collects data itself), and event
data is never persisted anywhere.

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
- **Event data is proxied live and never persisted.** Ticketmaster's terms allow
  caching Event Content only "for reasonable periods to provide the service", so
  `/events` fetches the Discovery API on demand, edge-caches ~1h, and the client
  keeps only a short-lived IndexedDB cache. There is deliberately no events table
  and no events cron (unlike the parking samples, which are the city's own data
  we do retain in D1). Don't add historical event storage. The Worker stays
  garage-agnostic: it ships each venue's coordinates and the client maps events
  to nearby garages (`site/events.js`), so garage identity stays solely in
  `site/garages.js`. Events link back to their Ticketmaster page (attribution).
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
`{ name, address, placeCid, lat, lon, note }`. Addresses are the city's official
ones and drive the Google Maps links; notes are optional landmark hints; `lat`/
`lon` (geocoded from the address) let the client match nearby venue events to a
garage (`site/events.js`).

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
current pan/zoom window and loaded chart survive a background refresh. A short-term
**trend indicator** per card (filling / emptying / holding steady) comes from
`computeTrend` over the last `TREND_WINDOW_SECONDS` of locally-synced samples,
with a *relative* threshold (a fraction of the start/end average, so it scales
across small lots and large ramps); `refreshHistory` tops up the sample cache
and recomputes trends off the live-snapshot path.

## Theming

The look is fully CSS-variable driven, so a theme is a values swap. Two
independent preferences, each a `<html>` attribute the stylesheet keys off, and
each a footer segmented button control: theme (six buttons, each a **live
preview** styled in its own theme's font/colors/border), appearance (three
buttons):

- **theme** (`data-theme`): `default` (rounded, sans-serif), `terminal`
  (monospace CRT: self-hosted JetBrains Mono, square 2px borders,
  green/amber/grey-white phosphor), `geocities` (a 1996-homepage parody: Comic
  Sans, ridge borders, neon clash, tiled background, rainbow header, blink,
  haloed pixel budgie + cockatiel), `windows` (Windows 98: Tahoma, silver
  panels on a teal
  desktop, a box-shadow bevel adapted from 98.css; dark = High Contrast Black),
  or `collegiate` (clean red-and-white: cardinal `#c5050c` accent, near-sharp
  corners, self-hosted Red Hat Display headings + Red Hat Text body, both Red
  Hat's SIL OFL faces; deliberately uses only the free color and fonts, no
  protected mark, logo, crest, or mascot), or `sky` (translucent "glass" panels
  over a **live photo of the sky above downtown Madison**: `site/sky.js` mounts a
  fixed crossfading background driven by a single background timer that reloads a
  fresh cache-busted frame each tick, from the UW-Madison AOSS building's rooftop
  cameras. A sky-only footer control row (shown only under this theme) picks the
  view: a fixed compass camera (E/S/W/NW/N), `loop` (cycle all five in order), or
  `shuffle` (cycle at random), persisted as `parking:sky-view`. The button for the
  camera currently on screen gets a green glowing rim (an `onView` callback from
  `sky.js` toggling `.current`), so the live view is obvious even mid-rotation. A
  **Full-sky peek**
  button hides the app chrome to show the whole photo, keeping the view picker and
  a Show-app exit floated at the top (the `sky-peek` body class); leaving the theme
  clears it. The theme's sky gradient is the offline/failed-frame fallback. The
  imagery is the only external network dependency the client has beyond the Worker;
  AOSS asks for attribution, carried by the `.sky-credit` footer line shown only
  under this theme).
  **"default" is the attribute's absence**, so CSS only ever names non-default
  themes.
- **appearance** (`data-scheme`): light/dark, defaulting to the system
  preference or forced. The `System`/`Light`/`Dark` buttons set the preference
  (the pressed one carries it via `aria-pressed`); it is **always resolved to
  `light`/`dark` by JS** (never left to a `prefers-color-scheme` query), so a
  forced choice can override the OS and the stylesheet needs no media query.

`site/style.css` defines the light palette + structural knobs (`--font-family`,
`--border-width`, `--border-style`, `--radius*`) in `:root`, the dark palette in
`:root[data-scheme="dark"]`, and the terminal overrides in
`:root[data-theme="terminal"]` / `...[data-scheme="dark"]`. `site/theme.js` is
the single source of truth: valid ids (`THEMES`, `COLOR_SCHEMES`), the
`normalize*` guards, and `applyTheme`/`applyColorScheme` (toggle the attribute,
resolve the scheme, repoint the `theme-color` meta). The head of `index.html`
has a tiny inline script that applies both stored choices *before first paint*
to avoid a flash; `app.js` owns the theme and appearance button groups,
persistence (`parking:theme`, `parking:color-scheme`), and re-resolving on a
system light/dark change. A new
theme = a `THEMES` entry, a `THEME_COLORS` entry, a light + a dark CSS block, a
`.theme-btn[data-theme="…"]` preview block, and a `<button>` (plus a font in
`site/fonts/` + `@font-face` + the `sw.js` SHELL if it needs one, or a JS module
in the SHELL and wired through `app.js`'s theme handler, as `sky` does).

**Specificity invariant:** the default-dark block `:root[data-scheme="dark"]`
(0,2,0) and a theme's light block `:root[data-theme="X"]` (0,2,0) both match when
that theme is active in dark mode, so a theme's dark block
`:root[data-theme="X"][data-scheme="dark"]` (0,3,0) MUST redefine **every**
palette variable it wants to change; anything it leaves out falls through to the
default-dark slate palette, not the theme's light value.

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
- **Graphs** (`site/chart.js` renders, `site/graph.js` drives): hand-rolled SVG
  over a **free time window** the user pans and zooms, not a fixed range.
  `renderChart(spec)` draws an explicit `domain: {t0, t1}` (so it can show empty
  space or the future), takes the `actual` history line plus one `typical` series
  (the p50 median with its p25–p75 band) spanning the whole window, marks `nowTs`
  with a divider, clips the data layers
  to the plot, and returns a controller (`svg`, `content`, `plot`, `tsAtClientX`,
  `crosshairAtClientX`, `hideCrosshair`) that `graph.js` drives. The y-axis is
  anchored at 0 (top padded to fit the data), so proximity to empty stays
  readable rather than the axis floating up to the data's own range. Reads
  IndexedDB first for the covered window, hits the Worker for the rest.
  - **Pan/zoom** (`graph.js`, `wireGestures`): drag to pan through time, wheel or
    two-finger pinch to zoom; the bucket (raw/hour/day) and label format follow
    the visible span (`scaleForSpan`). During a gesture the drawn `content` is
    transformed (translate+scale) for instant feedback and the data reloads once
    it settles, so the SVG isn't rebuilt mid-gesture (which would drop pointer
    state). A span of headroom is loaded on each side so a pan reveals loaded
    data before it reloads.
  - **Presets** are "last N" windows (`6h`/`Day`/`Week`/`Month`), each showing
    `past` back from now plus a small forecast peek ahead; a zoom clears the
    active preset.
  - **Typical overlay / forecast** (`typicalSeries`): one continuous series across
    the *whole* window supplies the baseline *typical* count for each `(day, hour)`
    — the p50 median with its p25–p75 band, one point per hour (thinned on a wide
    window) plus an anchor exactly at `now`, gaps where a cell lacks support. It's
    drawn as a single line whose style switches at `now`: faint grey context behind
    the recorded past, the bolder dashed forecast ahead (the two halves share the
    `now` anchor, so the line never breaks at the divider). Ahead of `now` it's
    labeled "typical", not a claim about the specific future. The daily zoom
    (`scaleForSpan`'s `useBaseline: false`) clips the overlay to `now` onward, since
    the past band is noise over months of real data.
  - **Crosshair**: a transparent capture surface over the plot; a tap or hover
    snaps to the nearest actual-or-forecast sample and floats a readout of its
    time (`pointFormat`) and count (future points tagged "(typical)"). A mouse
    hover clears on leave and on pan start; a touch readout persists until the
    next tap.
  - **Event markers** (`renderChart`'s `events`, fed by `graph.js`'s injected
    `getEvents`): a vertical tick + category emoji at each nearby event's start
    within the window, in a layer *above* the capture surface so the emoji stays
    tappable. `graph.js` opens the show's Ticketmaster page on a tap (via the hit
    rect's `data-url`); a plain SVG anchor can't be used, since the pan gesture's
    pointer capture would swallow the click. Markers carry the event's `url`
    end-to-end and pan/zoom in lockstep with the data content.

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
`garages.js`, `events.js`, `theme.js`) plus the self-hosted theme fonts
(`fonts/*.woff2`); a module or asset missing from it won't be available offline.

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
percentiles, capacity estimate, cron dispatch and retention, and Ticketmaster
event parsing (`worker/src/index.js` exports these); the client's fullness bands
and free percent, slot-comparison bands, and busiest-hour forecast
(`site/coloring.js`), the recent-trend classifier and relative-time/stats-freshness
helpers (`site/history.js`), and the venue-to-garage event mapping
(`site/events.js`); and the service worker's offline fetch fallback (loaded into
a `vm` with mocked globals). Only
functions may be exported from the Worker module besides `default` (the runtime
treats other named exports as entrypoints), so export helpers, not constants.

For runtime behavior, `node --check` each module, then drive the rendered page in
a real browser. See the `testing-parking-pwa` project memory for the full
playbook (expand a card's inline graph, cycle ranges, test offline against a mock
Worker, exercise the reorder and minimize/restore controls).

**Driving the browser (Playwright).** The system `google-chrome` isn't reliably
on PATH here, so browser-driven checks use Playwright's headless Chromium. Run
`just setup` once (installs the `playwright` package and its Chromium build; both
are dev-only and git-ignored, so the committed tree stays free of npm deps, and
this is *not* part of `just test`, which stays plain `node` for CI). Then drive
the page from a throwaway node script (keep it in the scratchpad, not the repo):
serve `site/` with a tiny static server (or `just serve`), `import` playwright
from the repo's `node_modules` (a CJS interop caveat: `const chromium =
(await import(".../node_modules/playwright/index.js")).default.chromium`), launch
with `args: ["--no-sandbox"]` (WSL), load the page, and exercise it. This is the
reliable way to catch DOM-render bugs that pure-logic unit tests can't: e.g. a
marker was drawn but unclickable because `graph.js` dropped the event's `url`
before handing it to the chart — invisible to `node --check` and the unit suite,
caught immediately by clicking a `.chart-event-hit` and asserting a `page` popup
opens on its Ticketmaster `data-url`.

The legacy `just shot`/`just dump` recipes shell out to a system `google-chrome`
with `--password-store=basic --use-mock-keychain` (avoids a GNOME keyring popup)
and `--no-sandbox` (WSL); use them only where that binary is actually present.

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
