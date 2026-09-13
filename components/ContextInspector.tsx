"use client";
import { useCallback, useEffect, useState } from "react";
import { api, describeContextError, type ContextListResponse } from "@/lib/apiClient";

const KIND_LABEL: Record<string, string> = { file_snippet: "File", git_diff_hunk: "Git diff hunk" };

function rangeLabel(item: ContextListResponse["items"][number]): string {
  if (!item.rangeOrHunk) return "";
  try {
    const parsed = JSON.parse(item.rangeOrHunk);
    if (typeof parsed.startLine === "number") return `lines ${parsed.startLine}-${parsed.endLine}`;
    if (typeof parsed.header === "string") return parsed.header;
  } catch {
    /* fall through */
  }
  return "";
}

export function ContextInspector({
  projectId,
  sessionId,
  canonicalRoot,
  refreshToken,
}: {
  projectId: string;
  sessionId: string | null;
  canonicalRoot: string;
  refreshToken: number;
}) {
  const [data, setData] = useState<ContextListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [staleBlockers, setStaleBlockers] = useState<Array<{ id: string; pathOrRef: string; reason: string }> | null>(null);

  // Used by action handlers (attach/detach/remove/clear) below — those are event-handler
  // contexts, where a synchronous setState call is unrestricted.
  const refresh = useCallback(() => {
    if (!sessionId) {
      setData(null);
      return;
    }
    api
      .listContext(sessionId)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [sessionId]);

  // Written as its own inline fetch (not a call to refresh()) so the effect body contains
  // no synchronous setState call reachable from it — only the async .then/.catch
  // continuations set state, which is the pattern React's own rule allows. `sessionId` is
  // null-guarded with a plain early return (no setState), and remounting this whole
  // component by `key={sessionId}` at the call site (see app/page.tsx) is what actually
  // resets `data`/`error`/`confirmOpen`/`staleBlockers` to their initial values on a
  // conversation switch — this effect only needs to (re)fetch on a refreshToken bump.
  useEffect(() => {
    if (!sessionId) return;
    api
      .listContext(sessionId)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [sessionId, refreshToken]);

  // Keyboard-only escape hatch for the attach confirm panel — mirrors the Cancel button
  // exactly (never confirms), so Escape can never accidentally attach anything.
  useEffect(() => {
    if (!confirmOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setConfirmOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmOpen]);

  if (!sessionId) {
    return (
      <div style={{ padding: 8 }}>
        <span className="badge">Context</span>
        <div style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 6 }}>
          Start or select a conversation to select context for it.
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ padding: 8 }}>
        <span className="badge">Context</span>
        {error ? <div style={{ color: "var(--danger)", fontSize: 11, marginTop: 6 }}>{error}</div> : <div style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 6 }}>Loading…</div>}
      </div>
    );
  }

  const attachedItems = data.items.filter((i) => i.attached);
  const staleItems = data.items.filter((i) => i.stale);
  const overLimit = data.aggregate.count > data.limits.maxItems;

  async function doAttach() {
    if (!sessionId || data!.items.length === 0) return;
    setBusy(true);
    setStaleBlockers(null);
    try {
      const res = await fetch("/api/context/attach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, ids: data!.items.map((i) => i.id) }),
      });
      const body = await res.json();
      if (!res.ok) {
        if (body.error === "stale_context" && Array.isArray(body.staleItems)) {
          setStaleBlockers(body.staleItems);
        } else {
          setError(body.error || "Attach failed.");
        }
        return;
      }
      setConfirmOpen(false);
      refresh();
    } catch (e: any) {
      setError(e.message || "Attach failed.");
    } finally {
      setBusy(false);
    }
  }

  async function doDetach() {
    if (!sessionId) return;
    setBusy(true);
    try {
      await fetch("/api/context/detach", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: sessionId }) });
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function doRemove(id: string) {
    if (!sessionId) return;
    await api.removeContext(sessionId, id);
    refresh();
  }

  async function doClear() {
    if (!sessionId) return;
    await api.clearContext(sessionId);
    refresh();
  }

  return (
    <div style={{ padding: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="badge">Context</span>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
          {data.aggregate.count}/{data.limits.maxItems} items · {data.aggregate.totalChars}/{data.limits.maxAggregateChars} chars ·{" "}
          {data.aggregate.totalTokens}/{data.limits.maxAggregateTokens} tokens (est.)
        </span>
      </div>
      <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2, wordBreak: "break-all" }} title={canonicalRoot}>
        {canonicalRoot}
      </div>

      {error && <div style={{ color: "var(--danger)", fontSize: 11, marginTop: 6 }}>{error}</div>}
      {overLimit && <div style={{ color: "var(--danger)", fontSize: 11, marginTop: 6 }}>Item limit exceeded — remove items before attaching.</div>}

      {attachedItems.length > 0 && (
        <div style={{ marginTop: 8, padding: 6, background: "rgba(91,140,255,0.10)", borderRadius: 4, fontSize: 11 }}>
          <strong>{attachedItems.length} item(s) attached</strong> — will be included in your next message.
          <button onClick={doDetach} disabled={busy} style={{ marginLeft: 8 }}>
            Detach
          </button>
        </div>
      )}

      {data.items.length === 0 ? (
        <div style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 8 }}>
          No context selected yet. Select a line range in a file, a search result, or a git diff hunk, then &quot;Add to context&quot;.
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }} aria-label="Selected context items">
          {data.items.map((item) => (
            <li key={item.id} style={{ padding: "4px 0", borderBottom: "1px solid var(--panel-border)", fontSize: 11 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "var(--text-dim)" }}>{KIND_LABEL[item.kind] ?? item.kind}</span>
                <span title={item.path} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140 }}>
                  {item.path}
                </span>
                <span style={{ color: "var(--text-dim)" }}>{rangeLabel(item)}</span>
                {item.attached && <span style={{ color: "var(--accent)" }}>●</span>}
                {item.stale && <span style={{ color: "var(--danger)" }}>stale</span>}
                <button
                  onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
                  aria-label={`Toggle preview for ${item.path}`}
                  style={{ marginLeft: "auto" }}
                >
                  {expandedId === item.id ? "hide" : "preview"}
                </button>
                <button onClick={() => doRemove(item.id)} aria-label={`Remove ${item.path} from context`}>
                  ✕
                </button>
              </div>
              <div style={{ color: "var(--text-dim)" }}>
                {item.charCount} chars · ~{item.tokenEstimate} tokens
              </div>
              {item.unavailableReason && <div style={{ color: "var(--danger)" }}>{describeContextError(item.unavailableReason)}</div>}
              {expandedId === item.id && item.preview && (
                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    fontSize: 10,
                    margin: "4px 0 0",
                    padding: 4,
                    background: "var(--panel-bg-alt, rgba(0,0,0,0.15))",
                    maxHeight: 160,
                    overflowY: "auto",
                  }}
                >
                  {item.preview}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}

      {data.items.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {!confirmOpen ? (
            <button onClick={() => setConfirmOpen(true)} disabled={busy || overLimit}>
              Attach selected context
            </button>
          ) : (
            <div role="dialog" aria-label="Attach confirmation" style={{ border: "1px solid var(--panel-border)", borderRadius: 4, padding: 6 }}>
              <div style={{ color: "var(--ok)", marginBottom: 4 }}>Will send:</div>
              <ul style={{ margin: "0 0 6px 16px", fontSize: 11 }}>
                {data.items.map((item) => (
                  <li key={item.id}>
                    {item.path} ({rangeLabel(item)}) — {item.charCount} chars
                  </li>
                ))}
              </ul>
              <div style={{ color: "var(--danger)", marginBottom: 4 }}>Will NOT send:</div>
              <ul style={{ margin: "0 0 6px 16px", fontSize: 11 }}>
                {data.willNotSend.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {staleBlockers && (
                <div style={{ color: "var(--danger)", fontSize: 11, marginBottom: 6 }}>
                  These changed since selection — remove or re-add them before attaching:
                  <ul style={{ margin: "2px 0 0 16px" }}>
                    {staleBlockers.map((b) => (
                      <li key={b.id}>
                        {b.pathOrRef}: {describeContextError(b.reason)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={doAttach} disabled={busy}>
                  {busy ? "Attaching…" : "Confirm attach"}
                </button>
                <button onClick={() => setConfirmOpen(false)} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          <button onClick={doClear} disabled={busy} style={{ marginLeft: 8 }}>
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
