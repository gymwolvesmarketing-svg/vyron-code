import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/sessions";
import { recordAudit } from "@/lib/db";
import { getContextSelection, setAttached, detachAll, parseFileRange, parseHunkRef } from "@/lib/contextSelections";
import { revalidateItems } from "@/lib/contextPayload";

/**
 * Explicit "Attach selected context" action — distinct from Send. Re-validates every
 * requested item fresh (canonical path, deny-list, size, and content-fingerprint staleness)
 * BEFORE marking anything attached; if even one item fails, NOTHING is attached (fail-closed,
 * no partial/silent narrowing of the set) and the caller is told exactly which item(s)
 * changed so the user can remove or refresh them and try again.
 *
 * Attaching replaces this session's previously-attached set entirely — "Attach" always means
 * "these items, and only these, go into the next prompt(s)", not an additive accumulation.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const sessionId = body?.session_id;
  const ids = body?.ids;
  if (!sessionId || typeof sessionId !== "string") return NextResponse.json({ error: "session_id required" }, { status: 400 });
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string")) {
    return NextResponse.json({ error: "ids (non-empty string array) required" }, { status: 400 });
  }

  const session = getSession(sessionId);
  if (!session) return NextResponse.json({ error: "unknown session_id" }, { status: 404 });

  const rows = ids.map((id) => getContextSelection(sessionId, id));
  const missing = ids.filter((_, i) => !rows[i]);
  if (missing.length > 0) {
    return NextResponse.json({ error: "unknown_item", missingIds: missing }, { status: 404 });
  }

  const revalidation = revalidateItems(rows.filter((r): r is NonNullable<typeof r> => r !== null));
  if (!revalidation.ok) {
    recordAudit(session.projectId, "context_attach", `session:${sessionId} count:${ids.length}`, "denied:stale");
    return NextResponse.json({ error: "stale_context", staleItems: revalidation.failures }, { status: 409 });
  }

  detachAll(sessionId);
  setAttached(sessionId, ids, true);

  const totalChars = revalidation.items.reduce((sum, i) => sum + i.row.charCount, 0);
  const kinds = Array.from(new Set(revalidation.items.map((i) => i.row.kind)));
  recordAudit(session.projectId, "context_attach", `session:${sessionId} count:${ids.length} chars:${totalChars} kinds:${kinds.join("|")}`, "ok");

  const willSend = revalidation.items.map(({ row }) => ({
    id: row.id,
    kind: row.kind,
    path: row.pathOrRef,
    rangeLabel: row.kind === "file_snippet" ? formatFileRangeLabel(row.rangeOrHunk) : formatHunkLabel(row.rangeOrHunk),
    charCount: row.charCount,
    tokenEstimate: row.tokenEstimate,
  }));

  return NextResponse.json({ attached: willSend });
}

function formatFileRangeLabel(raw: string | null): string {
  const range = parseFileRange(raw);
  return range ? `${range.startLine}-${range.endLine}` : "?";
}

function formatHunkLabel(raw: string | null): string {
  const ref = parseHunkRef(raw);
  return ref ? `hunk ${ref.header}` : "hunk";
}
