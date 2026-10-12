"use client";
import { useEffect, useState } from "react";
import { api, describeAddProjectError, type Project } from "@/lib/apiClient";

// Compact, sidebar-embeddable project list + inline "add project" form —
// VYRON_CODE_V01_P0_WORKSPACE_SHELL_REDESIGN_AUTHORIZATION replaced the old full-page,
// path-input-only launcher with this smaller explicit action embedded in the persistent
// left nav. Selecting a project never creates a Hermes session by itself (that still only
// ever happens via ChatPanel's own explicit "+ New chat").
export function ProjectPicker({
  activeProjectId,
  onSelect,
}: {
  activeProjectId?: string | null;
  onSelect: (project: Project) => void;
}) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // null = the user hasn't explicitly opened/closed the form yet, so it defaults open once the
  // list is known to be empty (a brand-new instance shouldn't be a dead end); true/false = the
  // user's own explicit choice, which always wins from then on. Derived at render time — no
  // effect needed to "auto-open", which avoids a synchronous setState-in-effect entirely.
  const [formOpenOverride, setFormOpenOverride] = useState<boolean | null>(null);
  const formOpen = formOpenOverride ?? projects?.length === 0;

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
      setFormOpenOverride(false);
      refresh();
      onSelect(project);
    } catch (e: any) {
      setError(describeAddProjectError(e.message));
    } finally {
      setAdding(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 4px 6px" }}>
        <span className="badge">Projects</span>
        <button onClick={() => setFormOpenOverride(!formOpen)} aria-expanded={formOpen} style={{ fontSize: 11, padding: "2px 8px" }}>
          {formOpen ? "Cancel" : "+ Add project"}
        </button>
      </div>

      {formOpen && (
        <div style={{ display: "flex", gap: 6, padding: "0 4px 8px" }}>
          <input
            style={{ flex: 1, fontSize: 11 }}
            placeholder="C:\path\to\project"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addProject()}
            aria-label="Project folder path"
            autoFocus
          />
          <button onClick={addProject} disabled={adding || !pathInput.trim()} style={{ fontSize: 11 }}>
            {adding ? "Adding…" : "Add"}
          </button>
        </div>
      )}
      {error && <div style={{ color: "var(--danger)", fontSize: 11, padding: "0 4px 8px" }}>{error}</div>}

      {projects === null && <div style={{ color: "var(--text-dim)", fontSize: 11, padding: "0 4px" }}>Loading…</div>}
      {projects?.length === 0 && !formOpen && (
        <div style={{ color: "var(--text-dim)", fontSize: 11, padding: "0 4px" }}>No projects yet — add one above.</div>
      )}
      {projects?.map((p) => (
        <div
          key={p.id}
          role="button"
          tabIndex={0}
          onClick={() => onSelect(p)}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(p)}
          aria-current={p.id === activeProjectId}
          style={{
            padding: "6px 8px",
            borderRadius: 4,
            marginBottom: 4,
            cursor: "pointer",
            border: "1px solid " + (p.id === activeProjectId ? "var(--accent)" : "transparent"),
            background: p.id === activeProjectId ? "rgba(91,140,255,0.08)" : "transparent",
          }}
        >
          <div style={{ fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.displayName}</div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {p.canonicalRoot}
          </div>
        </div>
      ))}
    </div>
  );
}
