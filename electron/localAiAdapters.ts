/**
 * Production adapters for the local AI lifecycle manager - VYRON_CODE_ONE_CLICK_LOCAL_AI_STARTUP_AND_UX_DELIVERY.
 *
 * This is the only file that starts, stops or probes the two local services, reads the API key
 * file, and writes the diagnostics clipboard. Everything here is a FIXED operation:
 * - endpoints are the two hard-coded loopback origins below; no host, port, URL or path ever comes
 *   from the renderer, or from any parameter of the manager;
 * - the gateway command is the fixed official launcher with the fixed arguments `gateway run`;
 * - the proxy is the fixed checked-in script, run with a fixed, minimal environment;
 * - children are spawned directly (shell disabled), never through a shell or string command line;
 * - the API key is read here, in the main process, from the fixed local Hermes file; it goes only
 *   into the proxy child's environment, into one Authorization header on the gateway toolset check,
 *   and into the in-memory authorization module - never into a log, diagnostic, IPC reply or file;
 * - child stdout/stderr are drained into a small bounded in-memory buffer that nothing reads or
 *   exposes, so a chatty child can never block on a full pipe.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { clipboard } from "electron";
import { beginAuthorization, clearAuthorization as clearHermesAuthorization } from "./hermesAuthorization";
import { configureEndpoint, clearEndpointConfiguration } from "./hermesEndpointSetup";
import { verifyApiServerConnection, clearApiServerVerification } from "./hermesApiServer";
import { clearTaskSubmission } from "./hermesTaskSubmission";
import { createLocalAiManager, type ChildHandle, type LocalAiDeps, type LocalAiManager, type ProbeKind, type ProbeResult } from "./localAiLifecycle";

export const GATEWAY_ORIGIN = "http://127.0.0.1:8642";
export const PROXY_ORIGIN = "http://127.0.0.1:8643";
export const GATEWAY_COMMAND_ARGS: readonly string[] = ["gateway", "run"];
export const PROXY_UPSTREAM_PORT = "8642";
export const PROXY_LISTEN_PORT = "8643";

const HEALTH_TIMEOUT_MS = 5_000;
const TOOLSETS_TIMEOUT_MS = 45_000;
const MAX_RESPONSE_CHARS = 200_000;
const MAX_CAPTURED_CHARS = 4_096;
const GRACEFUL_STOP_WAIT_MS = 4_000;
const FORCE_STOP_WAIT_MS = 4_000;
/** A fixed, obviously invalid bearer value used only to prove the proxy rejects a wrong key. */
const WRONG_KEY_SENTINEL = "0".repeat(64);

/** Environment variables the gateway child may inherit; everything else is dropped. */
const GATEWAY_ENV_ALLOWLIST: readonly string[] = [
  "SystemRoot", "windir", "ComSpec", "PATH", "PATHEXT", "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH",
  "LOCALAPPDATA", "APPDATA", "PROGRAMDATA", "ProgramFiles", "ProgramFiles(x86)", "TEMP", "TMP",
  "USERNAME", "USERDOMAIN", "COMPUTERNAME", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "LANG",
];

export function buildGatewayEnvironment(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { PYTHONUTF8: "1" };
  for (const name of GATEWAY_ENV_ALLOWLIST) {
    const value = source[name];
    if (typeof value === "string") env[name] = value;
  }
  return env;
}

/** The proxy child's entire environment - the three values it needs, plus what running as Node needs. */
export function buildProxyEnvironment(apiKey: string, systemRoot: string | undefined): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ELECTRON_RUN_AS_NODE: "1",
    HERMES_API_SERVER_KEY: apiKey,
    HERMES_UPSTREAM_PORT: PROXY_UPSTREAM_PORT,
    HERMES_PROXY_PORT: PROXY_LISTEN_PORT,
  };
  if (typeof systemRoot === "string") env.SystemRoot = systemRoot;
  return env;
}

/** Extracts a usable API_SERVER_KEY from the text of the fixed Hermes .env file; null when absent or unusable. */
export function parseApiKey(text: string): string | null {
  let found: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*API_SERVER_KEY\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[1] ?? "";
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    found = value;
  }
  if (found === null) return null;
  if (found.length < 16 || found.length > 512) return null;
  if (!/^[A-Za-z0-9._~+\-/=]+$/.test(found)) return null;
  return found;
}

function hermesHome(): string | null {
  const local = process.env.LOCALAPPDATA;
  return typeof local === "string" && local.length > 0 ? path.join(local, "hermes") : null;
}

interface HttpOutcome {
  readonly status: number;
  readonly body: unknown;
}

async function httpRequest(
  url: string,
  init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<HttpOutcome | "timeout" | "failed"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: controller.signal });
    let body: unknown = null;
    try {
      body = JSON.parse((await response.text()).slice(0, MAX_RESPONSE_CHARS));
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch {
    return controller.signal.aborted ? "timeout" : "failed";
  } finally {
    clearTimeout(timer);
  }
}

function healthOk(outcome: HttpOutcome | "timeout" | "failed"): ProbeResult {
  if (outcome === "timeout") return { ok: false, timedOut: true };
  if (outcome === "failed") return { ok: false };
  const status = (outcome.body as { status?: unknown } | null)?.status;
  return { ok: outcome.status === 200 && status === "ok" };
}

function rejectedWith401(outcome: HttpOutcome | "timeout" | "failed"): ProbeResult {
  if (outcome === "timeout") return { ok: false, timedOut: true };
  if (outcome === "failed") return { ok: false };
  return outcome.status === 401 ? { ok: true } : { ok: false, definitive: true };
}

export async function probe(kind: ProbeKind, apiKey?: string): Promise<ProbeResult> {
  switch (kind) {
    case "gatewayHealth":
      return healthOk(await httpRequest(`${GATEWAY_ORIGIN}/health`, { method: "GET" }, HEALTH_TIMEOUT_MS));
    case "proxyHealth":
      return healthOk(await httpRequest(`${PROXY_ORIGIN}/health`, { method: "GET" }, HEALTH_TIMEOUT_MS));
    case "proxyRejectsMissingKey":
      return rejectedWith401(
        await httpRequest(
          `${PROXY_ORIGIN}/v1/chat/completions`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [], stream: false }) },
          HEALTH_TIMEOUT_MS,
        ),
      );
    case "proxyRejectsWrongKey":
      return rejectedWith401(
        await httpRequest(
          `${PROXY_ORIGIN}/v1/chat/completions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${WRONG_KEY_SENTINEL}` },
            body: JSON.stringify({ messages: [], stream: false }),
          },
          HEALTH_TIMEOUT_MS,
        ),
      );
    case "gatewayToolsets": {
      if (!apiKey) return { ok: false, definitive: true };
      const outcome = await httpRequest(
        `${GATEWAY_ORIGIN}/v1/toolsets?platform=api_server`,
        { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
        TOOLSETS_TIMEOUT_MS,
      );
      if (outcome === "timeout") return { ok: false, timedOut: true };
      if (outcome === "failed") return { ok: false };
      if (outcome.status === 401 || outcome.status === 403) return { ok: false, definitive: true };
      const data = (outcome.body as { data?: unknown } | null)?.data;
      if (outcome.status !== 200 || !Array.isArray(data) || data.length === 0) return { ok: false };
      const anyEnabled = data.some((entry) => (entry as { enabled?: unknown } | null)?.enabled === true);
      return anyEnabled ? { ok: false, definitive: true } : { ok: true };
    }
  }
}

const children = new WeakMap<ChildHandle, ChildProcess>();
const capturedOutput = new WeakMap<ChildHandle, { stdout: string; stderr: string }>();

function wrapChild(kind: "gateway" | "proxy", child: ChildProcess): ChildHandle | null {
  let exited = false;
  const listeners: Array<() => void> = [];
  const markExit = (): void => {
    if (exited) return;
    exited = true;
    for (const listener of listeners) listener();
  };
  // The error listener is attached before anything else can fail: a spawn error is emitted
  // asynchronously, and an unhandled 'error' event would otherwise crash the main process.
  child.once("error", markExit);
  child.once("exit", markExit);
  if (!Number.isInteger(child.pid) || (child.pid ?? 0) <= 0) return null;
  const handle: ChildHandle = {
    kind,
    hasExited: () => exited,
    onExit: (listener) => {
      listeners.push(listener);
    },
  };
  const captured = { stdout: "", stderr: "" };
  capturedOutput.set(handle, captured);
  child.stdout?.on("data", (chunk: Buffer) => {
    captured.stdout = (captured.stdout + chunk.toString("utf8")).slice(-MAX_CAPTURED_CHARS);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    captured.stderr = (captured.stderr + chunk.toString("utf8")).slice(-MAX_CAPTURED_CHARS);
  });
  children.set(handle, child);
  return handle;
}

function resolveGatewayExecutable(): string | null {
  const home = hermesHome();
  if (!home) return null;
  const candidates = [path.join(home, "bin", "hermes.exe"), path.join(home, "hermes-agent", "venv", "Scripts", "hermes.exe")];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function startGateway(): ChildHandle | null {
  try {
    const executable = resolveGatewayExecutable();
    const home = hermesHome();
    if (!executable || !home) return null;
    const child = spawn(executable, [...GATEWAY_COMMAND_ARGS], {
      cwd: home,
      env: buildGatewayEnvironment(process.env) as NodeJS.ProcessEnv,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return wrapChild("gateway", child);
  } catch {
    return null;
  }
}

/**
 * In a packaged app the electron code lives inside `app.asar`, but the auth proxy script is run by a
 * separate Node process (Electron as Node), so it is shipped unpacked next to the archive
 * (`app.asar.unpacked`, see electron-builder.yml `asarUnpack`). Outside a package the path is unchanged.
 * Pure string mapping of a fixed, main-process-computed path; nothing here is renderer-controlled.
 */
export function toAsarUnpackedPath(filePath: string): string {
  const marker = "app.asar" + path.sep;
  const index = filePath.indexOf(marker);
  if (index < 0) return filePath;
  return filePath.slice(0, index) + "app.asar.unpacked" + path.sep + filePath.slice(index + marker.length);
}

function startProxy(apiKey: string): ChildHandle | null {
  try {
    const script = toAsarUnpackedPath(path.resolve(__dirname, "..", "..", "scripts", "hermes-auth-proxy.mjs"));
    if (!existsSync(script)) return null;
    const child = spawn(process.execPath, [script], {
      env: buildProxyEnvironment(apiKey, process.env.SystemRoot) as NodeJS.ProcessEnv,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return wrapChild("proxy", child);
  } catch {
    return null;
  }
}

async function waitForExit(handle: ChildHandle, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (handle.hasExited()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return handle.hasExited();
}

export function runTaskkill(args: string[]): Promise<void> {
  const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
  return new Promise((resolve) => {
    execFile(executable, args, { windowsHide: true, timeout: 5_000 }, () => resolve());
  });
}

async function stopChild(handle: ChildHandle): Promise<void> {
  const child = children.get(handle);
  if (!child || handle.hasExited()) return;
  const pid = child.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    await runTaskkill(["/PID", String(pid), "/T"]);
    if (await waitForExit(handle, GRACEFUL_STOP_WAIT_MS)) return;
    await runTaskkill(["/PID", String(pid), "/T", "/F"]);
    await waitForExit(handle, FORCE_STOP_WAIT_MS);
    return;
  }
  child.kill("SIGTERM");
  if (await waitForExit(handle, GRACEFUL_STOP_WAIT_MS)) return;
  child.kill("SIGKILL");
  await waitForExit(handle, FORCE_STOP_WAIT_MS);
}

export async function readApiKey(): Promise<string | null> {
  const home = hermesHome();
  if (!home) return null;
  try {
    return parseApiKey(await readFile(path.join(home, ".env"), "utf8"));
  } catch {
    return null;
  }
}

async function applyAuthorization(apiKey: string): Promise<boolean> {
  const authorization = await beginAuthorization({ credential: apiKey });
  if (authorization.state !== "authorized_memory_only") return false;
  const endpoint = await configureEndpoint({ endpoint: PROXY_ORIGIN });
  return endpoint.state === "configured_memory_only";
}

function clearAuthorization(): void {
  clearHermesAuthorization();
  clearEndpointConfiguration();
  clearApiServerVerification();
  clearTaskSubmission();
}

async function verifyConnection(): Promise<boolean> {
  return (await verifyApiServerConnection()).state === "reachable";
}

export function createProductionLocalAiManager(): LocalAiManager {
  const deps: LocalAiDeps = {
    probe,
    startGateway,
    startProxy,
    stopChild,
    readApiKey,
    applyAuthorization,
    clearAuthorization,
    verifyConnection,
    writeClipboard: (text) => clipboard.writeText(text),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  return createLocalAiManager(deps);
}
