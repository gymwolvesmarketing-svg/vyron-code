"use client";
import { useEffect, useState } from "react";
import { api, describeAddProjectError, type Project } from "@/lib/apiClient";

export function ProjectPicker({ onSelect }: { onSelect: (project: Project) => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  function refresh() {
    api.listProjects().then((r) => setProjects(r.projects));
  }

  useEffect(refresh, []);

  async function addProject() {
    if (!pathInput.trim()) return;
    setError(null);
    setAdding(true);
    try {
      const { project } = await api.addProject(pathInput.trim());
      setPathInput("");
      refresh();
      onSelect(project);
    } catch (e: any) {
      setError(describeAddProjectError(e.message));
    } finally {
      setAdding(false);
    }
  }

  return (
    <div style={{ maxWidth: 480, margin: "80px auto", padding: 16 }}>
      <h1 style={{ fontSize: 18 }}>Vyron Code <span className="badge">v0.1 read-only</span></h1>
      <div style={{ display: "flex", gap: 6, margin: "16px 0" }}>
        <input
          style={{ flex: 1 }}
          placeholder="C:\path\to\project"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addProject()}
          aria-label="Project folder path"
        />
        <button onClick={addProject} disabled={adding || !pathInput.trim()}>
          {adding ? "Adding…" : "Add project"}
        </button>
      </div>
      {error && <div style={{ color: "var(--danger)", marginBottom: 12 }}>{error}</div>}
      {projects === null && <div style={{ color: "var(--text-dim)" }}>Loading…</div>}
      {projects?.length === 0 && <div style={{ color: "var(--text-dim)" }}>No projects yet — add one above.</div>}
      {projects?.map((p) => (
        <div
          key={p.id}
          role="button"
          tabIndex={0}
          onClick={() => onSelect(p)}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(p)}
          style={{ padding: 8, border: "1px solid var(--panel-border)", borderRadius: 4, marginBottom: 6, cursor: "pointer" }}
        >
          <div>{p.displayName}</div>
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{p.canonicalRoot}</div>
        </div>
      ))}
    </div>
  );
}
