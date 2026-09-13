import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/sessions";
import { getProject } from "@/lib/projects";
import { recordAudit } from "@/lib/db";
import {
  MAX_ITEMS,
  MAX_ITEM_CHARS,
  MAX_AGGREGATE_CHARS,
  MAX_AGGREGATE_TOKENS,
  listContextSelections,
  insertContextSelection,
  removeContextSelection,
  clearContextSelections,
  aggregateStats,
  serializeFileRange,
  serializeHunkRef,
  type ContextKind,
} from "@/lib/contextSelections";
import { extractFileSnippet, extractGitHunk } from "@/lib/contextContent";
import { previewItem } from "@/lib/contextPayload";

// The mandatory "will NOT send" list for the Context Inspector — a fixed, always-shown set
// naming every category of data this app could theoretically hold that context selection
// must never include, regardless of what is actually selected right now.
const WILL_NOT_SEND = [
  "raw full chat history",
  "unselected files",
  "the full repository",
  ".env* / secret / credential files",
  ".git internal data",
  "node_modules / build / binary content",
  "global memory",
  "USER.md / MEMORY.md",
  "PROJECT_STATE",
  "provider / Bridge / Hermes / deliberation tokens",
  "terminal output",
];

export async function GET(req: NextRequest) {
  const sessionId = new URL(req.url).searchParams.get("session_id");
  if (!sessionId) return NextResponse.json({ error: "session_id required" }, { status: 400 });
  const session = getSession(sessionId);
  if (!session) return NextResponse.json({ error: "unknown session_id" }, { status: 404 });

  const rows = listContextSelections(sessionId);
  const items = rows.map((row) => {
    const preview = previewItem(row);
    return {
      id: row.id,
      kind: row.kind,
      path: row.pathOrRef,
      rangeOrHunk: row.rangeOrHunk,
      charCount: row.charCount,
      tokenEstimate: row.tokenEstimate,
      attached: row.attached,
      createdAt: row.createdAt,
      stale: preview.stale,
      preview: preview.preview,
      unavailableReason: preview.reason,
    };
  });

  const stats = aggregateStats(sessionId);
  return NextResponse.json({
    items,
    aggregate: stats,
    limits: { maxItems: MAX_ITEMS, maxItemChars: MAX_ITEM_CHARS, maxAggregateChars: MAX_AGGREGATE_CHARS, maxAggregateTokens: MAX_AGGREGATE_TOKENS },
    willNotSend: WILL_NOT_SEND,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const sessionId = body?.session_id;
  const projectId = body?.project_id;
  const kind: ContextKind | undefined = body?.kind;
  const requestedPath = body?.path;

  if (!sessionId || typeof sessionId !== "string") return NextResponse.json({ error: "session_id required" }, { status: 400 });
  if (!projectId || typeof projectId !== "string") return NextResponse.json({ error: "project_id required" }, { status: 400 });
  if (kind !== "file_snippet" && kind !== "git_diff_hunk") return NextResponse.json({ error: "invalid_kind" }, { status: 400 });
  if (!requestedPath || typeof requestedPath !== "string") return NextResponse.json({ error: "path required" }, { status: 400 });

  const session = getSession(sessionId);
  if (!session) return NextResponse.json({ error: "unknown session_id" }, { status: 404 });
  const project = getProject(projectId);
  if (!project) return NextResponse.json({ error: "unknown project_id" }, { status: 404 });

  // The active-conversation-plus-active-project scoping rule: a context item may only ever
  // be added under the project its own conversation actually belongs to.
  if (session.projectId !== projectId) {
    recordAudit(projectId, "context_add", requestedPath, "denied:cross_project");
    return NextResponse.json({ error: "cross_project_rejected" }, { status: 403 });
  }

  let extraction;
  let rangeOrHunk: string;

  if (kind === "file_snippet") {
    const startLine = Number(body?.start_line);
    const endLine = Number(body?.end_line);
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
      return NextResponse.json({ error: "invalid_or_stale_range" }, { status: 400 });
    }
    extraction = extractFileSnippet(projectId, requestedPath, startLine, endLine);
    rangeOrHunk = serializeFileRange({ startLine, endLine });
  } else {
    const hunkHeader = body?.hunk_header;
    const hunkIndex = Number(body?.hunk_index);
    if (typeof hunkHeader !== "string" || !hunkHeader || !Number.isInteger(hunkIndex) || hunkIndex < 0) {
      return NextResponse.json({ error: "invalid_hunk_reference" }, { status: 400 });
    }
    extraction = extractGitHunk(projectId, requestedPath, hunkHeader, hunkIndex);
    rangeOrHunk = serializeHunkRef({ header: hunkHeader, index: hunkIndex });
  }

  if (!extraction.ok) {
    recordAudit(projectId, "context_add", requestedPath, `denied:${extraction.reason}`);
    return NextResponse.json({ error: extraction.reason }, { status: 422 });
  }

  const inserted = insertContextSelection({
    sessionId,
    projectId,
    kind,
    pathOrRef: extraction.relativePath,
    rangeOrHunk,
    content: extraction.content,
  });

  if (!inserted.ok) {
    recordAudit(projectId, "context_add", requestedPath, `denied:${inserted.reason}`);
    return NextResponse.json({ error: inserted.reason }, { status: 422 });
  }

  recordAudit(projectId, "context_add", extraction.relativePath, "ok");
  return NextResponse.json({
    item: {
      id: inserted.item.id,
      kind: inserted.item.kind,
      path: inserted.item.pathOrRef,
      rangeOrHunk: inserted.item.rangeOrHunk,
      charCount: inserted.item.charCount,
      tokenEstimate: inserted.item.tokenEstimate,
      attached: false,
      createdAt: inserted.item.createdAt,
    },
  });
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get("session_id");
  const id = searchParams.get("id");
  const clearAll = searchParams.get("all") === "1";

  if (!sessionId) return NextResponse.json({ error: "session_id required" }, { status: 400 });
  const session = getSession(sessionId);
  if (!session) return NextResponse.json({ error: "unknown session_id" }, { status: 404 });

  if (clearAll) {
    const removed = clearContextSelections(sessionId);
    recordAudit(session.projectId, "context_clear", sessionId, "ok");
    return NextResponse.json({ removed });
  }

  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const removed = removeContextSelection(sessionId, id);
  recordAudit(session.projectId, "context_remove", id, removed ? "ok" : "not_found");
  if (!removed) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ removed: 1 });
}
