import { NextRequest, NextResponse } from "next/server";
import { getProject } from "@/lib/projects";
import { resolveCanonicalRoot } from "@/lib/canonicalPath";
import { searchProject } from "@/lib/search";
import { recordAudit } from "@/lib/db";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("project_id");
  const query = searchParams.get("q") || "";
  if (!projectId) return NextResponse.json({ error: "project_id required" }, { status: 400 });

  const project = getProject(projectId);
  if (!project) return NextResponse.json({ error: "unknown project_id" }, { status: 404 });

  const freshRoot = resolveCanonicalRoot(project.canonicalRoot);
  if (!freshRoot || freshRoot !== project.canonicalRoot) {
    return NextResponse.json({ error: "project root is no longer resolvable; re-add the project" }, { status: 409 });
  }

  const matches = searchProject(freshRoot, query);
  recordAudit(projectId, "search", query, "ok");
  return NextResponse.json({ matches });
}
