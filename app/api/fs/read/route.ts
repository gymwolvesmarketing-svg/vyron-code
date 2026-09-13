import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { guardProjectPath } from "@/lib/fsGuard";

// Files larger than this are refused rather than streamed whole into a JSON response —
// v0.1 is a viewer, not a general file server.
const MAX_READ_BYTES = 5 * 1024 * 1024;

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".exe", ".dll",
  ".so", ".dylib", ".woff", ".woff2", ".ttf", ".mp4", ".mp3", ".wav", ".sqlite", ".db",
]);

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("project_id");
  const requestedPath = searchParams.get("path");
  if (!requestedPath) return NextResponse.json({ error: "path required" }, { status: 400 });

  const guard = guardProjectPath(projectId, requestedPath, "fs_read");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const stat = fs.statSync(guard.absolutePath);
  if (!stat.isFile()) return NextResponse.json({ error: "not_a_file" }, { status: 400 });
  if (stat.size > MAX_READ_BYTES) return NextResponse.json({ error: "file_too_large" }, { status: 413 });

  // path.extname() correctly isolates the basename's own extension (or "" when there is
  // none) — a manual lastIndexOf(".") on the full path misfires on extensionless files and
  // on any directory segment that itself contains a dot (found in the foundation audit).
  const ext = path.extname(guard.absolutePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) {
    const buffer = fs.readFileSync(guard.absolutePath);
    return NextResponse.json({ path: guard.relativePath, content: buffer.toString("base64"), encoding: "base64" });
  }

  const content = fs.readFileSync(guard.absolutePath, "utf8");
  return NextResponse.json({ path: guard.relativePath, content, encoding: "utf8" });
}
