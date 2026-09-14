import { describe, it, expect } from "vitest";
import {
  parsePendingRequestEvent,
  buildRespondPayload,
  canSubmitPendingResponse,
  resolvePendingRequestOutcome,
  nowMs,
  DEFAULT_APPROVAL_CHOICES,
} from "../lib/pendingRequest";

describe("parsePendingRequestEvent — approval", () => {
  it("recognizes an approval.pending event with a request_id", () => {
    const result = parsePendingRequestEvent({ type: "approval.pending", payload: { request_id: "r1", command: "rm -rf /tmp/x" } });
    expect(result).toEqual({ requestId: "r1", kind: "approval", message: "rm -rf /tmp/x", choices: DEFAULT_APPROVAL_CHOICES });
  });

  it("recognizes every documented approval alias type", () => {
    for (const type of ["approval.pending", "approval.requested", "approval_requested", "approval.request"]) {
      expect(parsePendingRequestEvent({ type, payload: { request_id: "r1" } })?.kind).toBe("approval");
    }
  });

  it("uses payload-provided choices when present", () => {
    const result = parsePendingRequestEvent({ type: "approval.pending", payload: { request_id: "r1", choices: ["allow_once", "always_allow", "deny"] } });
    expect(result?.choices).toEqual(["allow_once", "always_allow", "deny"]);
  });

  it("falls back to a default safe message when no known message field is present", () => {
    const result = parsePendingRequestEvent({ type: "approval.pending", payload: { request_id: "r1" } });
    expect(result?.message).toBe("Hermes is requesting approval before continuing.");
  });

  it("truncates an overlong message rather than rendering it whole", () => {
    const long = "x".repeat(5000);
    const result = parsePendingRequestEvent({ type: "approval.pending", payload: { request_id: "r1", message: long } });
    expect(result?.message.length).toBe(4001); // 4000 chars + the truncation marker
    expect(result?.message.endsWith("…")).toBe(true);
  });
});

describe("parsePendingRequestEvent — clarify", () => {
  it("recognizes every documented clarify alias type", () => {
    for (const type of ["clarify.pending", "clarify.requested", "clarify_requested", "clarify.request"]) {
      expect(parsePendingRequestEvent({ type, payload: { request_id: "r2", question: "Which file?" } })?.kind).toBe("clarify");
    }
  });

  it("extracts a question-shaped message field", () => {
    const result = parsePendingRequestEvent({ type: "clarify.pending", payload: { request_id: "r2", question: "Which file?" } });
    expect(result?.message).toBe("Which file?");
  });
});

describe("parsePendingRequestEvent — fails closed / no regression", () => {
  it("returns null when request_id is missing, even for a recognized type", () => {
    expect(parsePendingRequestEvent({ type: "approval.pending", payload: { command: "ls" } })).toBeNull();
  });

  it("returns null when request_id is an empty string", () => {
    expect(parsePendingRequestEvent({ type: "approval.pending", payload: { request_id: "" } })).toBeNull();
  });

  it("returns null for every event type this client already handles (proves no regression)", () => {
    for (const type of ["message.delta", "message.complete", "turn.error", "tool.started", "tool.completed", "session.info", "thinking.delta"]) {
      expect(parsePendingRequestEvent({ type, payload: { request_id: "r1" } })).toBeNull();
    }
  });

  it("returns null for a completely unknown event type", () => {
    expect(parsePendingRequestEvent({ type: "some.unknown.event", payload: { request_id: "r1" } })).toBeNull();
  });
});

describe("buildRespondPayload", () => {
  it("shapes an approval response with the chosen choice", () => {
    const req = { requestId: "r1", kind: "approval" as const, message: "m", choices: DEFAULT_APPROVAL_CHOICES };
    expect(buildRespondPayload("sess1", req, { choice: "allow" })).toEqual({
      session_id: "sess1",
      kind: "approval",
      request_id: "r1",
      choice: "allow",
    });
  });

  it("shapes a clarify response as a trimmed single-answer array", () => {
    const req = { requestId: "r2", kind: "clarify" as const, message: "m", choices: [] };
    expect(buildRespondPayload("sess1", req, { answerText: "  the auth file  " })).toEqual({
      session_id: "sess1",
      kind: "clarify",
      request_id: "r2",
      answers: ["the auth file"],
    });
  });
});

describe("canSubmitPendingResponse — double-submit guard", () => {
  it("allows submission when nothing is in flight", () => {
    expect(canSubmitPendingResponse("r1", null)).toBe(true);
  });

  it("blocks a second submission for the same pending request while one is in flight", () => {
    expect(canSubmitPendingResponse("r1", "r1")).toBe(false);
  });

  it("blocks when there is no pending request at all", () => {
    expect(canSubmitPendingResponse(null, null)).toBe(false);
  });
});

describe("nowMs", () => {
  it("returns a real, current-ish millisecond timestamp", () => {
    const before = Date.now();
    const value = nowMs();
    const after = Date.now();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });
});

describe("resolvePendingRequestOutcome", () => {
  it("produces a kind-specific resolved message on success", () => {
    expect(resolvePendingRequestOutcome("approval", { ok: true }).text).toBe("Approval response sent.");
    expect(resolvePendingRequestOutcome("clarify", { ok: true }).text).toBe("Clarification sent.");
  });

  it("produces a safe, visible error message on failure without swallowing the reason", () => {
    const result = resolvePendingRequestOutcome("approval", { ok: false, error: "respond failed" });
    expect(result.outcome).toBe("error");
    expect(result.text).toBe("Response failed: respond failed");
  });
});
