/** Thin fetch wrappers for the browser side — every call hits Vyron Code's own backend
 * routes only; no secret or Hermes/Bridge URL is ever referenced from client code. */

export type Project = { id: string; canonicalRoot: string; displayName: string; openedAt: number; lastActiveAt: number };
export type FsEntry = { name: string; type: "file" | "dir" };
export type SearchMatch = { path: string; line: number; text: string };
export type GitCommit = { hash: string; author: string; date: string; subject: string };
export type GitStatusHeader = { branch: string | null; upstream: string | null; ahead: number; behind: number; detached: boolean };
export type GitStatusFile = { path: string; index: string; worktree: string };
export type GitStatusResponse =
  | { isRepo: false }
  | { isRepo: true; output: string; truncated: boolean; header: GitStatusHeader; files: GitStatusFile[] };
export type GitLogResponse = { isRepo: boolean; commits: GitCommit[]; hasMore: boolean };
export type GitHunk = { index: number; header: string; body: string };
export type GitDiffResponse = { isRepo: boolean; diff: string; truncated: boolean; hunks: GitHunk[] };

export type ContextItem = {
  id: string;
  kind: "file_snippet" | "git_diff_hunk";
  path: string;
  rangeOrHunk: string | null;
  charCount: number;
  tokenEstimate: number;
  attached: boolean;
  createdAt: number;
  stale: boolean;
  preview: string | null;
  unavailableReason: string | null;
};
export type ContextListResponse = {
  items: ContextItem[];
  aggregate: { count: number; totalChars: number; totalTokens: number };
  limits: { maxItems: number; maxItemChars: number; maxAggregateChars: number; maxAggregateTokens: number };
  willNotSend: string[];
};
export type ConversationSummary = {
  id: string;
  title: string | null;
  status: "active" | "interrupted" | "completed" | "error";
  createdAt: number;
  updatedAt: number | null;
  lastActivityAt: number | null;
  messageCount: number;
};

async function json<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `request failed: ${res.status}`);
  return body as T;
}

// Maps the API's internal reason codes to user-facing text — never echoes the raw path the
// user typed or any resolved absolute path back at them beyond what they already entered.
const ADD_PROJECT_ERROR_MESSAGES: Record<string, string> = {
  root_not_resolvable: "That folder doesn't exist or isn't a directory.",
  drive_root: "A whole drive can't be added as a project — pick a specific project folder inside it.",
  home_root: "Your home/profile folder can't be added as a project — pick a specific project folder inside it.",
  common_user_folder: "Common folders like Desktop, Documents, or Downloads can't be added directly — pick the specific project folder inside them.",
};

export function describeAddProjectError(code: string): string {
  return ADD_PROJECT_ERROR_MESSAGES[code] || "That folder can't be added as a project.";
}

// Maps every context-selection/attach rejection reason code the server can return to a
// short, safe, user-facing message — never echoes a raw path, stack trace, or git error text.
const CONTEXT_ERROR_MESSAGES: Record<string, string> = {
  cross_project_rejected: "That item belongs to a different project and can't be added here.",
  absolute_path_rejected: "That path isn't allowed.",
  path_outside_project_root: "That path is outside the project folder.",
  path_denied: "That file is protected and can't be used as context (e.g. a secret, key, or .git file).",
  not_found: "That file couldn't be found.",
  not_a_file: "That path is a folder, not a file.",
  binary_or_unsupported: "Binary files can't be used as context.",
  file_too_large: "That file is too large to read.",
  invalid_or_stale_range: "That line range is no longer valid — the file may have changed.",
  invalid_stored_range: "That selection's stored range is invalid.",
  invalid_hunk_reference: "That diff hunk reference is invalid.",
  invalid_stored_hunk_ref: "That selection's stored hunk reference is invalid.",
  hunk_not_found_or_stale: "That diff hunk is no longer present — the file may have changed.",
  not_a_repo: "This folder isn't a Git repository.",
  git_error: "The Git command failed.",
  content_too_large: "That selection is too large (over the 12,000-character single-item limit).",
  item_limit_reached: "You can attach at most 8 context items at a time.",
  aggregate_char_limit_exceeded: "Adding that would exceed the 48,000-character total context limit.",
  aggregate_token_limit_exceeded: "Adding that would exceed the 12,000-token total context limit.",
  content_changed: "This item's content has changed since it was selected — remove and re-add it.",
  project_root_not_resolvable: "This project's folder is no longer resolvable.",
};

export function describeContextError(code: string): string {
  return CONTEXT_ERROR_MESSAGES[code] || "That context item couldn't be used.";
}

export const api = {
  listProjects: () => fetch("/api/projects").then((r) => json<{ projects: Project[] }>(r)),
  addProject: (path: string) =>
    fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) }).then((r) =>
      json<{ project: Project }>(r)
    ),
  listSessions: (projectId: string) =>
    fetch(`/api/sessions?project_id=${encodeURIComponent(projectId)}`).then((r) => json<{ sessions: ConversationSummary[] }>(r)),

  listDir: (projectId: string, path: string) =>
    fetch(`/api/fs/list?project_id=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`).then((r) =>
      json<{ path: string; entries: FsEntry[] }>(r)
    ),
  readFile: (projectId: string, path: string) =>
    fetch(`/api/fs/read?project_id=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`).then((r) =>
      json<{ path: string; content: string; encoding: "utf8" | "base64" }>(r)
    ),
  search: (projectId: string, q: string) =>
    fetch(`/api/search?project_id=${encodeURIComponent(projectId)}&q=${encodeURIComponent(q)}`).then((r) =>
      json<{ matches: SearchMatch[] }>(r)
    ),

  gitStatus: (projectId: string) =>
    fetch(`/api/git/status?project_id=${encodeURIComponent(projectId)}`).then((r) => json<GitStatusResponse>(r)),
  gitLog: (projectId: string, limit?: number, skip?: number) =>
    fetch(
      `/api/git/log?project_id=${encodeURIComponent(projectId)}${limit ? `&limit=${limit}` : ""}${skip ? `&skip=${skip}` : ""}`
    ).then((r) => json<GitLogResponse>(r)),
  gitDiff: (projectId: string, path?: string) =>
    fetch(`/api/git/diff?project_id=${encodeURIComponent(projectId)}${path ? `&path=${encodeURIComponent(path)}` : ""}`).then((r) =>
      json<GitDiffResponse>(r)
    ),

  listContext: (sessionId: string) =>
    fetch(`/api/context?session_id=${encodeURIComponent(sessionId)}`).then((r) => json<ContextListResponse>(r)),
  addFileSnippetContext: (sessionId: string, projectId: string, path: string, startLine: number, endLine: number) =>
    fetch("/api/context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, project_id: projectId, kind: "file_snippet", path, start_line: startLine, end_line: endLine }),
    }).then((r) => json<{ item: ContextItem }>(r)),
  addGitHunkContext: (sessionId: string, projectId: string, path: string, hunkHeader: string, hunkIndex: number) =>
    fetch("/api/context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, project_id: projectId, kind: "git_diff_hunk", path, hunk_header: hunkHeader, hunk_index: hunkIndex }),
    }).then((r) => json<{ item: ContextItem }>(r)),
  removeContext: (sessionId: string, id: string) =>
    fetch(`/api/context?session_id=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) =>
      json<{ removed: number }>(r)
    ),
  clearContext: (sessionId: string) =>
    fetch(`/api/context?session_id=${encodeURIComponent(sessionId)}&all=1`, { method: "DELETE" }).then((r) => json<{ removed: number }>(r)),
  attachContext: (sessionId: string, ids: string[]) =>
    fetch("/api/context/attach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, ids }),
    }).then((r) => json<{ attached: Array<{ id: string; kind: string; path: string; rangeLabel: string; charCount: number; tokenEstimate: number }> }>(r)),
  detachContext: (sessionId: string) =>
    fetch("/api/context/detach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId }),
    }).then((r) => json<{ detached: boolean }>(r)),

  createHermesSession: (projectId: string) =>
    fetch("/api/hermes/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_id: projectId }) }).then(
      (r) => json<{ session_id: string; hermes_session_id: string }>(r)
    ),
  submitPrompt: (sessionId: string, text: string) =>
    fetch("/api/hermes/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: sessionId, text }) }).then(
      (r) => json<{ status: string }>(r)
    ),
  interruptSession: (sessionId: string) =>
    fetch("/api/hermes/interrupt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: sessionId }) }).then(
      (r) => json<{ status: string }>(r)
    ),

  multimodelPreview: (projectId: string, topic: string) =>
    fetch("/api/multimodel/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, topic }),
    }).then((r) => json<{ will_send: any[]; will_not_send: string[]; start_available: boolean; start_blocked_reason: string }>(r)),
};
