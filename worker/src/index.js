const UPSTREAM = "https://www.cityofmadison.com/parking/data/ramp-availability.json";

// Cache the upstream response this long inside the Worker/edge, so we don't
// hammer the city. They update every couple of minutes.
const UPSTREAM_CACHE_TTL = 60;

// How long the browser may reuse our response.
const CLIENT_MAX_AGE = 30;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, 405);
    }

    try {
      const upstream = await fetch(UPSTREAM, {
        cf: { cacheTtl: UPSTREAM_CACHE_TTL, cacheEverything: true },
      });

      if (!upstream.ok) {
        return json(
          { error: "upstream returned an error", status: upstream.status },
          502
        );
      }

      const data = await upstream.json();
      return json(data, 200, {
        "Cache-Control": `public, max-age=${CLIENT_MAX_AGE}`,
      });
    } catch (err) {
      return json({ error: "failed to reach upstream" }, 502);
    }
  },
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS,
      ...extraHeaders,
    },
  });
}
