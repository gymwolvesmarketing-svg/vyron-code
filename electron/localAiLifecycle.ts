/**
 * Main-process local AI lifecycle manager - VYRON_CODE_ONE_CLICK_LOCAL_AI_STARTUP_AND_UX_DELIVERY.
 *
 * Decides, verifies and tracks the two local services the reviewed-task flow depends on: the
 * Hermes gateway (fixed loopback port 8642) and the authenticated local proxy (fixed loopback
 * port 8643). It contains no I/O of its own: every side effect (health probes, spawning, stopping,
 * reading the API key, applying the in-memory authorization, the clipboard, the clock) is an
 * injected dependency, supplied for production by electron/localAiAdapters.ts and by fakes in the
 * tests. This module imports nothing from Electron or Node, and never sees a command, path,
 * environment variable, URL, host or port: the dependency interface below only offers fixed,
 * named operations.
 *
 * Rules enforced here:
 * - A healthy gateway/proxy is reused, never duplicated. A service this process started is
 *   "app-owned"; a service that was already healthy is "pre-existing" and is never stopped.
 * - The API key exists only as a local variable inside one startup run, handed to the injected
 *   spawn/probe/authorize operations. It is never stored in manager state, the diagnostic
 *   timeline, or any value returned to the renderer.
 * - Every wait is bounded. There is no automatic restart loop; only an explicit retry() starts
 *   another attempt, and only from the unavailable state.
 * - A monotonically increasing generation guards every await, so a stale startup can never
 *   overwrite the current state (including after retry() or shutdown()).
 * - Readiness performs only fixed, non-task checks: it never sends a task.
 */
import type { LocalAiState, LocalAiStage, SafeCopyResult, SafeLocalAiFailureCategory } from "./shared-ipc-contract";

export type ProbeKind = "gatewayHealth" | "proxyHealth" | "proxyRejectsMissingKey" | "proxyRejectsWrongKey" | "gatewayToolsets";

/**
 * Result of one fixed probe. `ok` means the probe's expectation was met (healthy, or the request
 * was correctly rejected, or zero toolsets are enabled). `definitive` marks a real answer that
 * will not change by waiting (for example auth not enforced), so the caller must not keep polling.
 */
export interface ProbeResult {
  readonly ok: boolean;
  readonly timedOut?: boolean;
  readonly definitive?: boolean;
}

/** Opaque handle to a child process this app started. */
export interface ChildHandle {
  readonly kind: "gateway" | "proxy";
  hasExited(): boolean;
  onExit(listener: () => void): void;
}

export interface LocalAiDeps {
  probe(kind: ProbeKind, apiKey?: string): Promise<ProbeResult>;
  /** Starts the fixed official Hermes gateway command; null when it cannot be started. */
  startGateway(): ChildHandle | null;
  /** Starts the fixed, checked-in proxy script with a controlled environment; null on failure. */
  startProxy(apiKey: string): ChildHandle | null;
  /** Graceful stop, then a bounded force-kill of the child's whole process tree. */
  stopChild(handle: ChildHandle): Promise<void>;
  /** Reads the API key from the fixed local Hermes file; null when missing or unusable. */
  readApiKey(): Promise<string | null>;
  /** Places the credential and the fixed proxy endpoint into main-process memory; false on failure. */
  applyAuthorization(apiKey: string): Promise<boolean>;
  /** Clears the in-memory authorization, endpoint, verification and task submission state. */
  clearAuthorization(): void;
  /** Runs the existing bounded API Server health verification (no task is sent). */
  verifyConnection(): Promise<boolean>;
  writeClipboard(text: string): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface LocalAiTimings {
  readonly pollIntervalMs: number;
  readonly gatewayReadyTimeoutMs: number;
  readonly proxyReadyTimeoutMs: number;
  readonly verifyTimeoutMs: number;
}

export const DEFAULT_LOCAL_AI_TIMINGS: LocalAiTimings = {
  pollIntervalMs: 500,
  gatewayReadyTimeoutMs: 120_000,
  proxyReadyTimeoutMs: 20_000,
  verifyTimeoutMs: 60_000,
};

type DiagStage = "checking" | "gateway" | "key" | "proxy" | "auth-check" | "toolset-check" | "health-check" | "runtime";
type DiagOutcome = "reused" | "started" | "ready" | "spawn-failed" | "timeout" | "exited" | "missing" | "rejected" | "ok" | "failed";

interface DiagEvent {
  readonly offsetSeconds: number;
  readonly stage: DiagStage;
  readonly outcome: DiagOutcome;
}

const MAX_DIAG_EVENTS = 40;
const MAX_DIAG_TEXT_CHARS = 2_000;

type WaitStatus = "ok" | "timeout" | "exited" | "rejected" | "stale";

interface OwnedService {
  readonly handle: ChildHandle;
}

export interface LocalAiManager {
  start(): Promise<LocalAiState>;
  getState(): LocalAiState;
  retry(): LocalAiState;
  copyDiagnostics(): SafeCopyResult;
  shutdown(): Promise<void>;
}

export function createLocalAiManager(deps: LocalAiDeps, timings: LocalAiTimings = DEFAULT_LOCAL_AI_TIMINGS): LocalAiManager {
  let state: LocalAiState = { state: "starting", stage: "checking" };
  let generation = 0;
  let shuttingDown = false;
  let gateway: OwnedService | null = null;
  let proxy: OwnedService | null = null;
  let attemptStartedAt = deps.now();
  let timeline: DiagEvent[] = [];
  let runPromise: Promise<void> | null = null;

  function record(stage: DiagStage, outcome: DiagOutcome): void {
    if (timeline.length >= MAX_DIAG_EVENTS) return;
    timeline.push({ offsetSeconds: Math.max(0, Math.round((deps.now() - attemptStartedAt) / 1000)), stage, outcome });
  }

  function setStarting(gen: number, stage: LocalAiStage): void {
    if (gen !== generation) return;
    state = { state: "starting", stage };
  }

  function fail(gen: number, category: SafeLocalAiFailureCategory, stage: DiagStage, outcome: DiagOutcome): void {
    if (gen !== generation) return;
    record(stage, outcome);
    state = { state: "unavailable", category };
    deps.clearAuthorization();
  }

  function ownedProcessFailed(): boolean {
    return (gateway?.handle.hasExited() ?? false) || (proxy?.handle.hasExited() ?? false);
  }

  function watchExit(service: OwnedService): void {
    service.handle.onExit(() => {
      if (shuttingDown) return;
      const isCurrent = gateway === service || proxy === service;
      if (!isCurrent) return;
      record(service.handle.kind === "gateway" ? "gateway" : "proxy", "exited");
      if (state.state === "ready") {
        state = { state: "unavailable", category: "unavailable" };
        deps.clearAuthorization();
      }
    });
  }

  async function waitFor(probeOnce: () => Promise<ProbeResult>, timeoutMs: number, gen: number): Promise<WaitStatus> {
    const deadline = deps.now() + timeoutMs;
    for (;;) {
      if (gen !== generation) return "stale";
      const result = await probeOnce();
      if (gen !== generation) return "stale";
      if (result.ok) return "ok";
      if (result.definitive) return "rejected";
      if (ownedProcessFailed()) return "exited";
      if (deps.now() >= deadline) return "timeout";
      await deps.sleep(timings.pollIntervalMs);
    }
  }

  async function ensureGateway(gen: number, gatewayHealthy: boolean): Promise<boolean> {
    if (gatewayHealthy) {
      record("gateway", "reused");
      return true;
    }
    if (gateway) {
      await deps.stopChild(gateway.handle);
      gateway = null;
    }
    if (gen !== generation) return false;
    setStarting(gen, "gateway");
    const handle = deps.startGateway();
    if (!handle) {
      fail(gen, "hermes_start_failed", "gateway", "spawn-failed");
      return false;
    }
    gateway = { handle };
    watchExit(gateway);
    record("gateway", "started");
    const status = await waitFor(() => deps.probe("gatewayHealth"), timings.gatewayReadyTimeoutMs, gen);
    if (status === "stale") return false;
    if (status !== "ok") {
      fail(gen, "hermes_start_failed", "gateway", status === "exited" ? "exited" : "timeout");
      return false;
    }
    record("gateway", "ready");
    return true;
  }

  async function ensureProxy(gen: number, apiKey: string, proxyHealthy: boolean): Promise<boolean> {
    if (proxyHealthy) {
      record("proxy", "reused");
      return true;
    }
    if (proxy) {
      await deps.stopChild(proxy.handle);
      proxy = null;
    }
    if (gen !== generation) return false;
    setStarting(gen, "proxy");
    const handle = deps.startProxy(apiKey);
    if (!handle) {
      fail(gen, "secure_connection_unverified", "proxy", "spawn-failed");
      return false;
    }
    proxy = { handle };
    watchExit(proxy);
    record("proxy", "started");
    const status = await waitFor(() => deps.probe("proxyHealth"), timings.proxyReadyTimeoutMs, gen);
    if (status === "stale") return false;
    if (status !== "ok") {
      fail(gen, "secure_connection_unverified", "proxy", status === "exited" ? "exited" : "timeout");
      return false;
    }
    record("proxy", "ready");
    return true;
  }

  function verifyFailure(status: WaitStatus): SafeLocalAiFailureCategory {
    if (status === "exited") return "hermes_start_failed";
    if (status === "timeout") return "model_unresponsive";
    return "secure_connection_unverified";
  }

  async function verify(gen: number, apiKey: string): Promise<boolean> {
    setStarting(gen, "verifying");
    const checks: Array<[DiagStage, () => Promise<ProbeResult>]> = [
      ["auth-check", () => deps.probe("proxyRejectsMissingKey")],
      ["auth-check", () => deps.probe("proxyRejectsWrongKey")],
      ["toolset-check", () => deps.probe("gatewayToolsets", apiKey)],
    ];
    for (const [stage, probeOnce] of checks) {
      const status = await waitFor(probeOnce, timings.verifyTimeoutMs, gen);
      if (status === "stale") return false;
      if (status !== "ok") {
        fail(gen, verifyFailure(status), stage, status === "timeout" ? "timeout" : status === "exited" ? "exited" : "rejected");
        return false;
      }
      record(stage, "ok");
    }
    const applied = await deps.applyAuthorization(apiKey);
    if (gen !== generation) return false;
    if (!applied) {
      fail(gen, "secure_connection_unverified", "auth-check", "failed");
      return false;
    }
    const connected = await deps.verifyConnection();
    if (gen !== generation) return false;
    if (!connected) {
      fail(gen, "model_unresponsive", "health-check", "failed");
      return false;
    }
    record("health-check", "ok");
    return true;
  }

  async function runStartup(gen: number): Promise<void> {
    setStarting(gen, "checking");
    record("checking", "started");
    // A handle whose process already exited (from an earlier attempt) is forgotten here, so its
    // exit is never mistaken for a failure of this attempt's own services.
    if (gateway?.handle.hasExited()) gateway = null;
    if (proxy?.handle.hasExited()) proxy = null;
    const gatewayProbe = await deps.probe("gatewayHealth");
    if (gen !== generation) return;
    const proxyProbe = await deps.probe("proxyHealth");
    if (gen !== generation) return;

    if (!(await ensureGateway(gen, gatewayProbe.ok))) return;

    setStarting(gen, "proxy");
    const apiKey = await deps.readApiKey();
    if (gen !== generation) return;
    if (!apiKey) {
      fail(gen, "secure_connection_unverified", "key", "missing");
      return;
    }
    record("key", "ok");

    if (!(await ensureProxy(gen, apiKey, proxyProbe.ok))) return;
    if (!(await verify(gen, apiKey))) return;

    if (gen !== generation) return;
    record("runtime", "ready");
    state = { state: "ready" };
  }

  function begin(): void {
    generation += 1;
    const gen = generation;
    attemptStartedAt = deps.now();
    timeline = [];
    state = { state: "starting", stage: "checking" };
    runPromise = runStartup(gen)
      .catch(() => fail(gen, "unavailable", "runtime", "failed"))
      .finally(() => {
        if (generation === gen) runPromise = null;
      });
  }

  function buildDiagnostics(): string {
    const lines: string[] = ["Vyron Code yerel AI tanilama", `Durum: ${state.state}`];
    if (state.state === "unavailable") lines.push(`Kategori: ${state.category}`);
    if (state.state === "starting") lines.push(`Asama: ${state.stage}`);
    lines.push("Adimlar:");
    for (const event of timeline) lines.push(`+${event.offsetSeconds}s ${event.stage} ${event.outcome}`);
    return lines.join("\n").slice(0, MAX_DIAG_TEXT_CHARS);
  }

  return {
    async start(): Promise<LocalAiState> {
      if (shuttingDown) return { ...state };
      if (runPromise === null && state.state !== "ready") begin();
      if (runPromise) await runPromise;
      return { ...state };
    },
    getState(): LocalAiState {
      return { ...state };
    },
    retry(): LocalAiState {
      if (shuttingDown || state.state !== "unavailable") return { ...state };
      begin();
      return { ...state };
    },
    copyDiagnostics(): SafeCopyResult {
      try {
        deps.writeClipboard(buildDiagnostics());
        return { copied: true };
      } catch {
        return { copied: false };
      }
    },
    async shutdown(): Promise<void> {
      shuttingDown = true;
      generation += 1;
      deps.clearAuthorization();
      const owned = [gateway, proxy].filter((service): service is OwnedService => service !== null);
      gateway = null;
      proxy = null;
      await Promise.all(owned.map((service) => deps.stopChild(service.handle).catch(() => undefined)));
    },
  };
}
