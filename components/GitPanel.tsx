"use client";
import { useEffect, useState } from "react";
import { api, describeContextError, type GitCommit, type GitDiffResponse, type GitStatusResponse } from "@/lib/apiClient";
import { gitChangedFilesSummary } from "@/lib/workspaceShell";

const LOG_PAGE_SIZE = 30;

export function GitPanel({
  projectId,
  sessionId,
  onContextChanged,
}: {
  projectId: string;
  sessionId: string | null;
  onContextChanged?: () => void;
}) {
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<GitDiffResponse | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [logHasMore, setLogHasMore] = useState(false);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [contextNotice, setContextNotice] = useState<string | null>(null);
  const [showFileList, setShowFileList] = useState(false);

  function loadStatus() {
    setStatusError(null);
    api
      .gitStatus(projectId)
      .then(setStatus)
      .catch((e) => setStatusError(e.message || "Could not read git status."));
  }

  // Written as its own inline fetch (not a call to loadStatus()) so the effect body
  // contains no synchronous setState call reachable from it — only the async .then/.catch
  // continuations set state, which React's own rule allows. This component is remounted by
  // `key={projectId}` at its call site (see app/page.tsx) on a project switch, so the other
  // per-project state (selectedFile/diff/commits/showLog) already starts at its correct
  // initial value without needing an explicit reset here.
  useEffect(() => {
    api
      .gitStatus(projectId)
      .then(setStatus)
      .catch((e) => setStatusError(e.message || "Could not read git status."));
  }, [projectId]);

  function openDiff(path: string) {
    setSelectedFile(path);
    setDiff(null);
    setDiffError(null);
    api
      .gitDiff(projectId, path)
      .then(setDiff)
      .catch((e) => setDiffError(e.message || "Could not load the diff for this file."));
  }

  function loadMoreLog() {
    setLogLoading(true);
    setLogError(null);
    api
      .gitLog(projectId, LOG_PAGE_SIZE, commits.length)
      .then((r) => {
        setCommits((prev) => [...prev, ...r.commits]);
        setLogHasMore(r.hasMore);
      })
      .catch((e) => setLogError(e.message || "Could not load commit history."))
      .finally(() => setLogLoading(false));
  }

  function toggleLog() {
    const next = !showLog;
    setShowLog(next);
    if (next && commits.length === 0) loadMoreLog();
  }

  async function addHunkToContext(header: string, index: number) {
    if (!sessionId || !selectedFile) return;
    setContextNotice(null);
    try {
      await api.addGitHunkContext(sessionId, projectId, selectedFile, header, index);
      setContextNotice("Added to context.");
      onContextChanged?.();
    } catch (e: any) {
      setContextNotice(describeContextError(e.message));
    }
  }

  if (statusError) {
    return (
      <div style={{ padding: 8 }}>
        <span className="badge">Git — read-only</span>
        <div style={{ color: "var(--danger)", fontSize: 11, marginTop: 6 }}>{statusError}</div>
      </div>
    );
  }

  if (!status) {
    return (
      <div style={{ padding: 8 }}>
        <span className="badge">Git — read-only</span>
        <div style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 6 }}>Loading…</div>
      </div>
    );
  }

  if (!status.isRepo) {
    return (
      <div style={{ padding: 8 }}>
        <span className="badge">Git — read-only</span>
        <div style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 6 }}>This folder isn&apos;t a Git repository.</div>
      </div>
    );
  }

  return (
    <div style={{ padding: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span className="badge">Git — read-only</span>
        <span style={{ fontSize: 11 }}>
          {status.header.detached ? "detached HEAD" : status.header.branch || "(unknown branch)"}
          {(status.header.ahead > 0 || status.header.behind > 0) && (
            <span style={{ color: "var(--text-dim)" }}>
              {" "}
              {status.header.ahead > 0 && `↑${status.header.ahead}`}
              {status.header.behind > 0 && ` ↓${status.header.behind}`}
            </span>
          )}
        </span>
        <button onClick={loadStatus} style={{ marginLeft: "auto" }} aria-label="Refresh git status">
          Refresh
        </button>
      </div>

      {status.truncated && <div style={{ color: "var(--text-dim)", fontSize: 10 }}>Status output truncated.</div>}

      {/* Summary-first: the raw per-file list is real information, but dumping it by default
          is exactly the "overwhelming raw path dump" the workspace-shell redesign called out —
          it's one click away instead. */}
      <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{gitChangedFilesSummary(status.files.length)}</div>
      {status.files.length > 0 && (
        <button onClick={() => setShowFileList((v) => !v)} aria-expanded={showFileList} style={{ marginTop: 4 }}>
          {showFileList ? "Hide changed files" : "Show changed files"}
        </button>
      )}

      {showFileList && status.files.length > 0 && (
        <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0 }} aria-label="Changed files">
          {status.files.map((f) => (
            <li key={f.path}>
              <button
                onClick={() => openDiff(f.path)}
                aria-current={selectedFile === f.path}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  fontSize: 11,
                  padding: "2px 4px",
                  border: "none",
                  background: selectedFile === f.path ? "rgba(91,140,255,0.12)" : "transparent",
                }}
                title={f.path}
              >
                <span style={{ color: "var(--text-dim)", fontFamily: "ui-monospace, monospace" }}>
                  {f.index}
                  {f.worktree}
                </span>{" "}
                {f.path}
              </button>
            </li>
          ))}
        </ul>
      )}

      {selectedFile && (
        <div style={{ marginTop: 8, borderTop: "1px solid var(--panel-border)", paddingTop: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 600 }}>{selectedFile}</div>
          {diffError && <div style={{ color: "var(--danger)", fontSize: 11 }}>{diffError}</div>}
          {contextNotice && <div style={{ color: "var(--text-dim)", fontSize: 11 }}>{contextNotice}</div>}
          {!diff && !diffError && <div style={{ color: "var(--text-dim)", fontSize: 11 }}>Loading diff…</div>}
          {diff && diff.hunks.length === 0 && diff.diff && (
            <pre style={{ whiteSpace: "pre-wrap", fontSize: 10, maxHeight: 200, overflowY: "auto" }}>{diff.diff.slice(0, 5000)}</pre>
          )}
          {diff &&
            diff.hunks.map((hunk) => (
              <div key={hunk.index} style={{ marginTop: 4, border: "1px solid var(--panel-border)", borderRadius: 3 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 4px", background: "rgba(0,0,0,0.15)" }}>
                  <span style={{ fontSize: 10, fontFamily: "ui-monospace, monospace", color: "var(--text-dim)" }}>{hunk.header}</span>
                  {sessionId && (
                    <button onClick={() => addHunkToContext(hunk.header, hunk.index)} style={{ marginLeft: "auto", fontSize: 10 }}>
                      + Add to context
                    </button>
                  )}
                </div>
                <pre style={{ whiteSpace: "pre-wrap", fontSize: 10, margin: 0, padding: 4, maxHeight: 160, overflowY: "auto" }}>{hunk.body}</pre>
              </div>
            ))}
          {diff?.truncated && <div style={{ color: "var(--text-dim)", fontSize: 10 }}>Diff output truncated.</div>}
        </div>
      )}

      <div style={{ marginTop: 8, borderTop: "1px solid var(--panel-border)", paddingTop: 6 }}>
        <button onClick={toggleLog} aria-expanded={showLog}>
          {showLog ? "Hide history" : "Show history"}
        </button>
        {showLog && (
          <div style={{ marginTop: 4 }}>
            {logError && <div style={{ color: "var(--danger)", fontSize: 11 }}>{logError}</div>}
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="Commit history">
              {commits.map((c) => (
                <li key={c.hash} style={{ fontSize: 11, padding: "2px 0", borderBottom: "1px solid var(--panel-border)" }}>
                  <div style={{ color: "var(--accent)", fontFamily: "ui-monospace, monospace" }}>{c.hash.slice(0, 8)}</div>
                  <div>{c.subject}</div>
                  <div style={{ color: "var(--text-dim)", fontSize: 10 }}>
                    {c.author} · {c.date}
                  </div>
                </li>
              ))}
            </ul>
            {logHasMore && (
              <button onClick={loadMoreLog} disabled={logLoading} style={{ marginTop: 4 }}>
                {logLoading ? "Loading…" : "Load more"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
