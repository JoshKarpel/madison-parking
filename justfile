#!/usr/bin/env just --justfile

set dotenv-load
set ignore-comments

[default]
[doc("List available recipes")]
list:
    @just --list

[doc("Run the test suite (no framework, plain node)")]
test:
    @node test/run.mjs

alias t := test

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

[group('site')]
[doc("Serve the static site locally at http://localhost:8137")]
serve:
    cd site && exec python3 -m http.server 8137

alias s := serve

# Headless Chrome flags: --password-store=basic --use-mock-keychain avoid the
# GNOME keyring unlock popup; --no-sandbox is needed under WSL.
chrome-flags := "--headless --disable-gpu --no-sandbox --password-store=basic --use-mock-keychain --virtual-time-budget=4000"

[group('site')]
[doc("Screenshot the local site headless to the given file (boots a temp server)")]
shot file="shot.png":
    #!/usr/bin/env bash
    set -euo pipefail
    python3 -m http.server 8137 --directory site >/dev/null 2>&1 &
    trap 'kill $!' EXIT
    sleep 1
    google-chrome {{ chrome-flags }} --hide-scrollbars \
      --force-device-scale-factor=2 --window-size=390,844 \
      --screenshot="{{ justfile_directory() }}/{{ file }}" http://localhost:8137/
    echo "wrote {{ file }}"

[group('site')]
[doc("Dump the local site's rendered DOM headless (after JS runs)")]
dump:
    #!/usr/bin/env bash
    set -euo pipefail
    python3 -m http.server 8137 --directory site >/dev/null 2>&1 &
    trap 'kill $!' EXIT
    sleep 1
    google-chrome {{ chrome-flags }} --dump-dom http://localhost:8137/
