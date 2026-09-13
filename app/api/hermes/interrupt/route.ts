import { NextRequest, NextResponse } from "next/server";
import { getHermesClient } from "@/lib/hermesClient";
import { getSession, setSessionStatus } from "@/lib/sessions";
import { recordAudit } from "@/lib/db";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const localSessionId = body?.session_id;
  if (!localSessionId) return NextResponse.json({ error: "session_id required" }, { status: 400 });
  const session = getSession(localSessionId);
  if (!session) return NextResponse.json({ error: "unknown session_id" }, { status: 404 });

  try {
    await getHermesClient().call("session.interrupt", { session_id: session.hermesSessionId });
    setSessionStatus(localSessionId, "interrupted");
    recordAudit(session.projectId, "hermes_session_interrupt", session.hermesSessionId, "ok");
    return NextResponse.json({ status: "ok" });
  } catch (err: any) {
    recordAudit(session.projectId, "hermes_session_interrupt", session.hermesSessionId, "error");
    return NextResponse.json({ error: err?.message || "session.interrupt failed" }, { status: 502 });
  }
}
