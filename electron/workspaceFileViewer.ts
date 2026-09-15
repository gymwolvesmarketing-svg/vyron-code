/**
 * Bounded, read-only text-file preview for the granted workspace —
 * VYRON_CODE_V02_MILESTONE_A_RUNTIME_STABILITY_AND_READONLY_WORKSPACE_AUTHORIZATION.
 *
 * A file can be read only via a safe relative path re-validated through
 * `workspaceAccess.ts`'s `resolveWorkspacePath` on every call — the same canonical-root
 * containment/denied-segment/symlink-escape protection every other workspace service uses.
 * Binary, oversized, unreadable, or non-file paths receive a safe status, never a raw error
 * or a crash. No write/save/edit capability exists anywhere in this module or the IPC surface
 * it backs.
 */
import fs from "node:fs";
import { resolveWorkspacePath } from "./workspaceAccess";
import type { ReadTextFileResult } from "./shared-ipc-contract";

// A file larger than this is refused outright — this is a bounded preview, not a general
// file server. Smaller than the web app's own 5MB cap (VYRON_CODE_V01) since this desktop
// scaffold has no pagination/streaming UI.
const MAX_READ_BYTES = 1 * 1024 * 1024;
// Once decoded, only this many characters are ever returned — a large file with very long
// lines (e.g. a minified bundle) could otherwise still produce an enormous single "line".
const MAX_CONTENT_CHARS = 200_000;

function isLikelyBinary(buffer: Buffer): boolean {
  const sampleLen = Math.min(buffer.length, 8000);
  for (let i = 0; i < sampleLen; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function emptyResult(state: ReadTextFileResult["state"], relativePath: string | null = null): ReadTextFileResult {
  return { state, relativePath, content: null, lineCount: null, truncated: false };
}

export function readTextFile(requestedRelativePath: string): ReadTextFileResult {
  const access = resolveWorkspacePath(requestedRelativePath);
  if (!access.ok) {
    return emptyResult(access.reason === "no_workspace" ? "no_workspace" : "invalid_path");
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(access.absolutePath);
  } catch {
    return emptyResult("invalid_path", access.relativePath);
  }
  if (!stat.isFile()) {
    return emptyResult("not_a_file", access.relativePath);
  }
  if (stat.size > MAX_READ_BYTES) {
    return emptyResult("too_large", access.relativePath);
  }

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(access.absolutePath);
  } catch {
    return emptyResult("unreadable", access.relativePath);
  }
  if (isLikelyBinary(buffer)) {
    return emptyResult("binary", access.relativePath);
  }

  const fullText = buffer.toString("utf8");
  const truncated = fullText.length > MAX_CONTENT_CHARS;
  const content = truncated ? fullText.slice(0, MAX_CONTENT_CHARS) : fullText;
  const lineCount = content.split("\n").length;

  return { state: "ok", relativePath: access.relativePath, content, lineCount, truncated };
}
