/**
 * Centralized, auditable Electron hardening policy — the single source of truth for
 * BrowserWindow security configuration and navigation/new-window denial behavior.
 * VYRON_CODE_V02_D02B_ELECTRON_HARDENED_SCAFFOLD_AUTHORIZATION.
 *
 * This file intentionally imports nothing beyond Electron's own type surface — no `fs`,
 * `child_process`, `shell`, `os`, or `process.env` access, and no token/credential logic of
 * any kind. It defines policy only; electron/main.ts applies it, and never overrides it
 * inline (every BrowserWindow this codebase creates must spread HARDENED_WEB_PREFERENCES
 * rather than restate its own webPreferences object).
 */
import type { WebPreferences } from "electron";

export const HARDENED_WEB_PREFERENCES: WebPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
  allowRunningInsecureContent: false,
  // enableRemoteModule is intentionally absent — the @electron/remote module is never
  // installed or required (see VYRON_CODE_V02_D02A_ELECTRON_DEPENDENCY_DUE_DILIGENCE_REPORT.md).
};

/**
 * Allowed renderer-navigation origin prefixes — empty by design (deny-by-default). No
 * origin is approved in this scaffold phase; populating this is a later, separately
 * authorized decision once a real local-content/loopback-runtime origin exists.
 */
export const ALLOWED_NAVIGATION_ORIGINS: readonly string[] = [];

export function isNavigationAllowed(targetUrl: string): boolean {
  return ALLOWED_NAVIGATION_ORIGINS.some((origin) => targetUrl.startsWith(origin));
}

/**
 * New-window creation is always denied in v0.2 — no popup/child-window capability is
 * approved by any phase of the desktop migration plan (VYRON_CODE_V02_DESKTOP_ARCHITECTURE_DECISION.md).
 */
export function isNewWindowAllowed(_targetUrl: string): boolean {
  return false;
}
