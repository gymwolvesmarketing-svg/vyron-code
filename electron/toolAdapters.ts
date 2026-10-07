/**
 * Electron adapters for approved tool use - VYRON_CODE_APPROVED_TOOLS. Main process only.
 *
 * - The workspace folder comes from the native folder picker (electron/workspace-grant.ts); the renderer only ever
 *   learns its display name.
 * - Approval is a NATIVE dialog owned by the main process (never a page the renderer could draw or answer), with the
 *   three choices "Bir kez izin ver", "Her zaman izin ver" and "Reddet". Closing the dialog is a refusal.
 * - "Her zaman izin ver" is saved in a main-only file in the app's data folder, scoped to the granted folder (and, for
 *   commands, to the exact command text). The renderer can count and clear those permissions, never read or add them.
 */
import { app, dialog, type BrowserWindow } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getCurrent, getCurrentCanonicalRoot, pickDirectory, clearCurrent, restoreGrant } from "./workspace-grant";
import { listDir, projectOverview, readFile, resolveWritable, runCommand, writeFile } from "./toolExecutors";
import { createBrowserDriver, type BrowserDriver } from "./browserTool";
import { createElectronBrowserPage } from "./browserWindow";
import { createProductionDeepResearch } from "./deepResearchAdapter";
import type { DeepResearch } from "./deepResearch";
import { runToolLoop, type ToolLoopDeps, type ToolLoopResult, type ToolWorkspace } from "./toolLoop";
import type { ApprovalChoice, ApprovalRequest, ChatMessage, ToolCall } from "./toolPolicy";

export const PERMISSIONS_FILE = "tool-permissions.json";
export const PROJECT_FOLDERS_FILE = "project-folders.json";
const MAX_PROJECT_FOLDERS = 200;

/** A project id is a plain slug (the same rule the renderer and the task request use); anything else is ignored. */
export function isProjectId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
}

export interface ProjectFolderStore {
  get(projectId: string): string | null;
  set(projectId: string, folder: string): void;
  remove(projectId: string): void;
}

/**
 * Which folder belongs to which project. Main-only file in the app data folder: the renderer can neither read a path from
 * it nor write one into it; a folder gets in only after the user picked it in the native dialog. A corrupt file reads as empty.
 */
export function createProjectFolderStore(filePath: string): ProjectFolderStore {
  let map: Map<string, string> | null = null;
  function load(): Map<string, string> {
    if (map) return map;
    map = new Map<string, string>();
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const roots = typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>).version === 1 ? (parsed as Record<string, unknown>).roots : null;
      if (typeof roots === "object" && roots !== null && !Array.isArray(roots)) {
        for (const [id, folder] of Object.entries(roots as Record<string, unknown>)) {
          if (isProjectId(id) && typeof folder === "string" && folder.length > 0 && folder.length < 1000 && map.size < MAX_PROJECT_FOLDERS) map.set(id, folder);
        }
      }
    } catch {
      // Missing or unreadable: no remembered folders.
    }
    return map;
  }
  function save(): void {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ version: 1, roots: Object.fromEntries(load()) }), "utf8");
    } catch {
      // A failed save only means the folder is not remembered.
    }
  }
  return {
    get: (projectId) => load().get(projectId) ?? null,
    set(projectId, folder) {
      const entries = load();
      if (!entries.has(projectId) && entries.size >= MAX_PROJECT_FOLDERS) return;
      entries.set(projectId, folder);
      save();
    },
    remove(projectId) {
      if (load().delete(projectId)) save();
    },
  };
}
const MAX_PERMISSIONS = 500;

export interface PermissionStore {
  has(key: string): boolean;
  add(key: string): void;
  clear(): number;
  count(): number;
}

/** Pure-ish store over an injected file path; every read is validated and a corrupt file reads as empty. */
export function createPermissionStore(filePath: string): PermissionStore {
  let keys: Set<string> | null = null;
  function load(): Set<string> {
    if (keys) return keys;
    keys = new Set<string>();
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>).version === 1) {
        const list = (parsed as Record<string, unknown>).keys;
        if (Array.isArray(list)) for (const item of list) if (typeof item === "string" && item.length < 1400 && keys.size < MAX_PERMISSIONS) keys.add(item);
      }
    } catch {
      // Missing or unreadable: no saved permissions.
    }
    return keys;
  }
  function save(): void {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ version: 1, keys: Array.from(load()) }), "utf8");
    } catch {
      // A failed save only means the permission is not remembered.
    }
  }
  return {
    has: (key) => load().has(key),
    add(key) {
      const set = load();
      if (set.size >= MAX_PERMISSIONS) return;
      set.add(key);
      save();
    },
    clear() {
      const count = load().size;
      keys = new Set<string>();
      save();
      return count;
    },
    count: () => load().size,
  };
}

export function workspaceKey(canonicalRoot: string): string {
  return crypto.createHash("sha256").update(canonicalRoot.toLowerCase()).digest("hex").slice(0, 16);
}

export interface WorkspaceInfo {
  readonly folderName: string | null;
  readonly alwaysCount: number;
}

export interface ToolRunner {
  run(task: string, ask: (messages: readonly ChatMessage[]) => Promise<string | null>): Promise<ToolLoopResult>;
  /** With a project id, switches to that project's remembered folder (or to none). */
  getWorkspace(projectId?: unknown): WorkspaceInfo;
  /** With a project id, remembers the picked folder for that project. */
  pickWorkspace(projectId?: unknown): Promise<WorkspaceInfo>;
  clearWorkspace(projectId?: unknown): WorkspaceInfo;
  clearPermissions(): WorkspaceInfo;
  /** Closes the agent browser window (app shutdown). */
  close(): void;
}

export function createProductionToolRunner(
  getWindow: () => BrowserWindow | null,
  // The browser window is only created when a task first opens a page, so building the driver costs nothing.
  browser: BrowserDriver = createBrowserDriver(() => createElectronBrowserPage()),
  research: DeepResearch = createProductionDeepResearch(),
): ToolRunner {
  const store = createPermissionStore(path.join(app.getPath("userData"), PERMISSIONS_FILE));
  const folders = createProjectFolderStore(path.join(app.getPath("userData"), PROJECT_FOLDERS_FILE));

  function currentWorkspace(): ToolWorkspace | null {
    const root = getCurrentCanonicalRoot();
    if (!root) return null;
    const grant = getCurrent();
    return { key: workspaceKey(root), folderName: grant.displayName ?? "Seçili klasör" };
  }

  async function approve(request: ApprovalRequest): Promise<ApprovalChoice> {
    if (store.has(request.key)) return "always";
    const window = getWindow();
    const options: Electron.MessageBoxOptions = {
      type: "question",
      title: request.title,
      message: request.message,
      detail: request.detail,
      buttons: ["Bir kez izin ver", "Her zaman izin ver", "Reddet"],
      defaultId: 2,
      cancelId: 2,
      noLink: true,
    };
    try {
      const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
      if (result.response === 0) return "once";
      if (result.response === 1) {
        store.add(request.key);
        return "always";
      }
      return "deny";
    } catch {
      return "deny";
    }
  }

  async function execute(call: ToolCall): Promise<{ ok: boolean; text: string }> {
    const root = getCurrentCanonicalRoot();
    if (!root) return { ok: false, text: "Çalışma klasörü seçili değil." };
    switch (call.tool) {
      case "list_dir":
        return listDir(root, call.path);
      case "read_file":
        return readFile(root, call.path);
      case "write_file":
        return writeFile(root, call.path, call.content);
      case "run_command":
        return runCommand(root, call.command);
      case "deep_research":
        return research.run(call.query, call.depth);
      case "browser_open":
        return browser.open(call.url);
      case "browser_read":
        return browser.read();
      case "browser_click":
        return browser.click(call.index);
      case "browser_type":
        return browser.type(call.index, call.text, call.submit);
    }
  }

  function info(): WorkspaceInfo {
    const grant = getCurrent();
    return { folderName: grant.state === "granted" ? grant.displayName : null, alwaysCount: store.count() };
  }

  return {
    run(task, ask) {
      const deps: ToolLoopDeps = {
        ask,
        workspace: currentWorkspace,
        approve,
        execute,
        overview() {
          const root = getCurrentCanonicalRoot();
          return root ? projectOverview(root) : null;
        },
        browserTarget(call) {
          return call.tool === "browser_click" || call.tool === "browser_type" ? browser.target(call.index) : null;
        },
        fileExists(relative) {
          const root = getCurrentCanonicalRoot();
          if (!root) return null;
          const target = resolveWritable(root, relative);
          return target.ok ? target.existed : null;
        },
      };
      return runToolLoop(deps, task);
    },
    getWorkspace(projectId) {
      // Opening a project brings back the folder it was last given (or none); no project = the grant stays as it is.
      if (isProjectId(projectId)) {
        const stored = folders.get(projectId);
        if (stored) restoreGrant(stored);
        else clearCurrent();
      }
      return info();
    },
    async pickWorkspace(projectId) {
      const window = getWindow();
      if (window) {
        const result = await pickDirectory(window);
        const root = result.state === "granted" ? getCurrentCanonicalRoot() : null;
        if (root && isProjectId(projectId)) folders.set(projectId, root);
      }
      return info();
    },
    clearWorkspace(projectId) {
      if (isProjectId(projectId)) {
        // Forgetting one project's folder drops the current grant only when that grant is this very folder.
        const stored = folders.get(projectId);
        folders.remove(projectId);
        if (stored === null || stored === getCurrentCanonicalRoot()) clearCurrent();
      } else {
        clearCurrent();
      }
      return info();
    },
    clearPermissions() {
      store.clear();
      return info();
    },
    close() {
      browser.close();
    },
  };
}
