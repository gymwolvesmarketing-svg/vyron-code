import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { guardProjectPath } from "@/lib/fsGuard";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("project_id");
  const requestedPath = searchParams.get("path") || ".";

  const guard = guardProjectPath(projectId, requestedPath, "fs_list");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const stat = fs.statSync(guard.absolutePath);
  if (!stat.isDirectory()) {
    return NextResponse.json({ error: "not_a_directory" }, { status: 400 });
  }

  const entries = fs
    .readdirSync(guard.absolutePath, { withFileTypes: true })
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? ("dir" as const) : ("file" as const),
    }))
    // Re-run every child name through the same guard so a denied name (e.g. .env, .git,
    // node_modules) never appears in a listing even though the parent dir itself passed.
    .filter((entry) => {
      const childRel = guard.relativePath === "." ? entry.name : `${guard.relativePath}/${entry.name}`;
      return guardProjectPath(projectId, childRel, "fs_list_entry", { audit: false }).ok;
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));

  return NextResponse.json({ path: guard.relativePath, entries });
}
