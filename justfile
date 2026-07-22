#!/usr/bin/env just --justfile

set dotenv-load
set ignore-comments

# Base URL for admin/curl recipes; override to hit a local worker-dev instance,
# e.g. `just worker-url=http://localhost:8787 worker-rebuild-stats`.
worker-url := "https://madison-parking.josh-karpel.workers.dev"

# Port for the local static-site server (serve/shot/dump). Override to run a
# second instance without colliding with one already bound, e.g.
# `just serve-port=8138 serve`.
serve-port := "8137"

[default]
[doc("List available recipes")]
list:
    @just --list

[doc("Run the test suite (no framework, plain node)")]
test:
    @node test/run.mjs

alias t := test

# One-time: install Playwright + its headless Chromium for browser-driven checks
# (the system google-chrome isn't reliably on PATH). Dev-only and git-ignored, so
# the committed tree stays free of npm deps; this recipe is the record. Not part
# of `just test`, which stays plain node for CI. See the Testing notes in CLAUDE.md.
[doc("Install Playwright + headless Chromium for browser-driven tests (one-time)")]
setup:
    npm install playwright
    npx playwright install chromium

[group('worker')]
[doc("Authenticate wrangler with Cloudflare (first time only)")]
worker-login:
    cd worker && exec npx wrangler login

[group('worker')]
[doc("Deploy the Worker to Cloudflare, printing the *.workers.dev URL")]
worker-deploy:
    cd worker && exec npx wrangler deploy

alias d := worker-deploy

[group('worker')]
[doc("Create the D1 history database (one time; paste the id into wrangler.toml)")]
worker-db-create:
    cd worker && exec npx wrangler d1 create madison-parking

[group('worker')]
[doc("Apply D1 migrations to the remote (production) database")]
worker-migrate:
    cd worker && exec npx wrangler d1 migrations apply madison-parking --remote

[group('worker')]
[doc("Apply D1 migrations to the local dev database")]
worker-migrate-local:
    cd worker && exec npx wrangler d1 migrations apply madison-parking --local

[group('worker')]
[doc("Run the Worker locally at http://localhost:8787")]
worker-dev:
    cd worker && exec npx wrangler dev

[group('worker')]
[doc("Stream live logs from the deployed Worker")]
worker-tail:
    cd worker && exec npx wrangler tail

# The token is read from .env via an inline $(awk ...): just echoes the recipe
# text verbatim before the shell expands it, so the echoed command shows the
# subcommand, not the secret. `sub` strips only the key prefix, so a value
# containing '=' survives intact.
[group('worker')]
[doc("Trigger the on-demand stats rebuild (POST /admin/rebuild-stats; ADMIN_TOKEN from .env)")]
worker-rebuild-stats:
    curl -sS -X POST -H "Authorization: Bearer $(awk '/^ADMIN_TOKEN=/{sub(/^ADMIN_TOKEN=/, ""); print; exit}' .env)" {{ worker-url }}/admin/rebuild-stats

[group('worker')]
[doc("Rotate ADMIN_TOKEN: push a fresh token to the Worker secret, then persist to .env only on success")]
worker-rotate-token:
    #!/usr/bin/env bash
    set -euo pipefail
    token="$(openssl rand -hex 32)"
    # Set the Worker's secret first. If this fails (auth, network), set -e aborts
    # before .env is touched, so .env never gets ahead of the deployed secret.
    printf '%s' "$token" | (cd worker && npx wrangler secret put ADMIN_TOKEN)
    # Succeeded: replace any existing ADMIN_TOKEN line in .env (preserving the
    # rest) and write atomically via a temp file.
    { grep -v '^ADMIN_TOKEN=' .env 2>/dev/null || true; echo "ADMIN_TOKEN=$token"; } > .env.tmp
    mv .env.tmp .env
    echo "ADMIN_TOKEN rotated: Worker secret updated and .env synced."

[group('worker')]
[doc("Push the Ticketmaster Discovery API key (from .env) to the Worker secret")]
worker-set-ticketmaster-key:
    #!/usr/bin/env bash
    set -euo pipefail
    key="$(awk '/^TICKETMASTER_API_KEY=/{sub(/^TICKETMASTER_API_KEY=/,"");print;exit}' .env)"
    [[ -n "$key" ]] || { echo "TICKETMASTER_API_KEY not set in .env"; exit 1; }
    printf '%s' "$key" | (cd worker && npx wrangler secret put TICKETMASTER_API_KEY)

[group('site')]
[doc("Serve the static site locally at http://localhost:8137")]
serve:
    cd site && exec python3 -m http.server {{ serve-port }} --bind 127.0.0.1

alias s := serve

# Headless Chrome flags: --password-store=basic --use-mock-keychain avoid the
# GNOME keyring unlock popup; --no-sandbox is needed under WSL.
chrome-flags := "--headless --disable-gpu --no-sandbox --password-store=basic --use-mock-keychain --virtual-time-budget=4000"

[group('site')]
[doc("Screenshot the local site headless to the given file (boots a temp server)")]
shot file="shot.png":
    #!/usr/bin/env bash
    set -euo pipefail
    python3 -m http.server {{ serve-port }} --bind 127.0.0.1 --directory site >/dev/null 2>&1 &
    trap 'kill $!' EXIT
    sleep 1
    google-chrome {{ chrome-flags }} --hide-scrollbars \
      --force-device-scale-factor=2 --window-size=390,844 \
      --screenshot="{{ justfile_directory() }}/{{ file }}" http://localhost:{{ serve-port }}/
    echo "wrote {{ file }}"

[group('site')]
[doc("Dump the local site's rendered DOM headless (after JS runs)")]
dump:
    #!/usr/bin/env bash
    set -euo pipefail
    python3 -m http.server {{ serve-port }} --bind 127.0.0.1 --directory site >/dev/null 2>&1 &
    trap 'kill $!' EXIT
    sleep 1
    google-chrome {{ chrome-flags }} --dump-dom http://localhost:{{ serve-port }}/

[group('site')]
[doc("Rasterize the PWA icons from site/icons/icon.svg (the single source)")]
icons:
    magick -background none site/icons/icon.svg -resize 512x512 site/icons/icon-512.png
    magick -background none site/icons/icon.svg -resize 192x192 site/icons/icon-192.png
    @echo "regenerated icon-192.png and icon-512.png from icon.svg"
