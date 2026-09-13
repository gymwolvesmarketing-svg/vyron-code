import { NextRequest, NextResponse } from "next/server";
import { listSessionsForProject } from "@/lib/sessions";
import { getProject } from "@/lib/projects";

// Read-only conversation list, scoped to one project by project_id — never enumerates
// Hermes Agent's own global session history, and never exposes another project's rows
// (server-side project_id filter, not a client-supplied one the caller could widen).
export async function GET(req: NextRequest) {
  const projectId = new URL(req.url).searchParams.get("project_id");
  if (!projectId) return NextResponse.json({ error: "project_id required" }, { status: 400 });
  if (!getProject(projectId)) return NextResponse.json({ error: "unknown project_id" }, { status: 404 });

  const sessions = listSessionsForProject(projectId).map((s) => ({
    id: s.id,
    title: s.title,
    status: s.status,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    lastActivityAt: s.lastActivityAt,
    messageCount: s.messageCount,
  }));
  return NextResponse.json({ sessions });
}
