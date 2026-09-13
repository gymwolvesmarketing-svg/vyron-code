"use client";
import { useMemo } from "react";

export type RawTimelineEvent = { type: string; payload: Record<string, unknown>; ts: number };

export type Row = {
  id: string;
  label: string;
  state: "running" | "completed" | "failed" | "interrupted" | "info";
  startedAt: number;
  durationMs: number | null;
};

// Normalizes the raw Hermes event stream into safe, display-only rows. Only the metadata this
// task's spec allows ever reaches the label: event type, a short human label, run state, and
// duration. Raw tool input/output, paths, provider credentials, or any payload field beyond
// {tool, preview (already-truncated by Hermes Agent itself)} is never read or rendered here.
export function normalize(events: RawTimelineEvent[]): Row[] {
  const rows: Row[] = [];
  let openToolIndex = -1;

  for (const evt of events) {
    const p = evt.payload || {};
    switch (evt.type) {
      case "session.info":
        rows.push({ id: `${evt.ts}`, label: "Session ready", state: "info", startedAt: evt.ts, durationMs: null });
        break;
      case "message.start":
        rows.push({ id: `${evt.ts}`, label: "Turn started", state: "running", startedAt: evt.ts, durationMs: null });
        break;
      case "thinking.delta": {
        const last = rows[rows.length - 1];
        if (last && last.label === "Thinking…") {
          last.startedAt = evt.ts; // keep the row alive; no duplicate spam per delta chunk
        } else {
          rows.push({ id: `${evt.ts}`, label: "Thinking…", state: "running", startedAt: evt.ts, durationMs: null });
        }
        break;
      }
      case "tool.started": {
        const tool = String(p.tool ?? p.tool_name ?? "tool");
        rows.push({ id: `${evt.ts}`, label: `Running ${tool}`, state: "running", startedAt: evt.ts, durationMs: null });
        openToolIndex = rows.length - 1;
        break;
      }
      case "tool.completed": {
        const openRow = openToolIndex >= 0 ? rows[openToolIndex] : undefined;
        if (openRow) {
          openRow.state = "completed";
          openRow.durationMs = evt.ts - openRow.startedAt;
          openRow.label = openRow.label.replace(/^Running /, "Ran ");
          openToolIndex = -1;
        }
        break;
      }
      case "message.complete":
        rows.push({ id: `${evt.ts}`, label: "Turn completed", state: "completed", startedAt: evt.ts, durationMs: null });
        break;
      case "turn.error":
        rows.push({ id: `${evt.ts}`, label: "Turn failed", state: "failed", startedAt: evt.ts, durationMs: null });
        break;
      case "session.interrupted":
        rows.push({ id: `${evt.ts}`, label: "Interrupted", state: "interrupted", startedAt: evt.ts, durationMs: null });
        break;
      default:
        break; // message.delta and any unrecognized type are chat content, not timeline rows
    }
  }
  return rows;
}

const STATE_COLOR: Record<Row["state"], string> = {
  running: "var(--accent)",
  completed: "var(--ok)",
  failed: "var(--danger)",
  interrupted: "var(--text-dim)",
  info: "var(--text-dim)",
};
const STATE_ICON: Record<Row["state"], string> = {
  running: "●",
  completed: "✓",
  failed: "✗",
  interrupted: "⏸",
  info: "ℹ",
};

export function TaskTimeline({ events }: { events: RawTimelineEvent[] }) {
  const rows = useMemo(() => normalize(events), [events]);

  return (
    <div style={{ padding: 8 }}>
      <div className="badge">Task timeline — read-only</div>
      <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4, maxHeight: 220, overflowY: "auto" }}>
        {rows.length === 0 && <div style={{ color: "var(--text-dim)", fontSize: 11 }}>No activity yet.</div>}
        {rows.map((row) => (
          <div key={row.id} style={{ fontSize: 11, display: "flex", gap: 6, alignItems: "baseline" }}>
            <span style={{ color: STATE_COLOR[row.state] }}>{STATE_ICON[row.state]}</span>
            <span style={{ color: "var(--text)" }}>{row.label}</span>
            {row.durationMs !== null && <span style={{ color: "var(--text-dim)" }}>({(row.durationMs / 1000).toFixed(1)}s)</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
