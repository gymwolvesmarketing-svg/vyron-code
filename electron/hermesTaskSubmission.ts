/**
 * Main-process-only, explicit-review-gated Hermes task submission service —
 * VYRON_CODE_COMPLETE_LOCAL_HERMES_D11_DELIVERY_AUTHORIZATION.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS MODULE DOES
 * ════════════════════════════════════════════════════════════════════════════════════
 * Exactly one capability, in three explicit steps: (1) accept the user's own plain-text task
 * draft via `reviewTaskDraft()`, validating it and holding an immutable snapshot in
 * main-process memory only; (2) on `sendReviewedTask()`, send that exact snapshot — nothing
 * else — as one bounded, non-streaming `POST /v1/chat/completions` request; (3) reduce the
 * response to a single bounded, plain-text field. No workspace, file, search, Git, task
 * profile, or "selected context" data is ever attached — those exist only in the renderer's
 * own local D-09 review surface for the user's own information, never transmitted.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS TARGETS /v1/chat/completions, AND WHAT MAKES IT SAFE TODAY
 * ════════════════════════════════════════════════════════════════════════════════════
 * Per VYRON_CODE_V02_D11_EXPLICIT_TASK_SUBMISSION_CONTRACT_DISCOVERY_REPORT.md and
 * VYRON_CODE_V02_D11_HERMES_API_SERVER_CAPABILITY_ISOLATION_DISCOVERY_REPORT.md,
 * `/v1/chat/completions` is the smallest of the three OpenAI-shaped task routes the installed
 * Hermes Agent API Server exposes, and by default runs the full agent (tools, memory,
 * delegation, MCP) with no per-request way for a client to disable any of that. Two local,
 * source-verified mitigations make this module's actual request safe against the real,
 * locally-configured Hermes install:
 *
 *   1. Tool isolation — PROVEN, applied, and live-verified this task: this machine's
 *      `%LOCALAPPDATA%\hermes\config.yaml` now sets `platform_toolsets.api_server: ["no_mcp"]`,
 *      confirmed live via `GET /v1/toolsets` to report zero enabled toolsets for this platform
 *      (terminal, file, code_execution, browser, web, delegation, memory, skills, and every
 *      default MCP server all report `"enabled": false`). Hermes's own two-layer enforcement
 *      (schema exposure AND dispatch-time `validate_tool_calls` rejection of any tool name not
 *      in the resolved set) makes this a real boundary, not just an advertised one.
 *   2. Authentication — the installed Hermes Agent version enforces no `API_SERVER_KEY` check
 *      on `/v1/chat/completions` itself (confirmed against both the local install and the
 *      current official upstream source). Patching Hermes's own installed source to add that
 *      check was attempted and was blocked by this development environment's own permission
 *      system (see hermes-patches/0001-api-server-task-auth-and-ephemeral-history.patch for the
 *      reviewable, unapplied patch). This module instead targets `scripts/hermes-auth-proxy.mjs`
 *      — a small local reverse proxy that enforces the missing check itself, using the same
 *      `API_SERVER_KEY` value — see that script's own header. The endpoint the user configures
 *      via D-08E's existing setup panel should be the proxy's port, not Hermes's own port.
 *
 * What this module still cannot prove or guarantee, honestly stated: the installed Hermes
 * Agent's task/response persistence (a `session_db` handle + durable SQLite write) is NOT
 * disabled by anything reachable from this module's own request — that gap requires a source
 * patch to Hermes itself (also in the same unapplied patch file above) that this environment's
 * permission system likewise would not allow this module to apply on the user's behalf. This is
 * disclosed here, in the required report, and in VYRON_CODE_D11_LOCAL_HERMES_SETUP_AND_UAT.md —
 * never silently assumed solved.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * SECURITY BOUNDARY — IDENTICAL DISCIPLINE TO electron/hermesApiServer.ts
 * ════════════════════════════════════════════════════════════════════════════════════
 * Credential and endpoint are read from electron/hermesAuthorization.ts and
 * electron/hermesEndpointSetup.ts/hermesEndpoint.ts exactly as hermesApiServer.ts already does
 * — never a second, parallel source. The reviewed draft snapshot is immutable, main-process-
 * memory-only, cleared on every clear/send/revoke path, and never persisted. Exactly one send
 * may be in flight; a monotonic generation counter (the same T-17-style guard used by every
 * other Hermes module in this codebase) discards any stale completion after a clear/revoke/
 * newer-send. The renderer never receives a raw HTTP status, header, body, endpoint, or
 * credential — only the fixed `HermesTaskSubmissionState` enum plus the one bounded,
 * plain-text response field.
 */
import type { HermesTaskSubmissionState } from "./shared-ipc-contract";
import { getAuthorizationState, getCurrentCredential } from "./hermesAuthorization";
import { resolveTrustedEndpoint } from "./hermesEndpoint";
import { getConfiguredEndpoint } from "./hermesEndpointSetup";

/** Duplicated from electron/taskComposer.ts's own `MAX_DRAFT_LENGTH`/control-character rule
 * (that module is never imported here — see its own header on why every consumer duplicates
 * these locally) — this module never trusts the renderer's own prior validation and always
 * re-checks independently before ever holding or sending a snapshot. */
const MAX_DRAFT_LENGTH = 4_000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** A new, independently disclosed bound for this module's one request — generous enough for a
 * real agent turn (which can be far slower than the fixed `/health` probe's own 10s bound in
 * electron/hermesApiServer.ts), still finite. */
const SEND_TIMEOUT_MS = 60_000;

/** Bounded renderer-facing response size — independent of whatever token/usage accounting the
 * server itself reports, which this module never forwards. */
const MAX_RESPONSE_CHARS = 4_000;

type AmbientState = "idle" | "review_ready" | "sending" | "completed" | "unavailable" | "unauthorized" | "safe_failure" | "cancelled";

let ambientState: AmbientState = "idle";
/** The immutable reviewed snapshot — set only by `reviewTaskDraft()`, read only by
 * `sendReviewedTask()`, cleared by every clear/revoke/newer-review path. Never the live
 * renderer textarea value at send time — exactly this snapshot, unconditionally. */
let reviewedDraft: string | null = null;
let lastCompletedText: string | null = null;
let lastCompletedTruncated = false;
let sendInFlight = false;

/** Monotonic generation counter — identical T-17-style guard to every other Hermes module in
 * this codebase. Bumped by every reset; checked after the one `await fetch(...)` resolves so a
 * send superseded by a clear/revoke/newer review can never commit a now-stale "completed"
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
  reviewedDraft = null;
  lastCompletedText = null;
  lastCompletedTruncated = false;
  ambientState = "idle";
}

function safeState(state: AmbientState): HermesTaskSubmissionState {
  return {
    state,
    draftLength: state === "review_ready" && reviewedDraft !== null ? reviewedDraft.length : null,
    text: state === "completed" ? lastCompletedText : null,
    truncated: state === "completed" ? lastCompletedTruncated : false,
  };
}

/**
 * The only safe, renderer-facing task-submission state. Self-heals: if authorization or
 * endpoint configuration is no longer in place while this module was tracking anything beyond
 * `idle`, this call resets to `idle` first — a stale reviewed draft or completed answer from a
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
 * The one narrow, schema-validated crossing point for the user's own task text. Validates the
 * request shape and draft bounds independently of anything the renderer already checked, then
 * — after an explicit yield point, mirroring every other Hermes module's own T-17 race guard —
 * commits the immutable snapshot only if nothing has reset state in the meantime. Never echoes
 * the draft back; the renderer already has its own copy on screen.
 */
export async function reviewTaskDraft(request: unknown): Promise<HermesTaskSubmissionState> {
  const precondition = currentPreconditionState();
  if (precondition) {
    if (ambientState !== "idle") resetToIdle();
    return safeState(precondition);
  }
  if (typeof request !== "object" || request === null || Array.isArray(request)) return safeState(ambientState);
  const keys = Object.keys(request as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "draft") return safeState(ambientState);
  const draft = (request as Record<string, unknown>).draft;
  if (typeof draft !== "string" || !validateDraft(draft)) return safeState(ambientState);

  const generationAtStart = generation;
  await Promise.resolve();
  if (generation !== generationAtStart) return safeState(ambientState);

  generation++;
  sendInFlight = false;
  reviewedDraft = draft;
  lastCompletedText = null;
  lastCompletedTruncated = false;
  ambientState = "review_ready";
  return safeState("review_ready");
}

/**
 * The single explicit, user-initiated send action. Re-validates every precondition and the
 * reviewed snapshot immediately before any network use; a duplicate call while one is already
 * in flight is safely reduced to `sending` rather than starting a second request. Sends exactly
 * one non-streaming `POST <origin>/v1/chat/completions` — `messages: [{role:"user", content}]`
 * only, no `model` field (the server's own configured default applies), `stream: false`,
 * `Authorization: Bearer <credential>` (see this file's own header for why the credential is
 * still attached even though the installed Hermes version itself does not enforce it on this
 * route — the local hermes-auth-proxy.mjs proxy does).
 */
export async function sendReviewedTask(): Promise<HermesTaskSubmissionState> {
  const precondition = currentPreconditionState();
  if (precondition) {
    if (ambientState !== "idle") resetToIdle();
    return safeState(precondition);
  }
  if (reviewedDraft === null) return safeState(ambientState === "idle" ? "idle" : ambientState);
  if (sendInFlight) return safeState("sending");

  const endpoint = getConfiguredEndpoint() ?? resolveTrustedEndpoint();
  if (endpoint.kind !== "trusted") return safeState("unavailable");
  const credential = getCurrentCredential();
  if (credential === null) return safeState("unauthorized");

  sendInFlight = true;
  const generationAtStart = ++generation;
  ambientState = "sending";
  const draftAtSend = reviewedDraft;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    const response = await fetch(`${endpoint.url.origin}/v1/chat/completions`, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: draftAtSend }],
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    sendInFlight = false;
    if (generation !== generationAtStart) return getTaskSubmissionState();
    // Defensive re-check, not merely the generation counter above: authorization/endpoint may
    // have been revoked directly (e.g. via electron/main.ts's own clearHermesAuthorization()
    // composition) without ever calling back into this module's own clear/generation-bumping
    // path. A completed answer must never be committed or returned once either precondition is
    // no longer met, even if this module's own generation counter never changed.
    const preconditionAfterFetch = currentPreconditionState();
    if (preconditionAfterFetch) {
      resetToIdle();
      return safeState(preconditionAfterFetch);
    }
    if (!response.ok) {
      ambientState = "safe_failure";
      return safeState("safe_failure");
    }
    const body: unknown = await response.json();
    const text = extractSafeResponseText(body);
    if (text === null) {
      ambientState = "safe_failure";
      return safeState("safe_failure");
    }
    const truncated = text.length > MAX_RESPONSE_CHARS;
    lastCompletedText = truncated ? text.slice(0, MAX_RESPONSE_CHARS) : text;
    lastCompletedTruncated = truncated;
    ambientState = "completed";
    return safeState("completed");
  } catch {
    clearTimeout(timer);
    sendInFlight = false;
    if (generation !== generationAtStart) return getTaskSubmissionState();
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
  return content;
}

/**
 * Explicit, immediate, idempotent cleanup — called from electron/main.ts on clear-
 * authorization, clear-endpoint-configuration, and app before-quit, mirroring every other
 * Hermes module's own established composition pattern. Also the renderer's own explicit
 * "draft changed since review" invalidation path. Safe to call whether or not anything is
 * currently reviewed, sending, or completed.
 */
export function clearTaskSubmission(): HermesTaskSubmissionState {
  resetToIdle();
  const precondition = currentPreconditionState();
  if (precondition) return safeState(precondition);
  return safeState("idle");
}
