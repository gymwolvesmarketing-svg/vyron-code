#!/usr/bin/env node
/**
 * Copies electron/'s static renderer assets (HTML/CSS) into dist-electron/electron/,
 * alongside the tsc-compiled main/preload/renderer JS. Build-time only, cross-platform
 * (plain Node `fs`, no shell copy command, no new dependency) —
 * VYRON_CODE_V02_D02D_MINIMAL_LOCAL_RENDERER_AUTHORIZATION.
 * This script has no runtime/IPC role of any kind — it never runs as part of the shipped
 * desktop app, only as a `build:electron` step alongside `tsc -p tsconfig.electron.json`.
 *
 * Destination note (VYRON_CODE_V02_D03_NATIVE_FOLDER_PICKER_AND_WORKSPACE_GRANT_AUTHORIZATION):
 * `tsconfig.electron.json` sets `rootDir: "."` (repo root), because `electron/workspace-grant.ts`
 * imports `../lib/canonicalPath` — a real, necessary cross-directory dependency (the same
 * shared canonical-root/root-policy validation every other part of this codebase uses, reused
 * unchanged rather than reimplemented). That makes tsc's compiled output mirror the source
 * tree under `dist-electron/` (`dist-electron/electron/*.js`, `dist-electron/lib/canonicalPath.js`)
 * instead of a flat `dist-electron/*.js` — so the static assets must land in
 * `dist-electron/electron/` too, next to `main.js`/`preload.js`, for `main.ts`'s
 * `path.join(__dirname, "preload.js"|"renderer.html")` references to keep resolving correctly.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(ROOT, "electron");
const DEST_DIR = path.join(ROOT, "dist-electron", "electron");
const ASSETS = ["renderer.html", "renderer.css", "assets/logo.png", "assets/mark.png", "assets/icon.png"];

function main() {
  fs.mkdirSync(DEST_DIR, { recursive: true });
  for (const name of ASSETS) {
    const src = path.join(SRC_DIR, name);
    if (!fs.existsSync(src)) {
      console.error(`Missing expected renderer asset: electron/${name}`);
      process.exitCode = 1;
      return;
    }
    fs.mkdirSync(path.dirname(path.join(DEST_DIR, name)), { recursive: true });
    fs.copyFileSync(src, path.join(DEST_DIR, name));
    console.log(`Copied electron/${name} -> dist-electron/electron/${name}`);
  }
}

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
  main();
}
