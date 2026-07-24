# Madison Parking Worker

A tiny Cloudflare Worker that proxies the City of Madison ramp-availability JSON
and adds the CORS headers the browser needs (the upstream sends none). It also
caches the upstream response at the edge for 60s so we don't hammer the city.

## What it does

- `GET /` → fetches
  `https://www.cityofmadison.com/parking/data/ramp-availability.json` and returns
  its `modified` + `vacancies` plus an added `observed_at` (the `modified` string
  parsed to a UTC epoch, for the client's localized "Updated" line and "N minutes
  ago"), with:
  - `Access-Control-Allow-Origin: *`
  - `Cache-Control: public, max-age=30`
- Caches upstream at the edge for 60s (`cf: { cacheTtl: 60 }`).
- On upstream failure, returns a `502` with a JSON error body (never a broken `200`).
- Handles `OPTIONS` preflight.

Beyond the live snapshot it records history into a D1 database and serves it
back for the trend graphs, the fullness coloring ("could I park here right
now?"), and a secondary slot-comparison tidbit ("busier than usual for this
day and hour").

## History collection

Two [cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
(`wrangler.toml`) drive a `scheduled` handler; `event.cron` selects which runs:

- `* * * * *` (every minute) fetches the feed and inserts one row per garage
  into the `samples` table. The feed only refreshes every few minutes, so most
  ticks are no-ops: each sample's primary key is `(garage_id, observed_at)`
  where `observed_at` is the feed's own `modified` timestamp, and
  `INSERT OR IGNORE` drops a sample whose timestamp we already stored. Polling
  faster than the feed refreshes means we never miss an update, idempotently.
- `30 4 * * SUN` (weekly, Sunday) does maintenance off the request path: prune
  samples older than the retention window (5 years), then rebuild the stats: the
  `stats_cells` slot baselines and the `stats_garage` capacity estimates. Weekly,
  not daily, because the rebuild scans all retained history per garage; the
  baselines barely move week to week, so this stays well inside D1's free-tier
  read budget. (Cloudflare's weekday field is 1-7 with 1=Sunday, not Unix's 0-6,
  so `SUN` avoids an out-of-range `0`.)

The feed reports `modified` as naive local Madison time (for example
`"July 12, 2026 – 10:05am"`). It is parsed as `America/Chicago` and normalized to
UTC epoch seconds before storage, with a DST-correct offset derived from
`Intl.DateTimeFormat`. A sample whose timestamp is unparseable is skipped (no
fabricated timestamp), keeping collection idempotent.

## History API

- `GET /history?garage=<id>&since=<epoch>&until=<epoch>&bucket=<raw|hour|day>`
  returns one garage's samples over a range. `raw` returns stored samples;
  `hour`/`day` aggregate in SQL (`AVG`/`MIN`/`MAX` per bucket). Ranges past the
  per-bucket cap return `400`. Settled ranges are cached hard; ranges touching
  now are cached briefly.
- `GET /history/sync?since=<epoch>` returns every garage's raw samples newer
  than `since`, as compact `[garage_id, ts, available]` tuples, paginated via a
  `complete` flag. This is what the client polls to top up its local cache.
- `GET /stats?garage=<id>` returns the garage's estimated `capacity` (for the
  fullness color and "≈N% free" readout), the precomputed per-`(day_of_week,
  hour)` percentile baselines (`p01, p10, p25, p50, p75`, for the slot-comparison
  tidbit and the chart's "typical" overlay), and `generated_at` (when the stats
  were last rebuilt). A cheap read of `stats_cells` + `stats_garage`; see below
  for how they're built.
- `POST /admin/rebuild-stats` runs the stats rebuild on demand, so the baselines
  can be populated before the first weekly cron fires. It is gated by a bearer
  token that MUST match the `ADMIN_TOKEN` secret (`Authorization: Bearer
  <token>`) and fails closed with `403` when no token is configured. Use the
  `just worker-rotate-token` recipe to set the secret and `just
  worker-rebuild-stats` to invoke it.

## Events

To help explain a crowded ramp, the Worker surfaces upcoming events at nearby
venues (a concert, a game) from the
[Ticketmaster Discovery API](https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/).

- `GET /events` returns upcoming events near downtown as slim rows
  (`{ id, title, venue, lat, lon, starts_at, ends_at, url, classification }`),
  sorted by start. `starts_at` (and `ends_at`, a known end time or `null`) is UTC
  epoch seconds, like `samples.observed_at`. Cached at the edge and in the browser
  for an hour (`EVENTS_CACHE_TTL_SECONDS`); the request window is floored to the
  hour so repeat calls reuse the same upstream response. On a Ticketmaster upstream
  error it returns `502`; with no API key configured it returns the curated static
  events only (below).

**Not stored.** Unlike the parking samples (the city's own data, which we
retain), event data is *proxied live and never persisted*. Ticketmaster's
[terms](https://developer.ticketmaster.com/support/terms-of-use/) permit caching
Event Content only "for reasonable periods in order to provide the service", so
there is no events table and no cron: the Worker fetches on demand, edge-caches
briefly, and the client keeps only a short-lived cache. Each event links back to
its Ticketmaster page.

The Worker stays garage-agnostic here too: it ships the venue's coordinates and
lets the client match each event to the garages within walking distance
(`site/events.js`), so garage identity stays solely in `site/garages.js`.

**Curated static events.** Some downtown gatherings aren't in Ticketmaster and
are too irregular to scrape (a recurring farmers' market, one-off festivals), so
they're described in `STATIC_EVENTS` and merged into `/events` in the same row
shape. Being our own facts rather than Ticketmaster Event Content, they carry no
retention constraint, but they're still generated live per request
(`expandStaticEvents`) rather than stored. Each descriptor is a `weekly` seasonal
recurrence or a `one-off`, expanded to concrete occurrences whose Central
wall-clock start (and optional end) times pass through `wallTimeToEpochSec` so the
epochs stay DST-correct. A weekly season pins a verified year and wants a yearly
bump.

### Set the API key

`GET /events` needs a Ticketmaster Discovery API key in the `TICKETMASTER_API_KEY`
secret (a free Consumer Key from
[developer.ticketmaster.com](https://developer.ticketmaster.com/) → My Apps).
Put it in the repo-root `.env` and push it to the Worker with
`just worker-set-ticketmaster-key`. For local `wrangler dev`, add the same line
to `worker/.dev.vars` (git-ignored). Without the key the endpoint returns an
empty list.

## Usage metrics

To get a rough sense of how much the app is used without tracking anyone, the
Worker writes one [Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/)
data point per request (`recordRequest`, `wrangler.toml` binding
`usage_analytics`, dataset `madison_parking_usage`). Each point carries only:

- `blob1` — the endpoint label (`snapshot`, `history`, `sync`, `stats`, `admin`),
  collapsed from the path so cardinality stays tiny.
- `blob2` — the coarse request country (`request.cf.country`, or `XX` when
  absent).
- `blob3` — the response status code.

There is deliberately **no per-user identifier** and nothing is stored on the
client, so this stays outside GDPR/ePrivacy personal-data territory: it counts
events, never people. The write is fire-and-forget and guarded, so local dev and
the test harness (which have no binding) are no-ops. The dataset is created on
first write; the built-in Workers Analytics dashboard is unaffected and still
shows raw invocation counts.

Query it over the [SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)
with an API token that has **Account Analytics → Read** (retention is 90 days):

```sh
curl -s "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $CF_ANALYTICS_TOKEN" \
  --data "SELECT blob1 AS endpoint, blob2 AS country,
                 SUM(_sample_interval) AS requests
            FROM madison_parking_usage
           WHERE timestamp >= NOW() - INTERVAL '7' DAY
           GROUP BY endpoint, country
           ORDER BY requests DESC"
```

Use `SUM(_sample_interval)` rather than `COUNT(*)`: at this app's request volume
no sampling happens (the two are equal), but the sum is the sampling-correct form
if volume ever climbs. Since the client polls while a tab is visible, request
volume tracks *open-tab time* more than distinct visits; read it as a usage
signal, not a head-count.

## Fullness estimate and slot baselines

The weekly rebuild produces two things, computed off the request path so `/stats`
stays a cheap indexed read (and to stay inside D1's free-tier read budget, which
a per-request full scan would blow).

### Capacity estimate → the fullness headline (`stats_garage`)

The card's headline answers "could I park here right now?" by coloring the card
and filling its background to how much room is left (a longer fill = more open).
That needs a total to divide by, and the feed reports none, so we **estimate**
each garage's capacity:

- **A high-water mark of availability.** A downtown ramp empties out overnight, so
  the emptiest it's observed approximates its total. We take the 99th percentile
  of `available_spaces` (`estimateCapacity`), not the raw max, so a single stray
  high reading can't inflate the estimate. By construction the live count can sit
  above p99 (~1% of readings); the client clamps the available share to
  `[0, 100]`, so that reads as "≈100% free", never a nonsensical value.
- **Over a trailing ~30-day window,** not all history (`CAPACITY_WINDOW_SECONDS`).
  Capacity can actually change (a floor closing), so a trailing window lets the
  estimate follow it instead of pinning a value that no longer holds.
- **Always an estimate.** The client labels it "≈N% free (est.)" and never shows
  an exact capacity or a precise gauge. A garage with no estimate yet (too little
  history) renders uncolored/unfilled.

### Slot baselines → the "unusual for the time?" tidbit (`stats_cells`)

A *secondary* signal: how the current count compares to what's normal for that
garage at this day and hour ("busier than usual for a Sunday afternoon"), plus the
"typical" p25–p75 band the trend chart shades behind the actual line. A per-garage,
per-`(day_of_week, hour)` distribution of `available_spaces`, summarized as
percentiles. Deliberate choices:

- **Built from all retained history, not a trailing window.** A given
  `(day_of_week, hour)` cell recurs only about once a week, so recurring yearly
  and seasonal events (a summer farmer's market, an annual festival) only appear
  a handful of times across several years. Using every retained sample (the
  5-year retention is the effective bound) is what lets those show up in the
  extreme tail instead of being averaged away. (This is the opposite choice from
  the capacity estimate above, which *does* want a trailing window — the two
  signals answer different questions.)
- **Adjacent hours pooled.** Within an hour the 5-minute samples barely move
  (people park for a while), so a single `(day, hour)` cell has far fewer
  *independent* observations than raw counts imply, too few to place an extreme
  percentile. Each cell pools the hour on either side, which are similar, to bulk
  up support and smooth the baseline.
- **Percentiles computed in JS.** SQLite has no `PERCENTILE_CONT`, and one query
  per cell would be a flood of round-trips, so the cron pulls each garage's rows
  once and buckets and summarizes them in the Worker.
- **Resolution only at the scarce end.** `p01` marks event-level packing, up
  through `p75`; above that a garage is comfortably open and no finer gradation is
  stored, since the tidbit only cares whether the count is unusually *low*
  (busier than usual).
- **Keyed on `(day_of_week, hour)`.** Richer cycles (month, season) were
  considered but not adopted: every added dimension multiplies the cells and
  divides the per-cell support, which fights the tail-stability the pooling and
  full-history choices buy. A coarse season bin is the natural next step if the
  data ever shows it's needed; adding it is a migration plus a change to the cell
  key. Until a cell has at least a few observations the client shows no tidbit
  rather than guessing.

While history is still filling in (the weeks right after collection starts), the
fullness color appears quickly (the capacity estimate only needs *some* recent
samples), but the slot tidbit can lag: it needs the cell for the *current*
`(day_of_week, hour)`, which only appears once the weekly rebuild has run over
history covering that hour. Two effects compound for the tidbit during this
window: the current hour's cell may simply not exist yet, and the client caches
`/stats` in IndexedDB for a few hours (`STATS_TTL_SECONDS` in `site/history.js`),
so a "cold" fetch made before the cell existed keeps serving the cell-less
response until that cache expires. It resolves on its own as history accumulates;
to force it sooner, rebuild the stats (`just worker-rebuild-stats`) and reopen the
app.

## Set up the database

Create the D1 database once, then paste the returned id into `wrangler.toml`:

```sh
just worker-db-create          # wrangler d1 create madison-parking
```

CI applies migrations automatically: the `deploy-worker` job runs
`wrangler d1 migrations apply madison-parking --remote` before each deploy. That
is idempotent (wrangler tracks applied migrations in `d1_migrations` and skips
them), so a push with no new migration is a no-op. Creating the database and
pasting its id into `wrangler.toml` is the only manual step.

To apply migrations by hand (local dev, or a one-off out of band):

```sh
just worker-migrate            # remote (production) database
just worker-migrate-local      # local dev database
```

## Deploy

You need a (free) Cloudflare account. No `wrangler.toml` edits are required.

### From CI (default)

The GitHub Actions workflow (`.github/workflows/deploy.yml`) deploys this Worker
on every push to `main`, alongside the static site. It needs one repo secret:

1. Create a Cloudflare API token starting from the **Edit Cloudflare Workers**
   template: Cloudflare dashboard → **My Profile → API Tokens → Create Token →
   Edit Cloudflare Workers**.
2. **Add a D1 permission before creating it.** That template does *not* include
   D1, but this Worker binds a D1 database and the deploy applies D1 migrations,
   so under **Permissions** add a row: **Account → D1 → Edit**. Without it the
   deploy fails with `code: 7403` ("not authorized to access this service"). An
   existing token can be edited to add the row instead of recreating it.
3. Add the token to the repo: **Settings → Secrets and variables → Actions → New
   repository secret**, named `CLOUDFLARE_API_TOKEN`.

Push to `main` and the `deploy-worker` job applies any new migrations and runs
`wrangler deploy`. Its log prints the deployed `*.workers.dev` URL (see below).

### From your machine (first deploy / local testing)

```sh
cd worker
npx wrangler login      # opens a browser to authenticate (first time only)
npx wrangler deploy
```

On success, wrangler prints the deployed URL, e.g.:

```
Published madison-parking
  https://madison-parking.josh-karpel.workers.dev
```

That `https://madison-parking.josh-karpel.workers.dev` URL is your API. The
subdomain is stable once your account has one, so CI redeploys keep the same URL.

## Point the site at it

Edit `site/app.js` and replace the `DEFAULT_API_URL` constant at the top with the
URL wrangler printed:

```js
const DEFAULT_API_URL = "https://madison-parking.josh-karpel.workers.dev";
```

Commit and push; GitHub Actions redeploys the site.

## Test it

```sh
curl -i https://madison-parking.josh-karpel.workers.dev
```

You should see `access-control-allow-origin: *`, `cache-control: public, max-age=30`,
and a JSON body with `modified`, `vacancies`, and `observed_at` (the `modified`
string parsed to a UTC epoch, which the client uses for its localized "Updated"
line and relative "N minutes ago" trailer).
