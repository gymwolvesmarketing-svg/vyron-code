"use client";
import { SessionList } from "./SessionList";
import { ProjectPicker } from "./ProjectPicker";
import { isNavEnabled, type MainView } from "@/lib/workspaceShell";
import type { Project } from "@/lib/apiClient";

const NAV_ITEMS: { id: MainView; label: string }[] = [
  { id: "explorer", label: "Explorer" },
  { id: "search", label: "Search" },
  { id: "git", label: "Git summary" },
  { id: "activity", label: "Activity" },
  { id: "more", label: "More" },
];

// Persistent left navigation — VYRON_CODE_V01_P0_WORKSPACE_SHELL_REDESIGN_AUTHORIZATION.
// Owns none of the actual project/session/view state; every action is a callback into the
// parent (app/page.tsx), which is the single owner of that state, so switching a project or
// starting a chat here can never diverge from what the main surface renders.
export function Sidebar({
  project,
  activeLocalSessionId,
  sessionListRefresh,
  mainView,
  onNewChat,
  onSelectConversation,
  onSelectProject,
  onSetMainView,
}: {
  project: Project | null;
  activeLocalSessionId: string | null;
  sessionListRefresh: number;
  mainView: MainView;
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
  onSelectProject: (p: Project) => void;
  onSetMainView: (v: MainView) => void;
}) {
  const hasProject = !!project;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: 8, borderBottom: "1px solid var(--panel-border)" }}>
        <button
          onClick={onNewChat}
          disabled={!hasProject}
          title={hasProject ? undefined : "Open a project first"}
          style={{ width: "100%" }}
        >
          + New chat
        </button>
      </div>

      <div style={{ padding: 8, borderBottom: "1px solid var(--panel-border)" }}>
        {hasProject ? (
          <SessionList
            projectId={project!.id}
            activeLocalSessionId={activeLocalSessionId}
            refreshToken={sessionListRefresh}
            onNewChat={onNewChat}
            onSelect={onSelectConversation}
          />
        ) : (
          <>
            <div className="badge">Conversations</div>
            <div style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 6 }}>Open a project to see its conversations.</div>
          </>
        )}
      </div>

      <div style={{ padding: 8, borderBottom: "1px solid var(--panel-border)" }}>
        <ProjectPicker activeProjectId={project?.id ?? null} onSelect={onSelectProject} />
      </div>

      <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 2 }}>
        {NAV_ITEMS.map((item) => {
          const enabled = isNavEnabled(item.id, hasProject);
          const active = mainView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onSetMainView(item.id)}
              disabled={!enabled}
              title={enabled ? undefined : "Open a project first"}
              aria-current={active}
              style={{
                textAlign: "left",
                border: "1px solid " + (active ? "var(--accent)" : "transparent"),
                background: active ? "rgba(91,140,255,0.08)" : "transparent",
              }}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
