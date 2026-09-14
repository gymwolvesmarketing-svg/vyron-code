/**
 * Pure, testable logic for rendering and answering a mid-turn Hermes approval/clarify
 * request in the Chat/Cowork panel (VYRON_CODE_V01_AC9_APPROVAL_CLARIFY_UI_COMPLETION_AUTHORIZATION).
 *
 * The exact push-frame event *type* string Hermes uses to signal a pending approval/clarify
 * request has not been observed live in this engagement (no Hermes session/prompt call is
 * authorized for this task). The candidate type names below are drawn from the only existing
 * first-hand evidence available — the tui_gateway method inventory in VYRON_CODE_V0_DISCOVERY.md
 * (`approval.pending`, `approval.received`, `clarify.respond`) — plus the `<domain>.<verb>`
 * naming convention already confirmed for every other real event type this client handles
 * (`message.delta`, `tool.started`, etc.). This is a documented assumption, not a verified
 * wire-level contract; see the completion report's "Remaining gaps" for the follow-up this
 * implies. Detection is deliberately permissive on the *type* name (a short alias list) but
 * strict on the *payload* (a request_id must be present) so an unrecognized/malformed event
 * never produces a phantom, unanswerable prompt.
 */

export type PendingRequestKind = "approval" | "clarify";

export type PendingRequest = {
  requestId: string;
  kind: PendingRequestKind;
  message: string;
  choices: string[];
};

export type HermesEventLike = { type: string; payload: Record<string, unknown> };

const APPROVAL_EVENT_TYPES = new Set(["approval.pending", "approval.requested", "approval_requested", "approval.request"]);
const CLARIFY_EVENT_TYPES = new Set(["clarify.pending", "clarify.requested", "clarify_requested", "clarify.request"]);

export const DEFAULT_APPROVAL_CHOICES = ["allow", "deny"];
const DEFAULT_APPROVAL_MESSAGE = "Hermes is requesting approval before continuing.";
const DEFAULT_CLARIFY_MESSAGE = "Hermes needs more information before continuing.";
const MAX_MESSAGE_CHARS = 4000;

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function truncate(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}

// Only ever reads these specific, expected fields off the event payload — never the whole
// payload object — so an unexpected extra field on the real event can't leak into the UI.
function extractMessage(payload: Record<string, unknown>, fallback: string): string {
  const text = safeString(payload.message) ?? safeString(payload.question) ?? safeString(payload.prompt) ?? safeString(payload.command) ?? safeString(payload.reason);
  return truncate(text ?? fallback);
}

function extractChoices(payload: Record<string, unknown>): string[] {
  const raw = payload.choices ?? payload.options;
  if (Array.isArray(raw) && raw.every((v) => typeof v === "string") && raw.length > 0) return raw as string[];
  return DEFAULT_APPROVAL_CHOICES;
}

/**
 * Returns null (never renders a prompt) unless the event's type matches a known
 * approval/clarify alias AND the payload carries a non-empty request_id — the one field
 * required to answer it at all. Every other event type (including every type this client
 * already handles — message.delta, message.complete, turn.error, tool.started, tool.completed,
 * and so on) returns null unchanged, so existing event routing cannot regress.
 */
export function parsePendingRequestEvent(evt: HermesEventLike): PendingRequest | null {
  const payload = evt.payload || {};
  const requestId = safeString(payload.request_id);
  if (!requestId) return null;

  if (APPROVAL_EVENT_TYPES.has(evt.type)) {
    return {
      requestId,
      kind: "approval",
      message: extractMessage(payload, DEFAULT_APPROVAL_MESSAGE),
      choices: extractChoices(payload),
    };
  }
  if (CLARIFY_EVENT_TYPES.has(evt.type)) {
    return {
      requestId,
      kind: "clarify",
      message: extractMessage(payload, DEFAULT_CLARIFY_MESSAGE),
      choices: [],
    };
  }
  return null;
}

/** Exact body the existing, unmodified POST /api/hermes/respond route already expects. */
export function buildRespondPayload(
  sessionId: string,
  req: PendingRequest,
  response: { choice?: string; answerText?: string }
): { session_id: string; kind: PendingRequestKind; request_id: string; choice?: string; answers?: string[] } {
  if (req.kind === "approval") {
    return { session_id: sessionId, kind: "approval", request_id: req.requestId, choice: response.choice };
  }
  return { session_id: sessionId, kind: "clarify", request_id: req.requestId, answers: [(response.answerText ?? "").trim()] };
}

/** Double-submit guard: only the request currently pending may be answered, and only once. */
export function canSubmitPendingResponse(pendingRequestId: string | null, inFlightRequestId: string | null): boolean {
  return pendingRequestId !== null && inFlightRequestId !== pendingRequestId;
}

// Isolated behind this module boundary so ChatPanel's own render-adjacent scope never
// contains a direct Date.now() call for this purpose (this codebase's existing convention is
// to keep such logic in lib/, not inline in a component).
export function nowMs(): number {
  return Date.now();
}

export type PendingRequestOutcome = { outcome: "resolved" | "error"; text: string };

/** Pure success/failure → user-visible-text mapping, so ChatPanel only applies state changes. */
export function resolvePendingRequestOutcome(kind: PendingRequestKind, result: { ok: true } | { ok: false; error: string }): PendingRequestOutcome {
  if (result.ok) {
    return { outcome: "resolved", text: kind === "approval" ? "Approval response sent." : "Clarification sent." };
  }
  return { outcome: "error", text: `Response failed: ${result.error || "unknown error"}` };
}
