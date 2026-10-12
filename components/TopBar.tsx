// Identity strip: brand, local/read-only status, active workspace identity, and an honest
// session-state signal kept visually separate from Hermes reachability (SystemStatus, rendered
// by the caller right below this) — VYRON_CODE_V01_P0_WORKSPACE_SHELL_REDESIGN_AUTHORIZATION,
// section C/E ("misleading connection state: Hermes reachable ile active session ayrı
// gösterilecek"). No control here is interactive beyond the optional sidebar toggle.
export function TopBar({
  projectName,
  hasSession,
  onToggleSidebar,
}: {
  projectName: string | null;
  hasSession: boolean;
  onToggleSidebar?: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 14px",
        borderBottom: "1px solid var(--panel-border)",
        fontSize: 13,
      }}
    >
      {onToggleSidebar && (
        <button onClick={onToggleSidebar} aria-label="Toggle navigation" style={{ padding: "4px 8px" }}>
          ☰
        </button>
      )}
      <strong>Vyron Code</strong>
      <span className="badge">local · read-only</span>
      <span style={{ color: "var(--panel-border)" }}>|</span>
      <span style={{ color: "var(--text-dim)" }}>{projectName ? projectName : "No project selected"}</span>
      <span style={{ marginLeft: "auto", color: hasSession ? "var(--ok)" : "var(--text-dim)", fontSize: 11 }}>
        Session: {hasSession ? "active" : "none"}
      </span>
    </div>
  );
}
