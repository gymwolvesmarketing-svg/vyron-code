"use client";
import { useEffect, useRef, useState } from "react";
import { api, type SearchMatch } from "@/lib/apiClient";

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 300;

export function SearchPanel({
  projectId,
  onOpenResult,
  onAddToContext,
}: {
  projectId: string;
  onOpenResult: (path: string, line: number) => void;
  onAddToContext?: (path: string, line: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<SearchMatch[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const trimmed = query.trim();
  const queryTooShort = trimmed.length > 0 && trimmed.length < MIN_QUERY_LENGTH;
  const queryReady = trimmed.length >= MIN_QUERY_LENGTH;

  useEffect(() => {
    // Below the minimum length, invalidate any in-flight/pending request via the ref only —
    // no setState call here. "queryReady" (derived straight from `query` at render time)
    // already keeps stale `matches`/`error`/`loading` from an earlier longer query out of
    // the rendered output, so there is nothing to reset synchronously in the effect body.
    if (!queryReady) {
      requestIdRef.current++;
      return;
    }
    const timer = setTimeout(async () => {
      const requestId = ++requestIdRef.current;
      setLoading(true);
      setError(null);
      try {
        const { matches: results } = await api.search(projectId, trimmed);
        if (requestId !== requestIdRef.current) return; // a newer query already superseded this one
        setMatches(results);
      } catch (e: any) {
        if (requestId !== requestIdRef.current) return;
        setError(e.message || "Search failed.");
        setMatches(null);
      } finally {
        if (requestId === requestIdRef.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [projectId, trimmed, queryReady]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: 8 }}>
        <input
          style={{ width: "100%" }}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search project files…"
          aria-label="Search project files"
          autoFocus
        />
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 8px" }}>
        {queryTooShort && <div style={{ color: "var(--text-dim)", fontSize: 11 }}>Type at least {MIN_QUERY_LENGTH} characters.</div>}
        {queryReady && loading && <div style={{ color: "var(--text-dim)", fontSize: 11 }}>Searching…</div>}
        {queryReady && !loading && error && <div style={{ color: "var(--danger)", fontSize: 11 }}>{error}</div>}
        {queryReady && !loading && !error && matches?.length === 0 && (
          <div style={{ color: "var(--text-dim)", fontSize: 11 }}>No matches.</div>
        )}
        {queryReady && !loading && !error && matches?.length === 200 && (
          <div style={{ color: "var(--text-dim)", fontSize: 10, marginBottom: 4 }}>Showing the first 200 matches.</div>
        )}
        {queryReady &&
          !loading &&
          !error &&
          matches?.map((m, i) => (
            <div
              key={`${m.path}:${m.line}:${i}`}
              role="button"
              tabIndex={0}
              onClick={() => onOpenResult(m.path, m.line)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpenResult(m.path, m.line)}
              style={{ padding: "4px 2px", cursor: "pointer", borderBottom: "1px solid var(--panel-border)" }}
            >
              <div style={{ fontSize: 11, color: "var(--accent)", display: "flex", alignItems: "center", gap: 6 }}>
                <span>
                  {m.path}:{m.line}
                </span>
                {onAddToContext && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddToContext(m.path, m.line);
                    }}
                    aria-label={`Add ${m.path} line ${m.line} to context`}
                    style={{ marginLeft: "auto", fontSize: 10 }}
                  >
                    + context
                  </button>
                )}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-dim)",
                  fontFamily: "ui-monospace, monospace",
                  whiteSpace: "pre",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {m.text}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
