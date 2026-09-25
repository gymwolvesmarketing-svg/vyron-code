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
import { getCurrent, getCurrentCanonicalRoot, pickDirectory, clearCurrent } from "./workspace-grant";
import { listDir, readFile, resolveWritable, runCommand, writeFile } from "./toolExecutors";
import { runToolLoop, type ToolLoopDeps, type ToolLoopResult, type ToolWorkspace } from "./toolLoop";
import type { ApprovalChoice, ApprovalRequest, ChatMessage, ToolCall } from "./toolPolicy";

export const PERMISSIONS_FILE = "tool-permissions.json";
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
  getWorkspace(): WorkspaceInfo;
  pickWorkspace(): Promise<WorkspaceInfo>;
  clearWorkspace(): WorkspaceInfo;
  clearPermissions(): WorkspaceInfo;
}

export function createProductionToolRunner(getWindow: () => BrowserWindow | null): ToolRunner {
  const store = createPermissionStore(path.join(app.getPath("userData"), PERMISSIONS_FILE));

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
        fileExists(relative) {
          const root = getCurrentCanonicalRoot();
          if (!root) return null;
          const target = resolveWritable(root, relative);
          return target.ok ? target.existed : null;
        },
      };
      return runToolLoop(deps, task);
    },
    getWorkspace: info,
    async pickWorkspace() {
      const window = getWindow();
      if (window) await pickDirectory(window);
      return info();
    },
    clearWorkspace() {
      clearCurrent();
      return info();
    },
    clearPermissions() {
      store.clear();
      return info();
    },
  };
}
