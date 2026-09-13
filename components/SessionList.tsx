"use client";
import { useEffect, useState } from "react";
import { api, type ConversationSummary } from "@/lib/apiClient";

const STATUS_LABEL: Record<ConversationSummary["status"], string> = {
  active: "Active",
  interrupted: "Interrupted",
  completed: "Done",
  error: "Error",
};
const STATUS_COLOR: Record<ConversationSummary["status"], string> = {
  active: "var(--ok)",
  interrupted: "var(--text-dim)",
  completed: "var(--text-dim)",
  error: "var(--danger)",
};

function relativeTime(ms: number | null): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function SessionList({
  projectId,
  activeLocalSessionId,
  refreshToken,
  onNewChat,
  onSelect,
}: {
  projectId: string;
  activeLocalSessionId: string | null;
  refreshToken: number;
  onNewChat: () => void;
  onSelect: (localSessionId: string) => void;
}) {
  const [sessions, setSessions] = useState<ConversationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listSessions(projectId)
      .then((r) => setSessions(r.sessions))
      .catch((e) => setError(e.message));
    // refreshToken bump (new session created, prompt sent, interrupt) re-fetches the list so
    // status/message-count/ordering stay current without polling.
  }, [projectId, refreshToken]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 4px 6px" }}>
        <span className="badge">Conversations</span>
        <button onClick={onNewChat} style={{ fontSize: 11, padding: "2px 8px" }}>
          + New chat
        </button>
      </div>
      {error && <div style={{ color: "var(--danger)", fontSize: 11, padding: "0 4px" }}>{error}</div>}
      {sessions === null && !error && <div style={{ color: "var(--text-dim)", fontSize: 11, padding: "0 4px" }}>Loading…</div>}
      {sessions?.length === 0 && <div style={{ color: "var(--text-dim)", fontSize: 11, padding: "0 4px" }}>No conversations in this project yet.</div>}
      {sessions?.map((s) => (
        <div
          key={s.id}
          onClick={() => onSelect(s.id)}
          role="button"
          tabIndex={0}
          aria-current={s.id === activeLocalSessionId}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(s.id)}
          style={{
            padding: "6px 8px",
            borderRadius: 4,
            cursor: "pointer",
            border: "1px solid " + (s.id === activeLocalSessionId ? "var(--accent)" : "transparent"),
            background: s.id === activeLocalSessionId ? "rgba(91,140,255,0.08)" : "transparent",
          }}
        >
          <div style={{ fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {s.title || "Untitled conversation"}
          </div>
          <div style={{ display: "flex", gap: 6, fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
            <span style={{ color: STATUS_COLOR[s.status] }}>{STATUS_LABEL[s.status]}</span>
            <span>·</span>
            <span>{s.messageCount} msg</span>
            <span>·</span>
            <span>{relativeTime(s.lastActivityAt ?? s.createdAt)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
