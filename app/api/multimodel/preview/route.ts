import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// Builds the context-preview only — see VYRON_CODE_V01_PRODUCT_BLUEPRINT.md's PRODUCT
// DECISION section. There is deliberately no /api/multimodel/start route anywhere in this
// codebase: START_MULTIMODEL has no backend implementation until v0.2's deliberation-service
// per-client auth prerequisite is met (a change to an existing repo, separately authorized).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const { project_id: projectId, topic, selected_context_ids: selectedIds } = body ?? {};
  if (!projectId || typeof topic !== "string" || !topic.trim()) {
    return NextResponse.json({ error: "project_id and non-empty topic required" }, { status: 400 });
  }

  const db = getDb();
  const willSend: { kind: string; summary: string; size_estimate: string }[] = [{
    kind: "topic",
    summary: topic.slice(0, 120),
    size_estimate: `${topic.length} chars`,
  }];

  if (Array.isArray(selectedIds) && selectedIds.length > 0) {
    const placeholders = selectedIds.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT * FROM context_selections WHERE id IN (${placeholders})`)
      .all(...selectedIds) as any[];
    for (const row of rows) {
      willSend.push({
        kind: row.kind,
        summary: row.range_or_hunk ? `${row.path_or_ref} (${row.range_or_hunk})` : row.path_or_ref,
        size_estimate: "n/a",
      });
    }
  }

  return NextResponse.json({
    will_send: willSend,
    will_not_send: ["full_repo", "chat_history", "secrets", "global_memory", "unselected_project_state"],
    start_available: false,
    start_blocked_reason:
      "START_MULTIMODEL requires hermes-deliberation-service to support a per-client identity registry (v0.2 prerequisite, not yet implemented).",
  });
}
