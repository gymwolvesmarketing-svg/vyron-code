import { NextRequest, NextResponse } from "next/server";
import { getProject } from "@/lib/projects";
import { resolveCanonicalRoot } from "@/lib/canonicalPath";
import { gitLog } from "@/lib/git";
import { recordAudit } from "@/lib/db";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("project_id");
  if (!projectId) return NextResponse.json({ error: "project_id required" }, { status: 400 });
  const project = getProject(projectId);
  if (!project) return NextResponse.json({ error: "unknown project_id" }, { status: 404 });
  const root = resolveCanonicalRoot(project.canonicalRoot);
  if (!root) return NextResponse.json({ error: "project root is no longer resolvable" }, { status: 409 });

  // gitLog() itself clamps limit to [1, 200] and skip to >= 0 — an out-of-range or
  // non-numeric value from the client is never trusted directly, only coerced/clamped.
  const limit = Number(searchParams.get("limit")) || 50;
  const skip = Number(searchParams.get("skip")) || 0;

  const result = gitLog(root, limit, skip);
  if (!result.ok) {
    recordAudit(projectId, "git_log", ".", result.reason === "not_a_repo" ? "not_a_repo" : "error");
    if (result.reason === "not_a_repo") return NextResponse.json({ isRepo: false, commits: [] });
    return NextResponse.json({ error: "git_command_failed" }, { status: 500 });
  }
  recordAudit(projectId, "git_log", ".", "ok");

  const commits = result.output
    .split("\x1e")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hash, author, date, subject] = entry.split("\x1f");
      return { hash, author, date, subject };
    });
  // Fetching exactly `limit` commits back is the client's own signal that another page is
  // plausibly available — a genuinely shorter final page (fewer commits than `limit`) tells
  // it there is nothing more to load.
  return NextResponse.json({ isRepo: true, commits, hasMore: commits.length === Math.min(Math.max(1, Math.floor(limit) || 50), 200) });
}
