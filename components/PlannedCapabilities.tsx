// Purely descriptive. No interactive control, disabled button, form, or text area of any
// kind — VYRON_CODE_V01_P0_WORKSPACE_SHELL_REDESIGN_AUTHORIZATION's revised v0.1 product
// decision (see VYRON_CODE_V01_PRODUCT_BLUEPRINT.md's amended component-map entry) replaces
// the previous "visibly-disabled interactive control" pattern (components/DisabledCapabilities.tsx,
// removed) with this non-interactive disclosure. Nothing here calls any route, and no runtime
// or backend capability for Terminal or Multi-model deliberation exists anywhere in this
// codebase — this panel only states that fact.
export function PlannedCapabilities() {
  return (
    <div style={{ padding: 14, maxWidth: 560 }}>
      <div className="badge">Planned capabilities — not available in v0.1</div>
      <p style={{ marginTop: 10, color: "var(--text-dim)", lineHeight: 1.6, fontSize: 12.5 }}>
        Vyron Code v0.1 is a read-only workspace. The following are part of the product&apos;s longer-term direction, but have no
        implementation — no UI control, no API route, no backend capability — anywhere in v0.1:
      </p>
      <ul style={{ marginTop: 10, paddingLeft: 18, color: "var(--text-dim)", lineHeight: 1.7, fontSize: 12.5 }}>
        <li>
          <strong style={{ color: "var(--text)" }}>Terminal</strong> — running shell commands from Vyron Code. Planned for a later
          version, with an explicit propose → approve → run flow.
        </li>
        <li>
          <strong style={{ color: "var(--text)" }}>Multi-model deliberation</strong> — sending a topic and selected context to
          multiple models for a combined recommendation. Planned once the underlying deliberation service supports a separate
          credential for Vyron Code.
        </li>
      </ul>
      <p style={{ marginTop: 10, color: "var(--text-dim)", lineHeight: 1.6, fontSize: 12.5 }}>
        File write and Git write (stage/commit/push) are not on this list because they are not part of v0.1&apos;s current design
        direction at all — this workspace stays read-only for everything it can already show you: files, search, git history, and
        chat.
      </p>
    </div>
  );
}
