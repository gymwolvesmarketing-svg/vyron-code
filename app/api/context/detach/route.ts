import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/sessions";
import { recordAudit } from "@/lib/db";
import { detachAll } from "@/lib/contextSelections";

// Un-attaches every context item for this session — the selections themselves (and their
// metadata) are left in place for possible re-attach; only the "goes into the next prompt"
// flag is cleared. Deleting the selections entirely is a separate action (DELETE /api/context).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const sessionId = body?.session_id;
  if (!sessionId || typeof sessionId !== "string") return NextResponse.json({ error: "session_id required" }, { status: 400 });

  const session = getSession(sessionId);
  if (!session) return NextResponse.json({ error: "unknown session_id" }, { status: 404 });

  detachAll(sessionId);
  recordAudit(session.projectId, "context_detach", sessionId, "ok");
  return NextResponse.json({ detached: true });
}
