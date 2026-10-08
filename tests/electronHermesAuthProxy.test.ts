import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";

/**
 * The real proxy script, run as a child process in front of a fake Hermes. What is checked is behaviour: Ruflo's own requests
 * (X-Title: Ruflo) get their headers at once and a keep-alive blank until the reply is ready (Ruflo's fetch gives up after
 * 300 s without headers); every other request passes through unchanged; auth is still enforced.
 */
const KEY = "test-key-0123456789abcdef";
const SCRIPT = path.join(__dirname, "..", "scripts", "hermes-auth-proxy.mjs");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

let upstream: http.Server;
let upstreamPort = 0;
let proxy: ChildProcess;
let proxyPort = 0;
const upstreamState = { delayMs: 0, status: 200, body: '{"choices":[{"message":{"content":"tamam"}}]}', closedEarly: 0 };

beforeAll(async () => {
  upstreamPort = await freePort();
  proxyPort = await freePort();
  upstream = http.createServer((req, res) => {
    req.on("close", () => {
      if (!res.writableEnded) upstreamState.closedEarly += 1;
    });
    req.resume();
    req.on("end", () => {
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(upstreamState.status, { "Content-Type": "application/json" });
        res.end(upstreamState.body);
      }, upstreamState.delayMs);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));
  proxy = spawn(process.execPath, [SCRIPT], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HERMES_API_SERVER_KEY: KEY, HERMES_UPSTREAM_PORT: String(upstreamPort), HERMES_PROXY_PORT: String(proxyPort), HERMES_PROXY_KEEPALIVE_MS: "150" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("proxy did not start")), 10_000);
    proxy.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    proxy.on("exit", () => reject(new Error("proxy exited")));
  });
});

afterAll(async () => {
  proxy.kill();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

interface Seen {
  status: number;
  headersAtMs: number;
  totalMs: number;
  raw: string;
  aborted: boolean;
}

function call(headers: Record<string, string>, options: { abortAfterMs?: number } = {}): Promise<Seen> {
  return new Promise((resolve) => {
    const started = Date.now();
    let headersAtMs = -1;
    let raw = "";
    let status = 0;
    const req = http.request(
      { host: "127.0.0.1", port: proxyPort, path: "/v1/chat/completions", method: "POST", headers: { "Content-Type": "application/json", ...headers } },
      (res) => {
        headersAtMs = Date.now() - started;
        status = res.statusCode ?? 0;
        res.on("data", (chunk: Buffer) => {
          raw += chunk.toString("utf8");
        });
        res.on("end", () => resolve({ status, headersAtMs, totalMs: Date.now() - started, raw, aborted: false }));
        res.on("aborted", () => resolve({ status, headersAtMs, totalMs: Date.now() - started, raw, aborted: true }));
        res.on("error", () => resolve({ status, headersAtMs, totalMs: Date.now() - started, raw, aborted: true }));
      },
    );
    req.on("error", () => resolve({ status, headersAtMs, totalMs: Date.now() - started, raw, aborted: true }));
    req.end(JSON.stringify({ model: "vyron-code", messages: [{ role: "user", content: "x" }] }));
    if (options.abortAfterMs !== undefined) setTimeout(() => req.destroy(), options.abortAfterMs);
  });
}

const RUFLO = { Authorization: "Bearer " + KEY, "X-Title": "Ruflo" };
const PLAIN = { Authorization: "Bearer " + KEY };

describe("hermes-auth-proxy keep-alive for Ruflo's long model turns", () => {
  it("sends the headers at once and blank keep-alive bytes while the model works, then the exact reply", async () => {
    Object.assign(upstreamState, { delayMs: 1200, status: 200, body: '{"choices":[{"message":{"content":"uzun cevap"}}]}' });
    const seen = await call(RUFLO);
    expect(seen.aborted).toBe(false);
    expect(seen.status).toBe(200);
    expect(seen.headersAtMs).toBeLessThan(600);
    expect(seen.totalMs).toBeGreaterThanOrEqual(1100);
    // Leading blanks (several keep-alive ticks) and then the upstream body, byte for byte.
    expect(seen.raw.length - seen.raw.trimStart().length).toBeGreaterThanOrEqual(3);
    expect(JSON.parse(seen.raw)).toEqual({ choices: [{ message: { content: "uzun cevap" } }] });
  });

  it("drops the connection instead of faking a 200 when the upstream fails", async () => {
    Object.assign(upstreamState, { delayMs: 200, status: 500, body: '{"error":"hata"}' });
    const seen = await call(RUFLO);
    expect(seen.aborted).toBe(true);
    expect(seen.raw.trim()).toBe("");
  });

  it("stops waiting for the model when the client gives up", async () => {
    Object.assign(upstreamState, { delayMs: 2500, status: 200, body: "{}", closedEarly: 0 });
    await call(RUFLO, { abortAfterMs: 300 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(upstreamState.closedEarly).toBe(1);
  });

  it("leaves every other request exactly as it was: upstream status and body pass through", async () => {
    Object.assign(upstreamState, { delayMs: 100, status: 500, body: '{"error":"hata"}' });
    const failed = await call(PLAIN);
    expect(failed.status).toBe(500);
    expect(failed.raw).toBe('{"error":"hata"}');
    Object.assign(upstreamState, { delayMs: 100, status: 200, body: '{"ok":true}' });
    const ok = await call(PLAIN);
    expect(ok.status).toBe(200);
    expect(ok.raw).toBe('{"ok":true}');
  });

  it("still enforces the key: X-Title alone opens nothing", async () => {
    const denied = await call({ "X-Title": "Ruflo" });
    expect(denied.status).toBe(401);
    const wrong = await call({ Authorization: "Bearer yanlis-anahtar-yanlis", "X-Title": "Ruflo" });
    expect(wrong.status).toBe(401);
  });
});
