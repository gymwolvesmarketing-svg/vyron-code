"use client";
import { useEffect, useRef, useState } from "react";
import { api, type FsEntry } from "@/lib/apiClient";

function DirNode({
  projectId,
  path,
  onOpenFile,
  selectedPath,
}: {
  projectId: string;
  path: string;
  onOpenFile: (path: string) => void;
  selectedPath: string | null;
}) {
  const [expanded, setExpanded] = useState(path === ".");
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetchStartedRef = useRef(false);
  // Derived, not stored: avoids a synchronous setState-at-top-of-effect (the fetch's own
  // .then/.catch already update `entries`/`error`, which is all render needs).
  const loading = expanded && entries === null && error === null;

  useEffect(() => {
    if (!expanded || fetchStartedRef.current) return;
    fetchStartedRef.current = true;
    api
      .listDir(projectId, path)
      .then((r) => setEntries(r.entries))
      .catch((e) => setError(e.message));
  }, [expanded, projectId, path]);

  function toggle() {
    setExpanded((v) => !v);
  }

  return (
    <div style={{ marginLeft: path === "." ? 0 : 12 }}>
      {path !== "." && (
        <div
          role="treeitem"
          aria-expanded={expanded}
          aria-selected={false}
          tabIndex={0}
          onClick={toggle}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && toggle()}
          style={{ cursor: "pointer", padding: "1px 0", color: "var(--text-dim)" }}
        >
          {expanded ? "▾" : "▸"} {path.split("/").pop()}
        </div>
      )}
      {loading && <div style={{ marginLeft: 12, color: "var(--text-dim)", fontSize: 11 }}>Loading…</div>}
      {expanded && error && <div style={{ marginLeft: 12, color: "var(--danger)", fontSize: 11 }}>{error}</div>}
      {expanded && entries?.length === 0 && (
        <div style={{ marginLeft: 12, color: "var(--text-dim)", fontSize: 11 }}>Empty.</div>
      )}
      {expanded &&
        entries?.map((entry) => {
          const childPath = path === "." ? entry.name : `${path}/${entry.name}`;
          return entry.type === "dir" ? (
            <DirNode key={childPath} projectId={projectId} path={childPath} onOpenFile={onOpenFile} selectedPath={selectedPath} />
          ) : (
            <div
              key={childPath}
              role="treeitem"
              aria-selected={selectedPath === childPath}
              tabIndex={0}
              onClick={() => onOpenFile(childPath)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpenFile(childPath)}
              style={{
                marginLeft: 12,
                padding: "1px 4px",
                cursor: "pointer",
                background: selectedPath === childPath ? "rgba(91,140,255,0.12)" : "transparent",
                borderRadius: 3,
              }}
              title={childPath}
            >
              {entry.name}
            </div>
          );
        })}
    </div>
  );
}

export function FileTree({
  projectId,
  onOpenFile,
  selectedPath,
}: {
  projectId: string;
  onOpenFile: (path: string) => void;
  selectedPath?: string | null;
}) {
  return (
    <div role="tree" aria-label="Project files">
      <DirNode projectId={projectId} path="." onOpenFile={onOpenFile} selectedPath={selectedPath ?? null} />
    </div>
  );
}
