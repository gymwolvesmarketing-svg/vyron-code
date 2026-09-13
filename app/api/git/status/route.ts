import { NextRequest, NextResponse } from "next/server";
import { getProject } from "@/lib/projects";
import { resolveCanonicalRoot } from "@/lib/canonicalPath";
import { gitStatus, parseStatusHeader, parseStatusFiles } from "@/lib/git";
import { recordAudit } from "@/lib/db";

const MAX_STATUS_OUTPUT_CHARS = 100_000;

export async function GET(req: NextRequest) {
  const projectId = new URL(req.url).searchParams.get("project_id");
  if (!projectId) return NextResponse.json({ error: "project_id required" }, { status: 400 });
  const project = getProject(projectId);
  if (!project) return NextResponse.json({ error: "unknown project_id" }, { status: 404 });
  const root = resolveCanonicalRoot(project.canonicalRoot);
  if (!root) return NextResponse.json({ error: "project root is no longer resolvable" }, { status: 409 });

  const result = gitStatus(root);
  if (!result.ok) {
    recordAudit(projectId, "git_status", ".", result.reason === "not_a_repo" ? "not_a_repo" : "error");
    // A non-git folder is a graceful, expected empty state — not an error — per the Git UI's
    // "no repo" requirement; only a genuinely unexpected git failure gets a 500, and even
    // then the raw stderr (which can contain an absolute path) never reaches the client.
    if (result.reason === "not_a_repo") return NextResponse.json({ isRepo: false });
    return NextResponse.json({ error: "git_command_failed" }, { status: 500 });
  }

  recordAudit(projectId, "git_status", ".", "ok");
  const truncated = result.output.length > MAX_STATUS_OUTPUT_CHARS;
  const output = truncated ? result.output.slice(0, MAX_STATUS_OUTPUT_CHARS) : result.output;
  return NextResponse.json({
    isRepo: true,
    output,
    truncated,
    header: parseStatusHeader(result.output),
    files: parseStatusFiles(output),
  });
}
