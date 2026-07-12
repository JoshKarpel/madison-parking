# Madison Parking Worker

A tiny Cloudflare Worker that proxies the City of Madison ramp-availability JSON
and adds the CORS headers the browser needs (the upstream sends none). It also
caches the upstream response at the edge for 60s so we don't hammer the city.

## What it does

- `GET /` → fetches
  `https://www.cityofmadison.com/parking/data/ramp-availability.json`,
  returns it verbatim with:
  - `Access-Control-Allow-Origin: *`
  - `Cache-Control: public, max-age=30`
- Caches upstream at the edge for 60s (`cf: { cacheTtl: 60 }`).
- On upstream failure, returns a `502` with a JSON error body (never a broken `200`).
- Handles `OPTIONS` preflight.

Beyond the live snapshot it records history into a D1 database and serves it
back for the trend graphs and relative coloring.

## History collection

Two [cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
(`wrangler.toml`) drive a `scheduled` handler; `event.cron` selects which runs:

- `* * * * *` (every minute) fetches the feed and inserts one row per garage
  into the `samples` table. The feed only refreshes every few minutes, so most
  ticks are no-ops: each sample's primary key is `(garage_id, observed_at)`
  where `observed_at` is the feed's own `modified` timestamp, and
  `INSERT OR IGNORE` drops a sample whose timestamp we already stored. Polling
  faster than the feed refreshes means we never miss an update, idempotently.
- `30 4 * * 0` (weekly, Sunday) does maintenance off the request path: prune
  samples older than the retention window (5 years), then rebuild the `/stats`
  baselines into `stats_cells`. Weekly, not daily, because the rebuild scans all
  retained history per garage; a multi-year baseline barely moves week to week,
  so this stays well inside D1's free-tier read budget.

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
- `GET /stats?garage=<id>` returns the precomputed per-`(day_of_week, hour)`
  percentile baselines (`p01, p10, p25, p50, p75`) used for relative coloring. A
  cheap read of `stats_cells`; see below for how they're built.

## Relative-coloring baselines

The client colors each garage by how its current count compares to what's normal
for that garage at this day and hour, and the trend charts shade a "typical"
range behind the actual line. Both come from `stats_cells`: a per-garage,
per-`(day_of_week, hour)` distribution of `available_spaces`, summarized as
percentiles. The design reflects a few deliberate choices.

- **Precomputed weekly, not per request.** The `/stats` endpoint is a cheap
  indexed read. The weekly maintenance cron does the expensive work and writes
  the result, keeping the computation off the request path (and off D1's
  free-tier read budget, which a per-request full scan would blow).
- **Built from all retained history, not a trailing window.** A given
  `(day_of_week, hour)` cell recurs only about once a week, so recurring yearly
  and seasonal events (a summer farmer's market, an annual festival) only appear
  a handful of times across several years. Using every retained sample (the
  5-year retention is the effective bound) is what lets those show up in the
  extreme tail instead of being averaged away.
- **Adjacent hours pooled.** Within an hour the 5-minute samples barely move
  (people park for a while), so a single `(day, hour)` cell has far fewer
  *independent* observations than raw counts imply, too few to place an extreme
  percentile. Each cell pools the hour on either side, which are similar, to bulk
  up support and smooth the baseline.
- **Percentiles computed in JS.** SQLite has no `PERCENTILE_CONT`, and one query
  per cell would be a flood of round-trips, so the cron pulls each garage's rows
  once and buckets and summarizes them in the Worker.
- **Resolution only at the scarce end.** `p01` marks event-level packing, up
  through `p75`. Above that a garage is comfortably open and no finer gradation
  is stored: someone checking parking cares whether it's *full*, not how empty an
  empty ramp is. There is no capacity figure anywhere, so p75 is the relative
  stand-in for "plenty of room."
- **Keyed on `(day_of_week, hour)`.** Richer cycles (month, season) were
  considered but not adopted: every added dimension multiplies the cells and
  divides the per-cell support, which fights the tail-stability the pooling and
  full-history choices buy. A coarse season bin is the natural next step if the
  data ever shows it's needed; adding it is a migration plus a change to the cell
  key. Until a cell has at least a few observations the client leaves the garage
  uncolored rather than guessing.

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

1. Create a Cloudflare API token with the **Edit Cloudflare Workers** template:
   Cloudflare dashboard → **My Profile → API Tokens → Create Token → Edit
   Cloudflare Workers**.
2. Add it to the repo: **Settings → Secrets and variables → Actions → New
   repository secret**, named `CLOUDFLARE_API_TOKEN`.

Push to `main` and the `deploy-worker` job runs `wrangler deploy`. Its log prints
the deployed `*.workers.dev` URL (see below).

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

Edit `site/app.js` and replace the `API_URL` constant at the top with the URL
wrangler printed:

```js
const API_URL = "https://madison-parking.josh-karpel.workers.dev";
```

Commit and push; GitHub Actions redeploys the site.

## Test it

```sh
curl -i https://madison-parking.josh-karpel.workers.dev
```

You should see `access-control-allow-origin: *`, `cache-control: public, max-age=30`,
and a JSON body with `modified` and `vacancies`.
