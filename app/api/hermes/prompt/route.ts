import { NextRequest, NextResponse } from "next/server";
import { getHermesClient } from "@/lib/hermesClient";
import { getSession, touchSessionActivity, setSessionStatus, renameSession } from "@/lib/sessions";
import { getProject } from "@/lib/projects";
import { recordAudit } from "@/lib/db";
import { listAttachedContextSelections } from "@/lib/contextSelections";
import { revalidateItems, assembleContextPrompt } from "@/lib/contextPayload";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const { session_id: localSessionId, text } = body ?? {};
  if (!localSessionId || typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "session_id and non-empty text required" }, { status: 400 });
  }
  const session = getSession(localSessionId);
  if (!session) return NextResponse.json({ error: "unknown session_id" }, { status: 404 });

  // Context-aware ONLY when this session currently has attached items — with none attached,
  // `promptText` stays exactly `text` and every line below behaves byte-for-byte like the
  // pre-context-feature version of this route (VYRON_CODE_V01_CORE_READONLY_UI's own
  // implementation), preserving existing chat behavior unconditionally.
  let promptText = text;
  const attachedRows = listAttachedContextSelections(localSessionId);
  if (attachedRows.length > 0) {
    // Re-validated fresh immediately before every send — an item's `attached` flag is never
    // itself treated as proof its content is still valid. Any staleness fails the ENTIRE
    // submission closed: no prompt reaches Hermes, and the caller is told which item(s)
    // changed so the user can remove/refresh them before retrying (no silent partial resend).
    const revalidation = revalidateItems(attachedRows);
    if (!revalidation.ok) {
      recordAudit(session.projectId, "hermes_prompt_submit", session.hermesSessionId, "denied:stale_context");
      return NextResponse.json({ error: "stale_context", staleItems: revalidation.failures }, { status: 409 });
    }
    try {
      const project = getProject(session.projectId);
      promptText = assembleContextPrompt(revalidation.items, project?.displayName ?? "project", text);
    } catch {
      // Fail closed on any assembly error — never fall back to sending `text` alone while
      // silently dropping the context the user explicitly attached.
      recordAudit(session.projectId, "hermes_prompt_submit", session.hermesSessionId, "denied:assembly_error");
      return NextResponse.json({ error: "context_assembly_failed" }, { status: 500 });
    }
  }

  try {
    const client = getHermesClient();
    // Fire-and-forget, same shape as Vyron Pro's own prompt.submit call — the real response
    // arrives as a stream of push-frame events (tool.started/tool.completed/etc.), consumed
    // via GET /api/hermes/events, not as this call's own RPC result. `promptText` (transient,
    // never persisted anywhere — not to SQLite, not to any log) is used here only.
    client.call("prompt.submit", { session_id: session.hermesSessionId, text: promptText }).catch(() => {});
    touchSessionActivity(localSessionId);
    setSessionStatus(localSessionId, "active");
    // First-message title derivation: short, local-only, never re-derived from later prompts —
    // a session with no title yet gets one from the first ~60 chars of this prompt. Always
    // derived from the user's own `text`, never from the assembled context+prompt payload.
    if (!session.title) renameSession(localSessionId, text.trim().slice(0, 60));
    recordAudit(session.projectId, "hermes_prompt_submit", session.hermesSessionId, "ok");
    return NextResponse.json({ status: "submitted" });
  } catch (err: any) {
    recordAudit(session.projectId, "hermes_prompt_submit", session.hermesSessionId, "error");
    return NextResponse.json({ error: err?.message || "prompt.submit failed" }, { status: 502 });
  }
}
