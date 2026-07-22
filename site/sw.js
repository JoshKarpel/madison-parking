// __BUILD_ID__ is replaced with the git commit SHA at deploy time (see
// .github/workflows/deploy.yml) so every deploy installs a fresh worker and a
// fresh cache. Locally it stays this literal, which is fine for dev.
const CACHE_VERSION = "__BUILD_ID__";
const CACHE_NAME = `madison-parking-${CACHE_VERSION}`;

const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./version.js",
  "./garages.js",
  "./history.js",
  "./coloring.js",
  "./chart.js",
  "./graph.js",
  "./events.js",
  "./theme.js",
  "./sky.js",
  "./style.css",
  "./fonts/JetBrainsMono.woff2",
  "./fonts/ComicNeue-Regular.woff2",
  "./fonts/ComicNeue-Bold.woff2",
  "./fonts/RedHatDisplay.woff2",
  "./fonts/RedHatText.woff2",
  "./manifest.webmanifest",
  "./icons/icon-192.png?v=__ICON_HASH__",
  "./icons/icon-512.png?v=__ICON_HASH__",
];

self.addEventListener("install", (event) => {
  // `cache: "reload"` bypasses the browser's HTTP cache so the new worker
  // always pulls the freshly-deployed shell, not a stale intermediary copy.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        SHELL.map((url) =>
          fetch(new Request(url, { cache: "reload" })).then((res) =>
            cache.put(url, res)
          )
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith("madison-parking-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // The Cache API only supports http(s). Extension-injected requests
  // (chrome-extension://, etc.) are cross-origin, so without this they'd hit the
  // API branch below and throw in cache.put; let the browser handle them.
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  // Network-first for the API (cross-origin worker). The app itself also caches
  // last-known data in localStorage; this just avoids a hard failure offline.
  const isApi = url.origin !== self.location.origin;
  if (isApi) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        // Offline: serve the last cached copy if we have one, otherwise a
        // network-error Response. Returning undefined here would make
        // respondWith throw ("Failed to convert value to 'Response'").
        .catch(async () => (await caches.match(request)) || Response.error())
    );
    return;
  }

  // Cache-first for the app shell.
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});
