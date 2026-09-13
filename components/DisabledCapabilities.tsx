"use client";
import { useState } from "react";
import { api } from "@/lib/apiClient";

// Visibly-present, structurally-disabled affordances — see the Product Blueprint's
// component map. Nothing here calls a route that can mutate anything; the multimodel
// preview call is the one live request, and it only ever returns a preview, never starts
// a session (no /api/multimodel/start route exists in this codebase).
export function DisabledCapabilities({ projectId }: { projectId: string }) {
  const [topic, setTopic] = useState("");
  const [preview, setPreview] = useState<{ will_send: any[]; will_not_send: string[]; start_blocked_reason: string } | null>(null);

  return (
    <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 10 }}>
      <div>
        <div className="badge">Terminal</div>
        <div style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 4 }}>
          No execution capability exists in v0.1&apos;s backend. Planned for v0.4 (propose → approve → run).
        </div>
        <button disabled style={{ marginTop: 4 }}>Run command</button>
      </div>

      <div>
        <div className="badge">Multi-model deliberation</div>
        <textarea
          placeholder="Topic to evaluate…"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          rows={2}
          style={{ width: "100%", marginTop: 4 }}
        />
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <button
            disabled={!topic.trim()}
            onClick={() => api.multimodelPreview(projectId, topic).then(setPreview)}
          >
            Preview context
          </button>
          <button disabled title="Requires v0.2 deliberation-service auth hardening">START_MULTIMODEL</button>
        </div>
        {preview && (
          <div style={{ marginTop: 6, fontSize: 11 }}>
            <div style={{ color: "var(--ok)" }}>Will send:</div>
            <ul style={{ margin: "2px 0 6px 16px" }}>
              {preview.will_send.map((item, i) => (
                <li key={i}>{item.kind}: {item.summary}</li>
              ))}
            </ul>
            <div style={{ color: "var(--danger)" }}>Will NOT send:</div>
            <ul style={{ margin: "2px 0 6px 16px" }}>
              {preview.will_not_send.map((item: string) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <div style={{ color: "var(--text-dim)" }}>{preview.start_blocked_reason}</div>
          </div>
        )}
      </div>
    </div>
  );
}
