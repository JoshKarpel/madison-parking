import { test, eq, ok } from "./harness.mjs";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// Load the real service worker into a sandbox with mocked globals, capturing
// the event listeners it registers so we can drive its fetch handler directly.
// This exercises the actual sw.js — no copy of the logic to drift out of sync.
function loadServiceWorker({ fetchImpl, cached }) {
  const listeners = {};
  const cacheStore = new Map();
  if (cached) cacheStore.set(cached.url, cached.response);

  class MockResponse {
    constructor(body, init = {}) {
      this.body = body;
      this.ok = init.ok ?? true;
      this.isError = init.isError ?? false;
      this.status = init.status ?? 200;
    }
    clone() {
      return new MockResponse(this.body, this);
    }
    static error() {
      return new MockResponse(null, { ok: false, isError: true, status: 0 });
    }
  }

  const caches = {
    async match(request) {
      return cacheStore.get(request.url);
    },
    async open() {
      return { put: (request, response) => cacheStore.set(request.url, response) };
    },
    async keys() {
      return [];
    },
    async delete() {
      return true;
    },
  };

  const self = {
    addEventListener: (type, handler) => (listeners[type] = handler),
    location: { origin: "http://localhost:8137" },
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };

  const context = { self, caches, fetch: fetchImpl, Response: MockResponse, URL, console };
  const path = fileURLToPath(new URL("../site/sw.js", import.meta.url));
  vm.runInNewContext(readFileSync(path, "utf8"), context);

  return { listeners, cacheStore, MockResponse };
}

function dispatchFetch(listeners, request) {
  let responded;
  listeners.fetch({ request, respondWith: (p) => (responded = p) });
  return responded;
}

const apiRequest = { url: "http://localhost:8798/stats?garage=7", method: "GET" };

test("SW returns a Response (not undefined) when the API is offline and nothing is cached", async () => {
  const { listeners } = loadServiceWorker({
    fetchImpl: () => Promise.reject(new Error("offline")),
    cached: null,
  });
  const res = await dispatchFetch(listeners, apiRequest);
  // The bug this guards: respondWith(undefined) throws "Failed to convert value
  // to 'Response'". The fallback must resolve to a real (error) Response.
  ok(res, "expected a Response, got a falsy value");
  eq(res.isError, true);
});

test("SW serves the cached copy when the API is offline but a cache entry exists", async () => {
  const cachedResponse = { body: "cached-stats", ok: true };
  const { listeners } = loadServiceWorker({
    fetchImpl: () => Promise.reject(new Error("offline")),
    cached: { url: apiRequest.url, response: cachedResponse },
  });
  const res = await dispatchFetch(listeners, apiRequest);
  eq(res.body, "cached-stats");
});

test("SW passes through and caches a successful API response", async () => {
  const { MockResponse } = loadServiceWorker({ fetchImpl: null, cached: null });
  const live = new MockResponse("fresh-stats", { ok: true });
  const { listeners, cacheStore } = loadServiceWorker({
    fetchImpl: () => Promise.resolve(live),
    cached: null,
  });
  const res = await dispatchFetch(listeners, apiRequest);
  eq(res.body, "fresh-stats");
  await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget cache.put flush
  ok(cacheStore.has(apiRequest.url), "expected the ok response to be cached");
});

test("SW does not cache an error API response", async () => {
  const { MockResponse } = loadServiceWorker({ fetchImpl: null, cached: null });
  const bad = new MockResponse("upstream-error", { ok: false, status: 502 });
  const { listeners, cacheStore } = loadServiceWorker({
    fetchImpl: () => Promise.resolve(bad),
    cached: null,
  });
  await dispatchFetch(listeners, apiRequest);
  await new Promise((r) => setTimeout(r, 0));
  ok(!cacheStore.has(apiRequest.url), "a non-ok response must not be cached");
});
