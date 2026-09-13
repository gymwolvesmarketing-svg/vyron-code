import { NextRequest, NextResponse } from "next/server";
import { getHermesClient } from "@/lib/hermesClient";
import { getSession } from "@/lib/sessions";
import { recordAudit } from "@/lib/db";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const { session_id: localSessionId, kind, request_id, choice, answers } = body ?? {};
  if (!localSessionId || (kind !== "approval" && kind !== "clarify") || !request_id) {
    return NextResponse.json({ error: "session_id, kind ('approval'|'clarify'), request_id required" }, { status: 400 });
  }
  const session = getSession(localSessionId);
  if (!session) return NextResponse.json({ error: "unknown session_id" }, { status: 404 });

  try {
    const client = getHermesClient();
    if (kind === "approval") {
      await client.call("approval.respond", { request_id, choice });
    } else {
      await client.call("clarify.respond", { request_id, answers });
    }
    recordAudit(session.projectId, `hermes_${kind}_respond`, request_id, "ok");
    return NextResponse.json({ status: "ok" });
  } catch (err: any) {
    recordAudit(session.projectId, `hermes_${kind}_respond`, request_id, "error");
    return NextResponse.json({ error: err?.message || "respond failed" }, { status: 502 });
  }
}
