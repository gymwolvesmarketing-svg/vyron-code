/**
 * Main-process-only bridge to the bundled Ruflo runtime - VYRON_CODE_RUFLO_MANAGERS.
 *
 * Ruflo is the orchestration layer behind the Managers (SubAgents). It runs as a child process of the
 * app speaking MCP JSON-RPC over stdio: there is no listening port, no renderer access and no shell.
 * This module is pure and dependency-injected (the child process itself comes from rufloAdapters.ts), so its
 * behavior is fully testable with a fake transport.
 *
 * Boundaries:
 *   - Only five Ruflo tools are ever called (`agent_spawn`, `agent_execute`, `agent_terminate` and the project-
 *     memory pair `memory_search`/`memory_store`), and the agent type must be one of the fixed roles below;
 *     nothing else Ruflo advertises can be reached.
 *   - Project memory is Ruflo's persistent store under the app's own data folder, one namespace per project
 *     (electron/rufloTeam.ts). A "task-orchestrator" run is a team run: a planner splits the task, up to three
 *     workers run in parallel, and a synthesis step merges their answers. Memory is recalled before and a short
 *     note is stored after every run.
 *   - `agent_execute` only calls the language model (through the local auth proxy to Hermes); it runs no
 *     tools and no shell.
 *   - The Hermes credential is handed to the child by the adapter and never appears in a result, error,
 *     diagnostic or renderer-visible value.
 *   - One run at a time, bounded timeouts, no automatic restart loop (a run may restart the child once).
 */

/** The fixed set of Ruflo roles a Manager may use. Mirrored (and re-validated) by the renderer model. */
export const RUFLO_AGENT_TYPES = [
  "coder",
  "reviewer",
  "tester",
  "planner",
  "researcher",
  "system-architect",
  "security-auditor",
  "task-orchestrator",
] as const;

export type RufloAgentType = (typeof RUFLO_AGENT_TYPES)[number];

export function isRufloAgentType(value: unknown): value is RufloAgentType {
  return typeof value === "string" && (RUFLO_AGENT_TYPES as readonly string[]).indexOf(value) >= 0;
}

export const ALLOWED_RUFLO_TOOLS = ["agent_spawn", "agent_execute", "agent_terminate", "memory_search", "memory_store"] as const;
type RufloTool = (typeof ALLOWED_RUFLO_TOOLS)[number];

import {
  MAX_RECALLED_MEMORIES,
  MEMORY_SIMILARITY_THRESHOLD,
  fallbackPlan,
  memoryNamespace,
  memoryNote,
  parsePlan,
  plannerPrompt,
  recalledSnippets,
  synthesisPrompt,
  teamFooter,
  withMemory,
  workerPrompt,
  type SubTaskResult,
} from "./rufloTeam";

export const MAX_RUFLO_PROMPT_CHARS = 4_000;
export const MAX_RUFLO_ASK_CHARS = 40_000;
export const MAX_RUFLO_OUTPUT_CHARS = 20_000;

export interface RufloTransport {
  send(line: string): void;
  onLine(callback: (line: string) => void): void;
  onExit(callback: () => void): void;
  hasExited(): boolean;
}

export interface RufloDeps {
  /** Starts the runtime for this app session; null when it cannot be started (missing files, spawn error). */
  start(apiKey: string): RufloTransport | null;
  stop(transport: RufloTransport): Promise<void>;
  readApiKey(): Promise<string | null>;
  /** Deletes Ruflo's persistent memory folders (called only after the child has been stopped). */
  clearMemory?(): Promise<void>;
}

export interface RufloTimings {
  readonly handshakeMs: number;
  readonly callMs: number;
  readonly executeMs: number;
}

export const DEFAULT_RUFLO_TIMINGS: RufloTimings = { handshakeMs: 60_000, callMs: 30_000, executeMs: 180_000 };

export type RufloState = "idle" | "starting" | "ready" | "failed";

export type RufloResult =
  | { readonly ok: true; readonly text: string; readonly note?: string }
  | { readonly ok: false; readonly reason: "unavailable" | "failed" };

export interface RufloBridge {
  getState(): RufloState;
  run(agentType: unknown, prompt: unknown, project?: unknown): Promise<RufloResult>;
  /** Stops the runtime and deletes the persistent project memory. Resolves true when nothing is left. */
  clearMemory(): Promise<boolean>;
  /** One raw agent turn (no memory, bigger prompt allowance) for the approved-tool loop. null = failed. */
  ask(agentType: unknown, prompt: unknown): Promise<string | null>;
  shutdown(): Promise<void>;
}

interface Pending {
  resolve(message: Record<string, unknown>): void;
}

export function createRufloBridge(deps: RufloDeps, timings: RufloTimings = DEFAULT_RUFLO_TIMINGS): RufloBridge {
  let state: RufloState = "idle";
  let transport: RufloTransport | null = null;
  let nextId = 1;
  let counter = 0;
  const pending = new Map<number, Pending>();
  let busy = false;
  let shuttingDown = false;

  function failPending(): void {
    for (const entry of pending.values()) entry.resolve({ error: { message: "closed" } });
    pending.clear();
  }

  function attach(t: RufloTransport): void {
    t.onLine((line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null) return;
      const record = message as Record<string, unknown>;
      const id = record.id;
      if (typeof id !== "number") return;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      entry.resolve(record);
    });
    t.onExit(() => {
      if (transport === t) {
        transport = null;
        if (!shuttingDown && state !== "idle") state = "failed";
      }
      failPending();
    });
  }

  function request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown> | null> {
    const t = transport;
    if (!t || t.hasExited()) return Promise.resolve(null);
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, timeoutMs);
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve("error" in message && message.error !== undefined && !("result" in message) ? null : message);
        },
      });
      try {
        t.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        resolve(null);
      }
    });
  }

  async function ensureStarted(): Promise<boolean> {
    if (transport && !transport.hasExited() && state === "ready") return true;
    if (transport) {
      const old = transport;
      transport = null;
      await deps.stop(old);
    }
    state = "starting";
    const apiKey = await deps.readApiKey();
    if (apiKey === null || shuttingDown) {
      state = "failed";
      return false;
    }
    const started = deps.start(apiKey);
    if (!started) {
      state = "failed";
      return false;
    }
    transport = started;
    attach(started);
    const init = await request(
      "initialize",
      { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vyron-code", version: "1" } },
      timings.handshakeMs,
    );
    if (!init || started.hasExited()) {
      state = "failed";
      transport = null;
      await deps.stop(started);
      return false;
    }
    try {
      started.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    } catch {
      state = "failed";
      return false;
    }
    state = "ready";
    return true;
  }

  async function callTool(tool: RufloTool, args: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown> | null> {
    if ((ALLOWED_RUFLO_TOOLS as readonly string[]).indexOf(tool) < 0) return null;
    const message = await request("tools/call", { name: tool, arguments: args }, timeoutMs);
    if (!message) return null;
    const result = message.result;
    if (typeof result !== "object" || result === null) return null;
    const content = (result as Record<string, unknown>).content;
    if (!Array.isArray(content) || content.length === 0) return null;
    const first = content[0] as Record<string, unknown> | undefined;
    if (!first || typeof first.text !== "string") return null;
    try {
      const parsed: unknown = JSON.parse(first.text);
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /** True when the child process died (as opposed to answering with a normal failure). */
  function childGone(): boolean {
    return transport === null || transport.hasExited();
  }

  /** Spawns a tracked agent, runs one prompt on it and cleans it up. null = failed; "gone" = the child died. */
  async function executeAgent(agentType: RufloAgentType, prompt: string): Promise<string | null | "gone"> {
    counter += 1;
    const agentId = "vyron-" + agentType + "-" + String(counter);
    const spawned = await callTool("agent_spawn", { agentType, agentId }, timings.callMs);
    if (!spawned || spawned.success !== true) return childGone() ? "gone" : null;
    const executed = await callTool("agent_execute", { agentId, prompt, maxTokens: 2048 }, timings.executeMs);
    // Best-effort cleanup of the tracked agent record; its result never matters to the caller.
    void callTool("agent_terminate", { agentId }, timings.callMs);
    if (!executed || executed.success !== true || typeof executed.output !== "string") return childGone() ? "gone" : null;
    return executed.output.slice(0, MAX_RUFLO_OUTPUT_CHARS);
  }

  async function recall(namespace: string, query: string): Promise<string[]> {
    const reply = await callTool(
      "memory_search",
      { query: query.slice(0, 500), namespace, limit: MAX_RECALLED_MEMORIES, threshold: MEMORY_SIMILARITY_THRESHOLD },
      timings.callMs,
    );
    return recalledSnippets(reply);
  }

  async function remember(namespace: string, task: string, answer: string): Promise<void> {
    await callTool(
      "memory_store",
      { key: "gorev-" + String(Date.now()) + "-" + String(counter), value: memoryNote(task, answer), namespace, tags: ["gorev"], upsert: true },
      timings.callMs,
    );
  }

  async function runTeam(prompt: string, snippets: string[]): Promise<RufloResult> {
    const planned = await executeAgent("planner", plannerPrompt(prompt, snippets));
    if (planned === "gone") return { ok: false, reason: "unavailable" };
    let subtasks = planned === null ? [] : parsePlan(planned);
    if (subtasks.length === 0) subtasks = fallbackPlan(prompt);
    // The workers run at the same time; each is an independent tracked agent on the same Ruflo process.
    const settled = await Promise.all(subtasks.map((subtask) => executeAgent(subtask.role, workerPrompt(subtask, prompt, snippets))));
    if (settled.some((value) => value === "gone")) return { ok: false, reason: "unavailable" };
    const results: SubTaskResult[] = subtasks.map((subtask, index) => {
      const value = settled[index];
      return { title: subtask.title, role: subtask.role, text: typeof value === "string" ? value : null };
    });
    if (results.every((entry) => entry.text === null)) return { ok: false, reason: "failed" };
    const merged = await executeAgent("task-orchestrator", synthesisPrompt(prompt, results));
    if (merged === "gone") return { ok: false, reason: "unavailable" };
    const answer =
      merged !== null && merged.trim().length > 0
        ? merged
        : results
            .map((entry) => entry.text ?? "")
            .filter((text) => text.length > 0)
            .join("\n\n");
    return { ok: true, text: (answer + teamFooter(results)).slice(0, MAX_RUFLO_OUTPUT_CHARS), note: answer };
  }

  async function runOnce(agentType: RufloAgentType, prompt: string, project: unknown): Promise<RufloResult> {
    if (!(await ensureStarted())) return { ok: false, reason: "unavailable" };
    const namespace = memoryNamespace(project);
    const snippets = await recall(namespace, prompt);
    let outcome: RufloResult;
    if (agentType === "task-orchestrator") {
      outcome = await runTeam(prompt, snippets);
    } else {
      const text = await executeAgent(agentType, withMemory(prompt, snippets));
      if (text === "gone") return { ok: false, reason: "unavailable" };
      outcome = text === null ? { ok: false, reason: "failed" } : { ok: true, text: text.slice(0, MAX_RUFLO_OUTPUT_CHARS), note: text };
    }
    if (outcome.ok && outcome.note !== undefined) await remember(namespace, prompt, outcome.note);
    return outcome.ok ? { ok: true, text: outcome.text } : outcome;
  }

  return {
    getState: () => state,
    async run(agentType, prompt, project) {
      if (shuttingDown) return { ok: false, reason: "unavailable" };
      if (!isRufloAgentType(agentType)) return { ok: false, reason: "failed" };
      if (typeof prompt !== "string" || prompt.trim().length === 0 || prompt.length > MAX_RUFLO_PROMPT_CHARS) return { ok: false, reason: "failed" };
      if (busy) return { ok: false, reason: "failed" };
      busy = true;
      try {
        let result = await runOnce(agentType, prompt, project);
        // A run may restart the child once if it died or never came up; there is no restart loop.
        if (!result.ok && result.reason === "unavailable" && !shuttingDown) result = await runOnce(agentType, prompt, project);
        return result;
      } catch {
        return { ok: false, reason: "failed" };
      } finally {
        busy = false;
      }
    },
    async ask(agentType, prompt) {
      if (shuttingDown || !isRufloAgentType(agentType)) return null;
      if (typeof prompt !== "string" || prompt.trim().length === 0 || prompt.length > MAX_RUFLO_ASK_CHARS) return null;
      if (busy) return null;
      busy = true;
      try {
        let text: string | null | "gone" = "gone";
        if (await ensureStarted()) text = await executeAgent(agentType, prompt);
        if (text === "gone" && !shuttingDown && (await ensureStarted())) text = await executeAgent(agentType, prompt);
        return typeof text === "string" && text !== "gone" ? text : null;
      } catch {
        return null;
      } finally {
        busy = false;
      }
    },
    async clearMemory() {
      if (busy || shuttingDown) return false;
      busy = true;
      try {
        const t = transport;
        transport = null;
        state = "idle";
        failPending();
        if (t) await deps.stop(t);
        if (deps.clearMemory) await deps.clearMemory();
        return true;
      } catch {
        return false;
      } finally {
        busy = false;
      }
    },
    async shutdown() {
      shuttingDown = true;
      const t = transport;
      transport = null;
      state = "idle";
      failPending();
      if (t) await deps.stop(t);
    },
  };
}
