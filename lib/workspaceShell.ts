/**
 * Pure, testable logic for the v0.1 chat-first workspace shell
 * (VYRON_CODE_V01_P0_WORKSPACE_SHELL_REDESIGN_AUTHORIZATION). Rendering lives in components/;
 * this module holds only the decisions that would otherwise be buried inside JSX and are
 * cheap to get wrong — which main view is safe to show, whether a project-scoped nav entry
 * should be reachable, whether the contextual rail should render at all, how the Explorer
 * declutters known generated/internal top-level entries, and how the Git panel's
 * summary-first line reads. None of this reaches the network or the filesystem itself.
 */

export type MainView = "chat" | "explorer" | "search" | "file" | "git" | "activity" | "more";

// "more" and "chat" are always reachable (chat renders its own no-project welcome state);
// every other view needs an open project to mean anything.
const PROJECT_SCOPED_VIEWS = new Set<MainView>(["explorer", "search", "file", "git", "activity"]);

export function isNavEnabled(view: MainView, hasProject: boolean): boolean {
  if (!PROJECT_SCOPED_VIEWS.has(view)) return true;
  return hasProject;
}

/** Never returns a project-scoped view when no project is open — falls back to "chat" instead
 * of rendering a broken/empty panel. */
export function resolveMainView(requested: MainView, hasProject: boolean): MainView {
  return isNavEnabled(requested, hasProject) ? requested : "chat";
}

// Presentational declutter only (not a security boundary — lib/canonicalPath.ts's deny-list
// is that, unconditionally, server-side, before this ever runs). This just groups the
// top-level entries a v0.1 workspace almost always has (its own build/tooling output) behind
// a collapsed "Generated & internal" node so they don't compete with real project files.
const GENERATED_OR_INTERNAL_TOP_LEVEL_NAMES = new Set([".next", ".claude", "data", "node_modules", "coverage", "dist", "build"]);

export function partitionEntriesForDisplay<T extends { name: string }>(entries: T[]): { primary: T[]; secondary: T[] } {
  const primary: T[] = [];
  const secondary: T[] = [];
  for (const entry of entries) {
    (GENERATED_OR_INTERNAL_TOP_LEVEL_NAMES.has(entry.name) ? secondary : primary).push(entry);
  }
  return { primary, secondary };
}

/** The Context rail is contextual to an active conversation — with no session, it has
 * nothing to show and must not consume space rendering an empty placeholder. */
export function shouldShowContextRail(sessionId: string | null): boolean {
  return sessionId !== null;
}

/** Git panel's summary-first line — real counts only, never a fabricated metric. */
export function gitChangedFilesSummary(fileCount: number): string {
  if (fileCount === 0) return "Working tree clean.";
  return fileCount === 1 ? "1 changed file." : `${fileCount} changed files.`;
}
