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
