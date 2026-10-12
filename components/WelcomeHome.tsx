// The chat-view's own no-project state — rendered instead of the old full-page project
// picker so the app always shows its real product shell first
// (VYRON_CODE_V01_P0_WORKSPACE_SHELL_REDESIGN_AUTHORIZATION). No control here creates a
// session or a project; project selection/creation lives in the sidebar's Projects section.
export function WelcomeHome() {
  return (
    <div style={{ padding: 24, maxWidth: 520 }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>Welcome to Vyron Code</h1>
      <p style={{ marginTop: 12, color: "var(--text-dim)", lineHeight: 1.6, fontSize: 13 }}>
        A local, read-only, project-aware workspace for working alongside Hermes.
      </p>
      <ul style={{ marginTop: 16, paddingLeft: 18, lineHeight: 1.8, fontSize: 13 }}>
        <li>Open or add a local project from <strong>Projects</strong> in the sidebar.</li>
        <li>Browse its files, read-only, with <strong>Explorer</strong> and <strong>Search</strong>.</li>
        <li>Once a project is open, start a chat here — sending a message needs a configured Hermes session.</li>
      </ul>
      <p style={{ marginTop: 16, color: "var(--text-dim)", fontSize: 12 }}>No project is open yet — nothing else on this page is active.</p>
    </div>
  );
}
