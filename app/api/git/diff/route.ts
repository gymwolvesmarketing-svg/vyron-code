import { NextRequest, NextResponse } from "next/server";
import { gitDiff } from "@/lib/git";
import { guardProjectPath } from "@/lib/fsGuard";
import { getProject } from "@/lib/projects";
import { resolveCanonicalRoot } from "@/lib/canonicalPath";
import { recordAudit } from "@/lib/db";
import { parseDiffHunks } from "@/lib/gitHunks";

const MAX_DIFF_OUTPUT_CHARS = 200_000;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("project_id");
  const requestedPath = searchParams.get("path");

  if (!projectId) return NextResponse.json({ error: "project_id required" }, { status: 400 });

  let root: string;
  let relativePath: string | undefined;

  if (requestedPath) {
    // A path-scoped diff must pass the same canonical-path guard as any other fs access.
    const guard = guardProjectPath(projectId, requestedPath, "git_diff");
    if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
    root = guard.canonicalRoot;
    relativePath = guard.relativePath;
  } else {
    const project = getProject(projectId);
    if (!project) return NextResponse.json({ error: "unknown project_id" }, { status: 404 });
    const resolved = resolveCanonicalRoot(project.canonicalRoot);
    if (!resolved) return NextResponse.json({ error: "project root is no longer resolvable" }, { status: 409 });
    root = resolved;
  }

  const result = gitDiff(root, relativePath);
  if (!result.ok) {
    recordAudit(projectId, "git_diff", relativePath || ".", result.reason === "not_a_repo" ? "not_a_repo" : "error");
    if (result.reason === "not_a_repo") return NextResponse.json({ isRepo: false, diff: "", hunks: [] });
    return NextResponse.json({ error: "git_command_failed" }, { status: 500 });
  }
  recordAudit(projectId, "git_diff", relativePath || ".", "ok");

  const truncated = result.output.length > MAX_DIFF_OUTPUT_CHARS;
  const diff = truncated ? result.output.slice(0, MAX_DIFF_OUTPUT_CHARS) : result.output;
  // Hunks are only meaningful for a single, path-scoped diff — a whole-repo diff can mix
  // multiple files' hunks together, which the Context Selector must never conflate with one
  // path's own hunk numbering, so hunk parsing (and therefore "add to context") is only
  // offered for a path-scoped diff.
  const hunks = relativePath && !truncated ? parseDiffHunks(diff).map((h) => ({ index: h.index, header: h.header, body: h.body })) : [];
  return NextResponse.json({ isRepo: true, diff, truncated, hunks });
}
