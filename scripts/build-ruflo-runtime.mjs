#!/usr/bin/env node
/**
 * Builds the Ruflo runtime that ships inside the Vyron Code installer (build/ruflo-runtime).
 *
 * Build-time only (developer machine): it installs the pinned, published `ruflo` package with all of its
 * dependencies and native modules, removes only the native binaries that can never load on Windows x64
 * (other operating systems / CPU architectures), and copies a plain Node.js executable next to it so the
 * app can run Ruflo without any Node.js, npm or PowerShell on the user's computer. No feature is removed.
 *
 *   node scripts/build-ruflo-runtime.mjs            # build (or rebuild) build/ruflo-runtime
 *   node scripts/build-ruflo-runtime.mjs --verify   # only smoke-test an existing runtime
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const RUFLO_VERSION = "3.44.0";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RUNTIME_DIR = path.join(ROOT, "build", "ruflo-runtime");

/**
 * Pure decision: should this path (relative to the runtime's node_modules, `/`-separated) be removed because
 * it holds a native binary for another platform/architecture than Windows x64? Kept as a pure function so
 * a test can pin the rules.
 */
export function isForeignPlatformPath(relativePath) {
  const p = relativePath.split(path.sep).join("/");
  const slim = /^@agntcy\/slim-bindings-(.+)$/.exec(p);
  if (slim) return slim[1] !== "win32-x64-msvc";
  const onnx = /^onnxruntime-node\/bin\/napi-v\d+\/(darwin|linux|win32\/arm64)(\/|$)/.exec(p);
  if (onnx) return true;
  const argon = /^argon2\/prebuilds\/([^/]+)$/.exec(p);
  if (argon) return argon[1] !== "win32-x64";
  const ruvector = /^@ruvector\/[^/]+\/npm\/([^/]+)$/.exec(p);
  if (ruvector) return !/^win32-x64/.test(ruvector[1]);
  return false;
}

function walkDirs(base, relative, depth, visit) {
  if (depth < 0) return;
  let entries;
  try {
    entries = fs.readdirSync(path.join(base, relative), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const rel = relative ? path.join(relative, entry.name) : entry.name;
    if (visit(rel)) continue;
    walkDirs(base, rel, depth - 1, visit);
  }
}

export function pruneForeignBinaries(nodeModules) {
  const removed = [];
  walkDirs(nodeModules, "", 6, (rel) => {
    if (!isForeignPlatformPath(rel)) return false;
    fs.rmSync(path.join(nodeModules, rel), { recursive: true, force: true });
    removed.push(rel);
    return true;
  });
  return removed;
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
    }
  }
  return total;
}

export const RUFLO_TEXT_LIMIT = 200_000;
const VALIDATE_INPUT = ["node_modules", "@claude-flow", "cli-core", "dist", "src", "mcp-tools", "validate-input.js"];

/**
 * Ruflo's `agent_execute` refuses any prompt over 10,000 characters (its `validateText` default), which made every long
 * Manager task or tool run fail at once ("Yanıt alınamadı"). The runtime is a private copy that only Vyron Code talks to,
 * so the default is raised here, once, in the copy that ships. Idempotent; throws when the file no longer has the
 * expected shape (a Ruflo update) so a silent regression cannot ship.
 */
export function ensureRufloTextLimit(dir = RUNTIME_DIR) {
  const file = path.join(dir, ...VALIDATE_INPUT);
  const source = fs.readFileSync(file, "utf8");
  const original = "export function validateText(value, label, maxLen = 10_000) {";
  const patched = "export function validateText(value, label, maxLen = " + String(RUFLO_TEXT_LIMIT).replace(/\B(?=(\d{3})+(?!\d))/g, "_") + ") {";
  if (source.includes(patched)) return false;
  if (!source.includes(original)) throw new Error("Ruflo validateText changed: the prompt limit patch no longer applies");
  fs.writeFileSync(file, source.replace(original, patched));
  return true;
}

export function verifyRuntime(dir = RUNTIME_DIR) {
  const node = path.join(dir, "node.exe");
  const cli = path.join(dir, "node_modules", "ruflo", "bin", "ruflo.js");
  if (!fs.existsSync(node) || !fs.existsSync(cli)) throw new Error("Ruflo runtime is incomplete (node.exe or ruflo.js missing)");
  ensureRufloTextLimit(dir);
  const version = execFileSync(node, [cli, "--version"], { encoding: "utf8", windowsHide: true, timeout: 120_000 }).trim();
  if (!version.includes(RUFLO_VERSION)) throw new Error("unexpected Ruflo version: " + version);
  // The native modules that Ruflo's memory/vector features depend on must load under the bundled Node.
  execFileSync(node, ["-e", "require('better-sqlite3'); require('onnxruntime-node'); process.stdout.write('natives-ok')"], {
    cwd: path.join(dir, "node_modules", "ruflo"),
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  return version;
}

function build() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(RUNTIME_DIR, "package.json"),
    JSON.stringify({ name: "vyron-ruflo-runtime", version: "1.0.0", private: true, dependencies: { ruflo: RUFLO_VERSION } }, null, 2) + "\n",
  );
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(npm, ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: RUNTIME_DIR, stdio: "inherit", shell: process.platform === "win32" });
  const removed = pruneForeignBinaries(path.join(RUNTIME_DIR, "node_modules"));
  console.log("removed " + String(removed.length) + " foreign-platform binary folders");
  fs.copyFileSync(process.execPath, path.join(RUNTIME_DIR, "node.exe"));
  console.log("runtime size: " + String(Math.round(dirSize(RUNTIME_DIR) / (1024 * 1024))) + " MB; " + verifyRuntime());
}

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
  if (process.argv.includes("--verify")) console.log(verifyRuntime());
  else build();
}
