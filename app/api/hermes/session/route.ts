import { NextRequest, NextResponse } from "next/server";
import { getHermesClient } from "@/lib/hermesClient";
import { getProject } from "@/lib/projects";
import { getDb, newId, recordAudit } from "@/lib/db";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const projectId = body?.project_id;
  if (!projectId || typeof projectId !== "string") {
    return NextResponse.json({ error: "project_id required" }, { status: 400 });
  }
  const project = getProject(projectId);
  if (!project) return NextResponse.json({ error: "unknown project_id" }, { status: 404 });

  try {
    const client = getHermesClient();
    const created = (await client.call("session.create", { cwd: project.canonicalRoot })) as { session_id?: string };
    if (!created?.session_id) throw new Error("session.create returned no session_id");
    await client.call("session.activate", { session_id: created.session_id });

    const db = getDb();
    const localId = newId();
    const now = Date.now();
    db.prepare(
      `INSERT INTO sessions (id, project_id, hermes_session_id, created_at, title, status, updated_at, last_activity_at, message_count)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 0)`
    ).run(localId, projectId, created.session_id, now, typeof body?.title === "string" ? body.title.slice(0, 200) : null, now, now);

    recordAudit(projectId, "hermes_session_create", created.session_id, "ok");
    return NextResponse.json({ session_id: localId, hermes_session_id: created.session_id });
  } catch (err: any) {
    recordAudit(projectId, "hermes_session_create", "", "error");
    return NextResponse.json({ error: err?.message || "hermes session.create failed" }, { status: 502 });
  }
}
