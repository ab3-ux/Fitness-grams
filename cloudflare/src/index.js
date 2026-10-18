function allowedOrigins(env) {
  return new Set(
    (env.ALLOWED_ORIGINS || "")
      .split(",")
      .map(origin => origin.trim())
      .filter(Boolean)
  );
}

function corsHeaders(request, env) {
  const headers = new Headers({ Vary: "Origin" });
  const origin = request.headers.get("Origin");

  if (origin && allowedOrigins(env).has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }

  return headers;
}

function jsonResponse(body, status, headers) {
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = corsHeaders(request, env);
    const origin = request.headers.get("Origin");
    const originIsAllowed = !origin || allowedOrigins(env).has(origin);

    if (request.method === "OPTIONS") {
      if (!originIsAllowed) {
        return new Response(null, { status: 403, headers });
      }

      headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type");
      headers.set("Access-Control-Max-Age", "86400");
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== "GET" || url.pathname !== "/health") {
      return jsonResponse({ error: "Not found" }, 404, headers);
    }

    try {
      await env.DB.prepare("SELECT 1").first();
    } catch (error) {
      console.error("D1 health check failed", error);
      return jsonResponse(
        { status: "unavailable", database: "unavailable" },
        503,
        headers
      );
    }

    return jsonResponse({ status: "ok", database: "ready" }, 200, headers);
  }
};
