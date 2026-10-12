"use client";
import { useEffect, useRef, useState } from "react";
import { api, describeContextError, type Project } from "@/lib/apiClient";
import { resolveMainView, shouldShowContextRail, type MainView } from "@/lib/workspaceShell";
import { TopBar } from "@/components/TopBar";
import { Sidebar } from "@/components/Sidebar";
import { WelcomeHome } from "@/components/WelcomeHome";
import { FileTree } from "@/components/FileTree";
import { FileViewer } from "@/components/FileViewer";
import { SearchPanel } from "@/components/SearchPanel";
import { ChatPanel, type ChatPanelHandle } from "@/components/ChatPanel";
import { GitPanel } from "@/components/GitPanel";
import { ContextInspector } from "@/components/ContextInspector";
import { PlannedCapabilities } from "@/components/PlannedCapabilities";
import { TaskTimeline, type RawTimelineEvent } from "@/components/TaskTimeline";
import { SystemStatus } from "@/components/SystemStatus";

const MAX_TIMELINE_EVENTS = 200;
// Below this viewport width the sidebar becomes an off-canvas drawer instead of a fixed
// column, so the main surface never has to squeeze into an unusably narrow strip
// (VYRON_CODE_V01_LOCAL_RUNTIME_HARDENING_IMPLEMENTATION_AUTHORIZATION's original rationale,
// carried forward unchanged into the redesigned shell).
const NARROW_BREAKPOINT_PX = 900;

function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const check = () => setNarrow(window.innerWidth < NARROW_BREAKPOINT_PX);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  return narrow;
}

export default function Home() {
  const [project, setProject] = useState<Project | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [targetLine, setTargetLine] = useState<number | null>(null);
  const [mainView, setMainView] = useState<MainView>("chat");
  const [timelineEvents, setTimelineEvents] = useState<RawTimelineEvent[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionListRefresh, setSessionListRefresh] = useState(0);
  const [contextRefreshToken, setContextRefreshToken] = useState(0);
  const [contextNotice, setContextNotice] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const narrow = useIsNarrow();
  const chatPanelRef = useRef<ChatPanelHandle>(null);

  const hasProject = !!project;
  const resolvedView = resolveMainView(mainView, hasProject);

  // Switching the active project — including now switching directly from one open project to
  // another via the sidebar's Projects list, a capability this redesign adds — must reset
  // every piece of state scoped to the previous project's conversation/view, otherwise (e.g.)
  // the Context Inspector or an open file could keep referencing a DIFFERENT project than the
  // one now active, even though the server itself still enforces per-session/per-project
  // scoping correctly on every request regardless.
  function selectProject(next: Project) {
    setProject(next);
    setOpenPath(null);
    setTargetLine(null);
    setMainView("chat");
    setTimelineEvents([]);
    setActiveSessionId(null);
    setContextRefreshToken((n) => n + 1);
    setContextNotice(null);
    setSidebarOpen(false);
  }

  function setMainViewAndCloseDrawer(view: MainView) {
    setMainView(view);
    setSidebarOpen(false);
  }

  function openFile(path: string) {
    setOpenPath(path);
    setTargetLine(null);
    setMainViewAndCloseDrawer("file");
  }

  function openSearchResult(path: string, line: number) {
    setOpenPath(path);
    setTargetLine(line);
    setMainViewAndCloseDrawer("file");
  }

  function recordTimelineEvent(evt: RawTimelineEvent) {
    setTimelineEvents((prev) => [...prev, evt].slice(-MAX_TIMELINE_EVENTS));
  }

  function bumpContextRefresh() {
    setContextRefreshToken((n) => n + 1);
  }

  async function addFileSnippetToContext(path: string, startLine: number, endLine: number) {
    if (!project) return;
    if (!activeSessionId) {
      setContextNotice("Start or select a conversation first — context is scoped to the active conversation.");
      return;
    }
    setContextNotice(null);
    try {
      await api.addFileSnippetContext(activeSessionId, project.id, path, startLine, endLine);
      bumpContextRefresh();
    } catch (e: any) {
      setContextNotice(describeContextError(e.message));
    }
  }

  function addSearchResultToContext(path: string, line: number) {
    return addFileSnippetToContext(path, line, line);
  }

  const showContextRail = resolvedView === "chat" && hasProject && shouldShowContextRail(activeSessionId);

  let mainContent: React.ReactNode;
  if (resolvedView === "chat") {
    mainContent = hasProject ? (
      <ChatPanel
        key={project!.id}
        ref={chatPanelRef}
        projectId={project!.id}
        onTimelineEvent={recordTimelineEvent}
        onSessionChange={setActiveSessionId}
        onActivity={() => setSessionListRefresh((n) => n + 1)}
      />
    ) : (
      <WelcomeHome />
    );
  } else if (resolvedView === "explorer") {
    mainContent = (
      <div key={project!.id} style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--panel-border)" }}>
          <div style={{ fontWeight: 600 }}>{project!.displayName}</div>
          <div className="badge" style={{ marginTop: 4 }}>
            Explorer (read-only)
          </div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4, wordBreak: "break-all" }}>{project!.canonicalRoot}</div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
          <FileTree projectId={project!.id} onOpenFile={openFile} selectedPath={openPath} />
        </div>
      </div>
    );
  } else if (resolvedView === "search") {
    mainContent = (
      <div key={project!.id} style={{ height: "100%" }}>
        <SearchPanel projectId={project!.id} onOpenResult={openSearchResult} onAddToContext={addSearchResultToContext} />
      </div>
    );
  } else if (resolvedView === "file") {
    mainContent = (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "8px 14px", borderBottom: "1px solid var(--panel-border)", display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={() => setMainViewAndCloseDrawer("explorer")}>← Explorer</button>
          <span style={{ fontSize: 12, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {openPath}
          </span>
        </div>
        <div style={{ flex: 1, overflow: "hidden" }}>
          <FileViewer projectId={project!.id} path={openPath} targetLine={targetLine} onAddToContext={addFileSnippetToContext} />
        </div>
      </div>
    );
  } else if (resolvedView === "git") {
    mainContent = (
      <div key={project!.id} style={{ height: "100%", overflowY: "auto" }}>
        <GitPanel projectId={project!.id} sessionId={activeSessionId} onContextChanged={bumpContextRefresh} />
      </div>
    );
  } else if (resolvedView === "activity") {
    mainContent = <TaskTimeline events={timelineEvents} />;
  } else {
    mainContent = <PlannedCapabilities />;
  }

  const contextRail = showContextRail ? (
    <div style={{ width: 300, flex: "0 0 auto", borderLeft: "1px solid var(--panel-border)", overflowY: "auto" }}>
      {contextNotice && (
        <div style={{ padding: 8, fontSize: 11, color: "var(--danger)", borderBottom: "1px solid var(--panel-border)" }}>{contextNotice}</div>
      )}
      <ContextInspector
        key={activeSessionId ?? "none"}
        projectId={project!.id}
        sessionId={activeSessionId}
        canonicalRoot={project!.canonicalRoot}
        refreshToken={contextRefreshToken}
      />
    </div>
  ) : null;

  const sidebar = (
    <Sidebar
      project={project}
      activeLocalSessionId={activeSessionId}
      sessionListRefresh={sessionListRefresh}
      mainView={resolvedView}
      onNewChat={() => {
        chatPanelRef.current?.startNewChat();
        setMainViewAndCloseDrawer("chat");
      }}
      onSelectConversation={(id) => {
        chatPanelRef.current?.selectConversation(id);
        setMainViewAndCloseDrawer("chat");
      }}
      onSelectProject={selectProject}
      onSetMainView={setMainViewAndCloseDrawer}
    />
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <TopBar
        projectName={project?.displayName ?? null}
        hasSession={!!activeSessionId}
        onToggleSidebar={narrow ? () => setSidebarOpen((v) => !v) : undefined}
      />
      <SystemStatus />
      <div style={{ flex: 1, display: "flex", overflow: "hidden", position: "relative" }}>
        {narrow ? (
          sidebarOpen && (
            <div
              style={{
                position: "absolute",
                inset: "0 auto 0 0",
                width: 280,
                zIndex: 5,
                background: "var(--bg)",
                borderRight: "1px solid var(--panel-border)",
                overflowY: "auto",
                boxShadow: "2px 0 12px rgba(0,0,0,0.4)",
              }}
            >
              {sidebar}
            </div>
          )
        ) : (
          <div style={{ width: 280, flex: "0 0 auto", borderRight: "1px solid var(--panel-border)", overflowY: "auto" }}>{sidebar}</div>
        )}

        <div style={{ flex: 1, minWidth: 0, display: "flex", overflow: "hidden" }}>
          <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>{mainContent}</div>
          {contextRail}
        </div>
      </div>
    </div>
  );
}
