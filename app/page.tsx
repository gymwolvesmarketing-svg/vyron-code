"use client";
import { useEffect, useState } from "react";
import { api, describeContextError, type Project } from "@/lib/apiClient";
import { ProjectPicker } from "@/components/ProjectPicker";
import { FileTree } from "@/components/FileTree";
import { FileViewer } from "@/components/FileViewer";
import { SearchPanel } from "@/components/SearchPanel";
import { ChatPanel } from "@/components/ChatPanel";
import { GitPanel } from "@/components/GitPanel";
import { ContextInspector } from "@/components/ContextInspector";
import { DisabledCapabilities } from "@/components/DisabledCapabilities";
import { TaskTimeline, type RawTimelineEvent } from "@/components/TaskTimeline";
import { SystemStatus } from "@/components/SystemStatus";

const MAX_TIMELINE_EVENTS = 200;
// Below this viewport width the fixed 3-column desktop grid no longer fits comfortably —
// switch to a single-panel-at-a-time tabbed layout instead of letting the page scroll
// horizontally (VYRON_CODE_V01_LOCAL_RUNTIME_HARDENING_IMPLEMENTATION_AUTHORIZATION, section E).
const NARROW_BREAKPOINT_PX = 900;

type NarrowTab = "explorer" | "search" | "editor" | "chat" | "context" | "git";
const NARROW_TABS: { id: NarrowTab; label: string }[] = [
  { id: "explorer", label: "Explorer" },
  { id: "search", label: "Search" },
  { id: "editor", label: "Editor" },
  { id: "chat", label: "Chat" },
  { id: "context", label: "Context" },
  { id: "git", label: "Git" },
];

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
  const [leftTab, setLeftTab] = useState<"explorer" | "search">("explorer");
  const [timelineEvents, setTimelineEvents] = useState<RawTimelineEvent[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [contextRefreshToken, setContextRefreshToken] = useState(0);
  const [contextNotice, setContextNotice] = useState<string | null>(null);
  const [narrowTab, setNarrowTab] = useState<NarrowTab>("explorer");
  const narrow = useIsNarrow();

  if (!project) return <ProjectPicker onSelect={selectProject} />;

  // Switching the active project (including going back to the picker) must reset every
  // piece of state scoped to the previous project's conversation — otherwise the Context
  // Inspector/Selector could keep showing a conversation (and its context items) that
  // belongs to a DIFFERENT project than the one now open, even though the server itself
  // still enforces per-session/per-project scoping correctly on every request.
  function selectProject(next: Project | null) {
    setProject(next);
    setOpenPath(null);
    setTargetLine(null);
    setTimelineEvents([]);
    setActiveSessionId(null);
    setContextRefreshToken((n) => n + 1);
    setContextNotice(null);
  }

  function openFile(path: string) {
    setOpenPath(path);
    setTargetLine(null);
    setNarrowTab("editor");
  }

  function openSearchResult(path: string, line: number) {
    setOpenPath(path);
    setTargetLine(line);
    setNarrowTab("editor");
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

  const explorerPanel = (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: 8, borderBottom: "1px solid var(--panel-border)" }}>
        <button onClick={() => selectProject(null)} style={{ marginBottom: 6 }}>
          ← projects
        </button>
        <div style={{ fontWeight: 600 }}>{project.displayName}</div>
        <div className="badge" title={project.canonicalRoot}>
          Navigator (read-only)
        </div>
        <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4, wordBreak: "break-all" }}>{project.canonicalRoot}</div>
      </div>
      {!narrow && (
        <div style={{ display: "flex", borderBottom: "1px solid var(--panel-border)" }}>
          <button
            onClick={() => setLeftTab("explorer")}
            style={{ flex: 1, border: "none", borderBottom: leftTab === "explorer" ? "2px solid var(--accent)" : "2px solid transparent", borderRadius: 0 }}
          >
            Explorer
          </button>
          <button
            onClick={() => setLeftTab("search")}
            style={{ flex: 1, border: "none", borderBottom: leftTab === "search" ? "2px solid var(--accent)" : "2px solid transparent", borderRadius: 0 }}
          >
            Search
          </button>
        </div>
      )}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {(narrow ? narrowTab === "explorer" : leftTab === "explorer") ? (
          <div style={{ padding: 8 }}>
            <FileTree projectId={project.id} onOpenFile={openFile} selectedPath={openPath} />
          </div>
        ) : (
          <SearchPanel projectId={project.id} onOpenResult={openSearchResult} onAddToContext={addSearchResultToContext} />
        )}
      </div>
    </div>
  );

  const searchPanel = <SearchPanel projectId={project.id} onOpenResult={openSearchResult} onAddToContext={addSearchResultToContext} />;

  const editorPanel = <FileViewer projectId={project.id} path={openPath} targetLine={targetLine} onAddToContext={addFileSnippetToContext} />;

  const chatPanel = <ChatPanel projectId={project.id} onTimelineEvent={recordTimelineEvent} onSessionChange={setActiveSessionId} />;

  const contextAndTimelinePanel = (
    <>
      {contextNotice && (
        <div style={{ padding: 8, fontSize: 11, color: "var(--danger)", borderBottom: "1px solid var(--panel-border)" }}>{contextNotice}</div>
      )}
      <ContextInspector
        key={activeSessionId ?? "none"}
        projectId={project.id}
        sessionId={activeSessionId}
        canonicalRoot={project.canonicalRoot}
        refreshToken={contextRefreshToken}
      />
      <div style={{ borderTop: "1px solid var(--panel-border)" }}>
        <TaskTimeline events={timelineEvents} />
      </div>
    </>
  );

  const disabledCapabilitiesPanel = <DisabledCapabilities projectId={project.id} />;

  const gitPanel = <GitPanel key={project.id} projectId={project.id} sessionId={activeSessionId} onContextChanged={bumpContextRefresh} />;

  const contextTabPanel = (
    <div style={{ height: "100%", overflowY: "auto" }}>
      {contextAndTimelinePanel}
      <div style={{ borderTop: "1px solid var(--panel-border)" }}>{disabledCapabilitiesPanel}</div>
    </div>
  );

  if (narrow) {
    const NARROW_PANELS: Record<NarrowTab, React.ReactNode> = {
      explorer: explorerPanel,
      search: searchPanel,
      editor: editorPanel,
      chat: chatPanel,
      context: contextTabPanel,
      git: <div style={{ height: "100%", overflowY: "auto" }}>{gitPanel}</div>,
    };
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <SystemStatus />
        <div role="tablist" aria-label="Panels" style={{ display: "flex", overflowX: "auto", borderBottom: "1px solid var(--panel-border)" }}>
          {NARROW_TABS.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={narrowTab === tab.id}
              onClick={() => setNarrowTab(tab.id)}
              style={{
                flex: "0 0 auto",
                padding: "8px 12px",
                border: "none",
                borderBottom: narrowTab === tab.id ? "2px solid var(--accent)" : "2px solid transparent",
                borderRadius: 0,
                whiteSpace: "nowrap",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, overflow: "hidden" }} role="tabpanel">
          {NARROW_PANELS[narrowTab]}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <SystemStatus />
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "240px 1fr 360px", overflow: "hidden" }}>
        <div style={{ borderRight: "1px solid var(--panel-border)", overflowY: "auto" }}>{explorerPanel}</div>

        <div style={{ display: "grid", gridTemplateRows: "1fr 1fr", borderRight: "1px solid var(--panel-border)" }}>
          <div style={{ borderBottom: "1px solid var(--panel-border)", overflow: "hidden" }}>{editorPanel}</div>
          <div style={{ overflow: "hidden" }}>{chatPanel}</div>
        </div>

        <div style={{ overflowY: "auto" }}>
          {contextAndTimelinePanel}
          <div style={{ borderTop: "1px solid var(--panel-border)" }}>{gitPanel}</div>
          <div style={{ borderTop: "1px solid var(--panel-border)" }}>{disabledCapabilitiesPanel}</div>
        </div>
      </div>
    </div>
  );
}
