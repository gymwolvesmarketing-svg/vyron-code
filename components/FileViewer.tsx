"use client";
import { useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { api } from "@/lib/apiClient";

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", json: "json", md: "markdown", css: "css", html: "html",
  yml: "yaml", yaml: "yaml", sh: "shell", sql: "sql",
};

export function FileViewer({
  projectId,
  path,
  targetLine,
  onAddToContext,
}: {
  projectId: string;
  path: string | null;
  targetLine?: number | null;
  onAddToContext?: (path: string, startLine: number, endLine: number) => void;
}) {
  if (!path) return <div style={{ padding: 16, color: "var(--text-dim)" }}>Select a file to view (read-only).</div>;
  // key={path} makes React remount on path change instead of us manually resetting state
  // inside the effect — avoids a synchronous setState-at-top-of-effect (flagged by
  // react-hooks/set-state-in-effect) and gives a clean loading state for free. targetLine is
  // NOT part of the key: jumping to a different line in the SAME already-open file must not
  // re-fetch the content, only move the editor's viewport/cursor.
  return <FileContent key={path} projectId={projectId} path={path} targetLine={targetLine} onAddToContext={onAddToContext} />;
}

function FileContent({
  projectId,
  path,
  targetLine,
  onAddToContext,
}: {
  projectId: string;
  path: string;
  targetLine?: number | null;
  onAddToContext?: (path: string, startLine: number, endLine: number) => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [encoding, setEncoding] = useState<"utf8" | "base64">("utf8");
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ startLine: number; endLine: number } | null>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .readFile(projectId, path)
      .then((r) => {
        if (cancelled) return;
        setContent(r.content);
        setEncoding(r.encoding);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, path]);

  useEffect(() => {
    if (!targetLine || !editorRef.current) return;
    editorRef.current.revealLineInCenter(targetLine);
    editorRef.current.setSelection({ startLineNumber: targetLine, startColumn: 1, endLineNumber: targetLine, endColumn: 1 });
  }, [targetLine, content]);

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
    if (targetLine) {
      editor.revealLineInCenter(targetLine);
      editor.setSelection({ startLineNumber: targetLine, startColumn: 1, endLineNumber: targetLine, endColumn: 1 });
    }
    editor.onDidChangeCursorSelection((e) => {
      const sel = e.selection;
      if (sel.isEmpty()) {
        setSelection(null);
        return;
      }
      setSelection({ startLine: Math.min(sel.startLineNumber, sel.endLineNumber), endLine: Math.max(sel.startLineNumber, sel.endLineNumber) });
    });
  };

  if (error) return <div style={{ padding: 16, color: "var(--danger)" }}>{error}</div>;
  if (content === null) return <div style={{ padding: 16, color: "var(--text-dim)" }}>Loading…</div>;
  if (encoding === "base64") return <div style={{ padding: 16, color: "var(--text-dim)" }}>Binary file — no preview in v0.1.</div>;

  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {onAddToContext && selection && (
        <div style={{ padding: "4px 8px", borderBottom: "1px solid var(--panel-border)", fontSize: 11, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "var(--text-dim)" }}>
            Lines {selection.startLine}-{selection.endLine} selected
          </span>
          <button
            onClick={() => {
              onAddToContext(path, selection.startLine, selection.endLine);
              setSelection(null);
            }}
          >
            + Add to context
          </button>
        </div>
      )}
      <div style={{ flex: 1, overflow: "hidden" }}>
        <Editor
          height="100%"
          theme="vs-dark"
          language={EXT_TO_LANGUAGE[ext] || "plaintext"}
          value={content}
          options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13 }}
          onMount={handleMount}
        />
      </div>
    </div>
  );
}
