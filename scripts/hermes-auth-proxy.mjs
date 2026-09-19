#!/usr/bin/env node
/**
 * Local, loopback-only authenticating reverse proxy for the Hermes Agent API Server —
 * VYRON_CODE_COMPLETE_LOCAL_HERMES_D11_DELIVERY_AUTHORIZATION.
 *
 * WHY THIS EXISTS: source inspection of the installed Hermes Agent (see
 * VYRON_CODE_V02_D11_AUTH_AND_EPHEMERAL_HISTORY_DISCOVERY_REPORT.md) established that
 * `POST /v1/chat/completions` and `POST /v1/responses` enforce no `API_SERVER_KEY`
 * authentication at all — confirmed against both the locally installed version and the
 * current official upstream source. Patching the installed Hermes Agent's own Python source
 * to add that check was attempted and was blocked by this development environment's own
 * permission system (writing to files outside the project directory). This proxy is a
 * self-contained alternative that requires touching no Hermes file: it sits in front of the
 * real Hermes API Server and enforces the missing check itself, using the SAME
 * `API_SERVER_KEY` value Hermes already uses — no new credential to manage.
 *
 * SCOPE — deliberately narrow, not a generic proxy:
 *   - Exposes only four paths: `/health`, `/v1/health` (forwarded with no auth check, matching
 *     Hermes's own documented, intentionally-public liveness routes) and
 *     `/v1/chat/completions` (forwarded ONLY with a valid `Authorization: Bearer <key>` match)
 *     plus `OPTIONS` for the same paths (CORS preflight, matched, never forwarded).
 *   - Every other path returns a fixed 404 — this proxy is not a general Hermes gateway, and
 *     never exposes `/v1/responses`, `/v1/runs`, `/v1/models`, `/api/sessions`, or anything
 *     else, regardless of what the real Hermes server itself exposes.
 *   - Binds to 127.0.0.1 only. Never 0.0.0.0, never a LAN-reachable interface.
 *   - No logging of header values, body content, or the key. Only method+path+status.
 *   - No retry, no queue, no caching, no request mutation beyond adding the one
 *     already-validated `Authorization` header when forwarding to Hermes.
 *
 * USAGE:
 *   HERMES_API_SERVER_KEY=<your real Hermes API_SERVER_KEY value> \
 *   HERMES_UPSTREAM_PORT=8642 \
 *   HERMES_PROXY_PORT=8643 \
 *   node scripts/hermes-auth-proxy.mjs
 *
 * Vyron Code Desktop's own Hermes endpoint should then be configured to
 * `http://127.0.0.1:8643` (the proxy), not `http://127.0.0.1:8642` (Hermes itself) — see
 * VYRON_CODE_D11_LOCAL_HERMES_SETUP_AND_UAT.md.
 */

import http from "node:http";

const UPSTREAM_HOST = "127.0.0.1";
const UPSTREAM_PORT = Number(process.env.HERMES_UPSTREAM_PORT || 8642);
const PROXY_PORT = Number(process.env.HERMES_PROXY_PORT || 8643);
const REQUIRED_KEY = process.env.HERMES_API_SERVER_KEY || "";

if (!REQUIRED_KEY) {
  console.error("HERMES_API_SERVER_KEY is not set. Refusing to start — an auth proxy with no key to check is pointless.");
  process.exit(1);
}

const PUBLIC_PATHS = new Set(["/health", "/v1/health"]);
const AUTHENTICATED_PATHS = new Set(["/v1/chat/completions"]);
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB — generous for one plain-text task draft, still bounded.

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function log(method, path, status) {
  console.log(`${new Date().toISOString()} ${method} ${path} -> ${status}`);
}

const server = http.createServer((req, res) => {
  const path = (req.url || "/").split("?")[0];
  const method = req.method || "GET";

  if (method === "OPTIONS" && (PUBLIC_PATHS.has(path) || AUTHENTICATED_PATHS.has(path))) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "null",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    });
    res.end();
    log(method, path, 204);
    return;
  }

  const isPublic = method === "GET" && PUBLIC_PATHS.has(path);
  const isAuthenticated = method === "POST" && AUTHENTICATED_PATHS.has(path);

  if (!isPublic && !isAuthenticated) {
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "Not found", type: "not_found" } }));
    log(method, path, 404);
    return;
  }

  if (isAuthenticated) {
    const authHeader = req.headers["authorization"] || "";
    const presented = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!presented || !timingSafeEqual(presented, REQUIRED_KEY)) {
      res
        .writeHead(401, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: { message: "Invalid or missing API key", type: "gateway_auth_error", code: "gateway_auth_failed" } }));
      log(method, path, 401);
      return;
    }
  }

  const chunks = [];
  let total = 0;
  let aborted = false;
  req.on("data", (chunk) => {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      aborted = true;
      res.writeHead(413, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "Request body too large", type: "invalid_request_error" } }));
      log(method, path, 413);
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (aborted) return;
    const body = Buffer.concat(chunks);
    const forwardHeaders = { "Content-Type": "application/json" };
    if (isAuthenticated) forwardHeaders["Authorization"] = `Bearer ${REQUIRED_KEY}`;
    const upstreamReq = http.request(
      { host: UPSTREAM_HOST, port: UPSTREAM_PORT, path, method, headers: { ...forwardHeaders, "Content-Length": body.length } },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
        log(method, path, upstreamRes.statusCode || 502);
      },
    );
    upstreamReq.on("error", () => {
      res.writeHead(502, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "Upstream Hermes API Server unreachable", type: "server_error" } }));
      log(method, path, 502);
    });
    upstreamReq.end(body);
  });
});

server.listen(PROXY_PORT, UPSTREAM_HOST, () => {
  console.log(`Hermes auth proxy listening on http://${UPSTREAM_HOST}:${PROXY_PORT} -> forwarding to http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
});
