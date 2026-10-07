/**
 * Production adapter for the Gemini deep-research driver - VYRON_CODE_APPROVED_TOOLS (deep_research). Main process only.
 *
 * The two real-world pieces the pure driver (electron/deepResearch.ts) is given:
 *  - the key: read, on every run, from the same fixed Hermes `.env` file (LOCALAPPDATA\hermes\.env) the app already reads its
 *    Hermes key from, line `VYRON_GEMINI_API_KEY=...`. The user puts it there; Vyron stores nothing of its own, and the key
 *    stays in this module's call stack: it is sent only as the `x-goog-api-key` header, never logged, returned or exposed.
 *  - the call: a bare global fetch to ONE fixed origin (generativelanguage.googleapis.com) on two fixed path shapes, with no
 *    redirects followed and a per-request timeout.
 */
import fs from "node:fs";
import path from "node:path";
import { createDeepResearch, type DeepResearch, type DeepResearchDeps, type HttpReply } from "./deepResearch";

const ORIGIN = "https://generativelanguage.googleapis.com";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_CHARS = 2_000_000;
const KEY_LINE = /^\s*VYRON_GEMINI_API_KEY\s*=\s*(.*?)\s*$/;

/** Extracts the Gemini key from the text of the Hermes .env file; null when absent or unusable. */
export function parseGeminiKey(text: string): string | null {
  let found: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(KEY_LINE);
    if (!match) continue;
    let value = match[1] ?? "";
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    found = value;
  }
  if (found === null) return null;
  if (found.length < 16 || found.length > 512) return null;
  if (!/^[A-Za-z0-9._~+\-/=]+$/.test(found)) return null;
  return found;
}

/** Only the two fixed path shapes the driver uses are ever requested. */
export function isAllowedPath(requestPath: string): boolean {
  return requestPath === "/v1beta/interactions" || /^\/v1beta\/interactions\/[A-Za-z0-9_-]{1,200}$/.test(requestPath);
}

function readKey(): string | null {
  const local = process.env.LOCALAPPDATA;
  if (typeof local !== "string" || local.length === 0) return null;
  try {
    return parseGeminiKey(fs.readFileSync(path.join(local, "hermes", ".env"), "utf8"));
  } catch {
    return null;
  }
}

async function request(method: "GET" | "POST", requestPath: string, body: unknown, apiKey: string): Promise<HttpReply> {
  if (!isAllowedPath(requestPath)) return "failed";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { "x-goog-api-key": apiKey };
    if (method === "POST") headers["Content-Type"] = "application/json";
    const response = await fetch(ORIGIN + requestPath, { method, headers, body: method === "POST" ? JSON.stringify(body) : undefined, redirect: "error", signal: controller.signal });
    let parsed: unknown = null;
    try {
      parsed = JSON.parse((await response.text()).slice(0, MAX_RESPONSE_CHARS));
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  } catch {
    return controller.signal.aborted ? "timeout" : "failed";
  } finally {
    clearTimeout(timer);
  }
}

export function createProductionDeepResearch(): DeepResearch {
  const deps: DeepResearchDeps = {
    key: readKey,
    request,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
  return createDeepResearch(deps);
}
