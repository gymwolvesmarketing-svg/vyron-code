/**
 * Main-process-only, in-memory workspace grant service —
 * VYRON_CODE_V02_D03_NATIVE_FOLDER_PICKER_AND_WORKSPACE_GRANT_AUTHORIZATION.
 *
 * Owns the one thing D-03 is allowed to own: a single, process-memory-only "current
 * workspace" grant, established only via an explicit user-triggered native directory pick
 * (electron/main.ts's `workspace:pickDirectory` handler calls `pickDirectory` below), and
 * validated through the exact same `lib/canonicalPath.ts` logic every other part of this
 * codebase already relies on (`resolveCanonicalRoot` + `checkRootPolicy` — no weaker
 * parallel validation is invented here; symlink/reparse-point resolution is inherited
 * unchanged from `resolveCanonicalRoot`'s own `fs.realpathSync.native` call).
 *
 * The absolute/canonical root path never leaves this module. Every exported function
 * returns only a `WorkspaceGrantState` — an opaque `workspaceId`, a safe `displayName`
 * (the folder's own base name), and `readOnly: true`. No absolute path, parent path,
 * sibling path, raw filesystem error, or raw native-dialog result is ever returned.
 *
 * No persistence of any kind — SQLite, localStorage, disk, or otherwise. An app restart (or
 * simply calling `clearCurrent`) forgets the grant, by design; D-03 has no "recent
 * workspaces" feature (that is reserved, unimplemented future work — see
 * `FUTURE_IPC_CHANNELS.WORKSPACE_CLEAR_RECENT` in shared-ipc-contract.ts, which this module
 * never reads or writes).
 */
import { app, dialog, type BrowserWindow } from "electron";
import path from "node:path";
import crypto from "node:crypto";
import { resolveCanonicalRoot, checkRootPolicy } from "../lib/canonicalPath";
import type { WorkspaceGrantState, WorkspaceGrantResultState } from "./shared-ipc-contract";

type CurrentGrant = { workspaceId: string; canonicalRoot: string; displayName: string };

// Module-scope, process-memory-only — intentionally never written to disk, SQLite,
// localStorage, or any other persistence mechanism.
let currentGrant: CurrentGrant | null = null;

function stateFor(state: WorkspaceGrantResultState): WorkspaceGrantState {
  if (state === "granted" && currentGrant) {
    return { state: "granted", workspaceId: currentGrant.workspaceId, displayName: currentGrant.displayName, readOnly: true };
  }
  return { state, workspaceId: null, displayName: null, readOnly: true };
}

/**
 * Opens the native directory picker (main process only, parented to the given window),
 * validates the selection through the existing canonical-root + root-policy logic, and —
 * only if both pass — replaces the current in-memory grant. Cancellation and policy denial
 * are both normal, non-throwing results; neither creates or changes a grant.
 */
export async function pickDirectory(window: BrowserWindow): Promise<WorkspaceGrantState> {
  let result: Electron.OpenDialogReturnValue;
  try {
    result = await dialog.showOpenDialog(window, {
      title: "Open folder…",
      properties: ["openDirectory"],
    });
  } catch (err) {
    // Development-only, safe diagnostic — VYRON_CODE_V02_D03_NATIVE_FOLDER_PICKER_REAL_RUNTIME_FIX_REPORT.
    // Logs only the error's own class name (e.g. "Error", "TypeError") — never `err.message`,
    // which could contain a filesystem path — so a genuine native-dialog failure is
    // distinguishable from a different, unexpected exception while iterating locally. Silent
    // (no console output at all) in a packaged build.
    if (!app.isPackaged) {
      console.error("[workspace] native folder-picker dialog failed:", err instanceof Error ? err.constructor.name : typeof err);
    }
    return stateFor("unavailable");
  }

  const rawSelection = result.filePaths[0];
  if (result.canceled || !rawSelection) {
    return stateFor("cancelled");
  }

  const canonicalRoot = resolveCanonicalRoot(rawSelection);
  if (!canonicalRoot) {
    return stateFor("denied");
  }

  const policy = checkRootPolicy(canonicalRoot);
  if (!policy.allowed) {
    return stateFor("denied");
  }

  currentGrant = {
    workspaceId: crypto.randomUUID(),
    canonicalRoot,
    // Never falls back to `canonicalRoot` itself — that would leak the absolute path into a
    // renderer-visible field. `checkRootPolicy` above already rejects drive roots (the only
    // case where `path.basename` could be empty), but this fallback stays generic regardless,
    // so no future change to that policy could silently reopen a path-leak here.
    displayName: path.basename(canonicalRoot) || "Selected folder",
  };
  return stateFor("granted");
}

/** Returns the current grant's safe state, or `no_workspace` if none exists. */
export function getCurrent(): WorkspaceGrantState {
  return stateFor(currentGrant ? "granted" : "no_workspace");
}

/**
 * Removes the current in-memory grant only. Never touches the filesystem (no delete, no
 * write), never touches SQLite, and has no effect on any future "recent workspaces" feature.
 */
export function clearCurrent(): WorkspaceGrantState {
  currentGrant = null;
  return stateFor("no_workspace");
}

/**
 * Main-process-INTERNAL accessor for the current grant's canonical root — VYRON_CODE_V02_MILESTONE_A_RUNTIME_STABILITY_AND_READONLY_WORKSPACE_AUTHORIZATION.
 *
 * This is the one place `electron/workspaceExplorer.ts`, `electron/workspaceFileViewer.ts`,
 * `electron/workspaceSearch.ts`, and `electron/workspaceGit.ts` obtain the root to validate
 * requests against. It is NEVER imported by `electron/preload.ts` and NEVER part of any
 * `WorkspaceGrantState`/IPC-returned value — the canonical/absolute path still never leaves
 * this module's own process boundary into anything renderer-visible.
 *
 * Re-resolves the root fresh on every call (the same TOCTOU defense `lib/fsGuard.ts`'s
 * `guardProjectPath` already uses for the web app) rather than trusting the value stored at
 * grant time — the directory could have been deleted, renamed, or replaced since. If the
 * fresh resolution no longer matches the originally granted root exactly, access is denied
 * (returns `null`) rather than silently granting access to whatever now occupies that path.
 */
export function getCurrentCanonicalRoot(): string | null {
  if (!currentGrant) return null;
  const fresh = resolveCanonicalRoot(currentGrant.canonicalRoot);
  if (!fresh || fresh !== currentGrant.canonicalRoot) return null;
  return fresh;
}
