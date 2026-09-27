/**
 * Main-process-only Hermes task submission service (direct send).
 *
 * Exactly one capability: accept the user's own plain-text task via `sendTask({ draft })`,
 * validate it independently of the renderer, send exactly that text as one bounded, non-streaming
 * `POST /v1/chat/completions` request, and reduce the response to a single bounded plain-text
 * field. There is no review, snapshot or approval step: the user writes a task and sends it. No
 * workspace, file, search, Git, skill, connector or attachment data is ever attached; the request
 * body is `{ messages: [{ role: "user", content }], stream: false }` and nothing else.
 *
 * Safety properties this module still guarantees:
 *   - Credential and endpoint come only from electron/hermesAuthorization.ts and
 *     electron/hermesEndpointSetup.ts/hermesEndpoint.ts (set by the local AI lifecycle manager,
 *     never by the renderer). The credential is only ever sent in the Authorization header.
 *   - Tool isolation (`platform_toolsets.api_server: ["no_mcp"]`, verified live at startup) and the
 *     auth proxy (scripts/hermes-auth-proxy.mjs) remain the boundary that makes this request safe.
 *   - Nothing here persists a task or response. The text lives in main-process memory only while a
 *     send is in flight or its answer is held for the renderer, and is cleared on every
 *     clear/revoke/quit path.
 *   - Exactly one send may be in flight; a monotonic generation counter discards any stale
 *     completion after a clear/revoke/newer send.
 *   - The renderer only ever receives the fixed `HermesTaskSubmissionState` enum plus the one
 *     bounded, plain-text response field, never a raw status, header, body, endpoint or credential.
 */
import { modelForRole, parseModelChoice, withToolsRouting, type ModelChoice } from "./modelRouting";
import type { HermesTaskSubmissionState } from "./shared-ipc-contract";
import { getAuthorizationState, getCurrentCredential } from "./hermesAuthorization";
import { resolveTrustedEndpoint } from "./hermesEndpoint";
import { getConfiguredEndpoint } from "./hermesEndpointSetup";
import { isRufloAgentType } from "./rufloBridge";
import { flattenTranscript, type ChatMessage } from "./toolPolicy";

/**
 * Approved-tool runner (injected by electron/main.ts): runs the model/tool loop for a task that asked for tools. It gets
 * an `ask` function that sends a transcript to the model (directly to Hermes, or through a Manager's Ruflo agent) and
 * returns its plain-text reply; the runner does everything else (parsing, user approval, confined execution).
 */
export type ToolRunnerFn = (
  task: string,
  ask: (messages: readonly ChatMessage[]) => Promise<string | null>,
) => Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false }>;

/** One raw Ruflo agent turn (no memory, larger prompt allowance) used by tool runs with a Manager. */
export type AgentAskFn = (agentType: string, prompt: string, models?: ModelChoice) => Promise<string | null>;

let toolRunner: ToolRunnerFn | null = null;
let agentAsk: AgentAskFn | null = null;

export function setToolRunner(runner: ToolRunnerFn | null): void {
  toolRunner = runner;
}

export function setAgentAsk(ask: AgentAskFn | null): void {
  agentAsk = ask;
}

const MAX_TOOL_RESPONSE_CHARS = 200_000;

/**
 * Optional executor for Manager (SubAgent) tasks, injected by electron/main.ts. When a request names an agent
 * role, the task is run through it (Ruflo -> local auth proxy -> Hermes) instead of the direct Hermes request.
 * The role is validated against a fixed allowlist here; the executor never receives anything else from the
 * renderer.
 */
export type TaskAgentExecutor = (agentType: string, prompt: string, project: string | undefined, models?: ModelChoice) => Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false }>;

let agentExecutor: TaskAgentExecutor | null = null;

export function setTaskAgentExecutor(executor: TaskAgentExecutor | null): void {
  agentExecutor = executor;
}

/** Duplicated from electron/taskComposer.ts's own `MAX_DRAFT_LENGTH`/control-character rule
 * (that module is never imported here — see its own header on why every consumer duplicates
 * these locally) — this module never trusts the renderer's own prior validation and always
 * re-checks independently before ever holding or sending a snapshot. */
const MAX_DRAFT_LENGTH = 100_000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** A new, independently disclosed bound for this module's one request — generous enough for a
 * real agent turn (which can be far slower than the fixed `/health` probe's own 10s bound in
 * electron/hermesApiServer.ts), still finite. */
const SEND_TIMEOUT_MS = 60_000;

/** Bounded renderer-facing response size — independent of whatever token/usage accounting the
 * server itself reports, which this module never forwards. */
const MAX_RESPONSE_CHARS = 200_000;

type AmbientState = "idle" | "sending" | "completed" | "unavailable" | "unauthorized" | "safe_failure" | "cancelled";

let ambientState: AmbientState = "idle";
let lastCompletedText: string | null = null;
let lastCompletedTruncated = false;
let sendInFlight = false;

/** Monotonic generation counter — identical T-17-style guard to every other Hermes module in
 * this codebase. Bumped by every reset; checked after the one `await fetch(...)` resolves so a
 * send superseded by a clear/revoke/newer send can never commit a now-stale "completed"
 * state. */
let generation = 0;

function validateDraft(raw: string): boolean {
  if (raw.length === 0) return false;
  if (raw.length > MAX_DRAFT_LENGTH) return false;
  if (CONTROL_CHARACTER_PATTERN.test(raw)) return false;
  if (raw.trim().length === 0) return false;
  return true;
}

/** Returns `unauthorized`/`unavailable` if a precondition is unmet, or `null` if both
 * authorization and a trusted endpoint are currently in place. Never caches its own result. */
function currentPreconditionState(): "unauthorized" | "unavailable" | null {
  if (getAuthorizationState().state !== "authorized_memory_only") return "unauthorized";
  const endpoint = getConfiguredEndpoint() ?? resolveTrustedEndpoint();
  if (endpoint.kind !== "trusted") return "unavailable";
  return null;
}

function resetToIdle(): void {
  generation++;
  sendInFlight = false;
  lastCompletedText = null;
  lastCompletedTruncated = false;
  ambientState = "idle";
}

function safeState(state: AmbientState): HermesTaskSubmissionState {
  return {
    state,
    text: state === "completed" ? lastCompletedText : null,
    truncated: state === "completed" ? lastCompletedTruncated : false,
  };
}

/**
 * The only safe, renderer-facing task-submission state. Self-heals: if authorization or
 * endpoint configuration is no longer in place while this module was tracking anything beyond
 * `idle`, this call resets to `idle` first — a stale completed answer from a
 * now-revoked authorization/endpoint can no longer be trusted or shown.
 */
export function getTaskSubmissionState(): HermesTaskSubmissionState {
  const precondition = currentPreconditionState();
  if (precondition) {
    if (ambientState !== "idle") resetToIdle();
    return safeState(precondition);
  }
  return safeState(ambientState);
}

/**
 * The single, user-initiated send action and the one narrow, schema-validated crossing point for
 * the user's own task text. Validates the request shape (exactly one string field, `draft`) and
 * draft bounds, re-checks authorization and endpoint, then sends exactly one non-streaming
 * `POST <origin>/v1/chat/completions` (`messages: [{role:"user", content}]` only, no `model`,
 * no tools, `stream: false`, `Authorization: Bearer <credential>`). A call while another send is in
 * flight is reduced to `sending` and never starts a second request.
 */
export async function sendTask(request: unknown): Promise<HermesTaskSubmissionState> {
  const precondition = currentPreconditionState();
  if (precondition) {
    if (ambientState !== "idle") resetToIdle();
    return safeState(precondition);
  }
  if (sendInFlight) return safeState("sending");
  if (typeof request !== "object" || request === null || Array.isArray(request)) return safeState("safe_failure");
  const keys = Object.keys(request as Record<string, unknown>);
  const hasAgent = keys.indexOf("agent") >= 0;
  const hasTools = keys.indexOf("tools") >= 0;
  const hasModels = keys.indexOf("models") >= 0;
  const allowedKeys = ["draft"].concat(hasAgent ? ["agent", "project"] : [], hasTools ? ["tools"] : [], hasModels ? ["models"] : []);
  if (keys.indexOf("draft") < 0 || keys.some((key) => allowedKeys.indexOf(key) < 0)) return safeState("safe_failure");
  const draft = (request as Record<string, unknown>).draft;
  if (typeof draft !== "string" || !validateDraft(draft)) return safeState("safe_failure");
  const agent = hasAgent ? (request as Record<string, unknown>).agent : null;
  if (hasAgent && (!isRufloAgentType(agent) || agentExecutor === null)) return safeState("safe_failure");
  // Tools: only the literal `true`, only when a runner is installed (and, with a Manager, a raw agent turn is available).
  if (hasTools && ((request as Record<string, unknown>).tools !== true || toolRunner === null || (hasAgent && agentAsk === null))) return safeState("safe_failure");
  // Optional project id (memory scope): a plain slug or nothing; anything else is rejected, never sanitized silently.
  const projectField = hasAgent ? (request as Record<string, unknown>).project : undefined;
  if (projectField !== undefined && (typeof projectField !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(projectField))) return safeState("safe_failure");
  const project = typeof projectField === "string" ? projectField : undefined;
  // Optional per-role model choice: strictly allowlisted combo names, never a free-form model string.
  const models = hasModels ? parseModelChoice((request as Record<string, unknown>).models) : null;
  if (hasModels && models === null) return safeState("safe_failure");
  // With tools every role uses the `tools` model (see withToolsRouting).
  const routedModels = withToolsRouting(models, hasTools);
  const directModel = modelForRole(routedModels, agent === null ? null : (agent as string));

  const endpoint = getConfiguredEndpoint() ?? resolveTrustedEndpoint();
  if (endpoint.kind !== "trusted") return safeState("unavailable");
  const credential = getCurrentCredential();
  if (credential === null) return safeState("unauthorized");

  sendInFlight = true;
  lastCompletedText = null;
  lastCompletedTruncated = false;
  const generationAtStart = ++generation;
  ambientState = "sending";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    let text: string | null;
    let responseLimit = MAX_RESPONSE_CHARS;
    if (hasTools && toolRunner !== null) {
      responseLimit = MAX_TOOL_RESPONSE_CHARS;
      const ask = async (messages: readonly ChatMessage[]): Promise<string | null> => {
        if (hasAgent && agentAsk !== null) return agentAsk(agent as string, flattenTranscript(messages), routedModels);
        const stepController = new AbortController();
        const stepTimer = setTimeout(() => stepController.abort(), SEND_TIMEOUT_MS);
        try {
          const stepResponse = await fetch(`${endpoint.url.origin}/v1/chat/completions`, {
            method: "POST",
            redirect: "error",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
            body: JSON.stringify({ messages: messages.map((m) => ({ role: m.role, content: m.content })), stream: false, ...(directModel ? { model: directModel } : {}) }),
            signal: stepController.signal,
          });
          if (!stepResponse.ok) return null;
          return extractSafeResponseText(await stepResponse.json());
        } catch {
          return null;
        } finally {
          clearTimeout(stepTimer);
        }
      };
      const outcome = await toolRunner(draft, ask);
      text = outcome.ok ? outcome.text : null;
      clearTimeout(timer);
      if (generation !== generationAtStart) return getTaskSubmissionState();
      sendInFlight = false;
    } else if (hasAgent && agentExecutor !== null) {
      // Manager task: Ruflo runs the agent (its own bounded timeouts apply); the reply is reduced exactly like a direct one.
      const outcome = await agentExecutor(agent as string, draft, project, models ?? undefined);
      text = outcome.ok ? outcome.text : null;
      clearTimeout(timer);
      if (generation !== generationAtStart) return getTaskSubmissionState();
      sendInFlight = false;
    } else {
      const response = await fetch(`${endpoint.url.origin}/v1/chat/completions`, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: draft }],
          stream: false,
          ...(directModel ? { model: directModel } : {}),
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (generation !== generationAtStart) return getTaskSubmissionState();
      sendInFlight = false;
      if (!response.ok) {
        text = null;
      } else {
        const body: unknown = await response.json();
        if (generation !== generationAtStart) return getTaskSubmissionState();
        text = extractSafeResponseText(body);
      }
    }
    // Defensive re-check: authorization/endpoint may have been revoked without this module's own
    // clear path running. A completed answer is never committed once either precondition is gone.
    const preconditionAfterFetch = currentPreconditionState();
    if (preconditionAfterFetch) {
      resetToIdle();
      return safeState(preconditionAfterFetch);
    }
    if (text === null) {
      ambientState = "safe_failure";
      return safeState("safe_failure");
    }
    const truncated = text.length > responseLimit;
    lastCompletedText = truncated ? text.slice(0, responseLimit) : text;
    lastCompletedTruncated = truncated;
    ambientState = "completed";
    return safeState("completed");
  } catch {
    clearTimeout(timer);
    if (generation !== generationAtStart) return getTaskSubmissionState();
    sendInFlight = false;
    const preconditionAfterFetch = currentPreconditionState();
    if (preconditionAfterFetch) {
      resetToIdle();
      return safeState(preconditionAfterFetch);
    }
    ambientState = "safe_failure";
    return safeState("safe_failure");
  }
}

/**
 * Reduces an arbitrary parsed JSON response body to the one safe, bounded, plain-text field
 * this module ever displays — `choices[0].message.content`, and only when it is a plain
 * string. Any tool call, non-string content, missing choice, or unexpected shape returns
 * `null` (mapped to `safe_failure` by the caller) rather than guessing — never executes,
 * renders, or forwards anything beyond that one string.
 */
function extractSafeResponseText(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const choices = (body as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== "string") return null;
  // A router/provider error that came back as the message text (e.g. "[Error: ...]") is a failure, not an answer.
  if (/^\s*\[Error:/i.test(content)) return null;
  return content;
}

/**
 * Explicit, immediate, idempotent cleanup — called from electron/main.ts on clear-
 * authorization, clear-endpoint-configuration, and app before-quit, mirroring every other
 * Hermes module's own established composition pattern. Also the renderer's own explicit
 * "clear answer" path. Safe to call whether or not anything is
 * currently sending or completed.
 */
export function clearTaskSubmission(): HermesTaskSubmissionState {
  resetToIdle();
  const precondition = currentPreconditionState();
  if (precondition) return safeState(precondition);
  return safeState("idle");
}
