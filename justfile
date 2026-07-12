#!/usr/bin/env just --justfile

set dotenv-load
set ignore-comments

[default]
[doc("List available recipes")]
list:
    @just --list

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
