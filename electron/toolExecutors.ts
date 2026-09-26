/**
 * Fixed implementations of the four tool actions - VYRON_CODE_APPROVED_TOOLS. Main process only.
 *
 * Every action is confined to the canonical workspace root the user picked in the native folder dialog:
 *   - existing paths go through lib/canonicalPath.ts's resolveCanonicalPath (relative only, no `..` escape, symlinks and
 *     junctions resolved, secrets such as .env / .git / keys / node_modules refused);
 *   - a path that does not exist yet (a new file) is accepted only when its deepest existing ancestor resolves
 *     inside the root and no segment is denied or `..`;
 *   - a command runs with cmd.exe (`/d /s /c`), shell:false, working directory = the root, an allowlisted environment
 *     (no credential of any kind), a hard timeout and a bounded output.
 * The user's approval (native dialog, electron/toolAdapters.ts) happens BEFORE write_file / run_command reach this file.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveCanonicalPath } from "../lib/canonicalPath";
import { runTaskkill } from "./localAiAdapters";
import { MAX_TOOL_OUTPUT_CHARS, MAX_WRITE_CHARS, boundOutput, isCatastrophicCommand } from "./toolPolicy";

export interface ExecResult {
  readonly ok: boolean;
  readonly text: string;
}

export const COMMAND_TIMEOUT_MS = 60_000;
const MAX_READ_BYTES = 200_000;
const MAX_LIST_ENTRIES = 200;
const MAX_CAPTURE_CHARS = 20_000;

const fail = (text: string): ExecResult => ({ ok: false, text });

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function listDir(root: string, relative: string): ExecResult {
  const resolved = resolveCanonicalPath(root, relative);
  if (!resolved.ok) return fail("Bu yola erişilemiyor (" + resolved.reason + ").");
  if (!isDirectory(resolved.absolutePath)) return fail("Bu yol bir klasör değil.");
  try {
    const entries = fs.readdirSync(resolved.absolutePath, { withFileTypes: true }).slice(0, MAX_LIST_ENTRIES);
    const lines = entries.map((entry) => (entry.isDirectory() ? entry.name + "/" : entry.name));
    return { ok: true, text: lines.length === 0 ? "(boş klasör)" : boundOutput(lines.join("\n")) };
  } catch {
    return fail("Klasör okunamadı.");
  }
}

const OVERVIEW_SKIP = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".turbo", ".cache", "coverage", "__pycache__", ".venv", "venv", "target", ".idea", ".vscode"]);
/** Names that are never shown in the overview even though a directory listing would name them. */
function overviewHidden(name: string): boolean {
  return OVERVIEW_SKIP.has(name) || /^\.env/i.test(name) || /\.(pem|key|p12|pfx)$/i.test(name);
}
const OVERVIEW_MAX_ENTRIES = 150;
const OVERVIEW_MAX_CHARS = 5_000;
const OVERVIEW_KEY_FILES = ["README.md", "readme.md", "package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "pom.xml"];
const OVERVIEW_KEY_FILE_CHARS = 1_200;

/**
 * A bounded, read-only picture of the workspace (two levels of the tree, without the usual generated/vendor folders, and the
 * head of the main manifest files). Taken by the main process itself so the model can start from the real project, like a
 * coding agent that opens a folder. Secrets and other denied names never appear: everything goes through listDir/readFile.
 */
export function projectOverview(root: string): string | null {
  const lines: string[] = [];
  const top = listDir(root, ".");
  if (!top.ok) return null;
  for (const entry of top.text.split("\n")) {
    if (lines.length >= OVERVIEW_MAX_ENTRIES) break;
    if (entry.length === 0 || entry === "(boş klasör)") continue;
    const name = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    if (overviewHidden(name)) continue;
    lines.push(entry);
    if (entry.endsWith("/")) {
      const inner = listDir(root, name);
      if (inner.ok) {
        for (const child of inner.text.split("\n")) {
          if (lines.length >= OVERVIEW_MAX_ENTRIES) break;
          const childName = child.endsWith("/") ? child.slice(0, -1) : child;
          if (child.length === 0 || overviewHidden(childName)) continue;
          lines.push("  " + name + "/" + child);
        }
      }
    }
  }
  let text = lines.length === 0 ? "(boş klasör)" : lines.join("\n");
  for (const keyFile of OVERVIEW_KEY_FILES) {
    if (!top.text.split("\n").includes(keyFile)) continue;
    const content = readFile(root, keyFile);
    if (content.ok) text += "\n\n--- " + keyFile + " (başı) ---\n" + content.text.slice(0, OVERVIEW_KEY_FILE_CHARS);
    if (text.length >= OVERVIEW_MAX_CHARS) break;
  }
  return text.slice(0, OVERVIEW_MAX_CHARS);
}

export function readFile(root: string, relative: string): ExecResult {
  const resolved = resolveCanonicalPath(root, relative);
  if (!resolved.ok) return fail("Bu dosyaya erişilemiyor (" + resolved.reason + ").");
  try {
    const stat = fs.statSync(resolved.absolutePath);
    if (!stat.isFile()) return fail("Bu yol bir dosya değil.");
    if (stat.size > MAX_READ_BYTES) return fail("Dosya çok büyük (en fazla " + String(MAX_READ_BYTES) + " bayt).");
    const buffer = fs.readFileSync(resolved.absolutePath);
    if (buffer.indexOf(0) >= 0) return fail("İkili dosya okunamaz.");
    return { ok: true, text: boundOutput(buffer.toString("utf8")) };
  } catch {
    return fail("Dosya okunamadı.");
  }
}

export type WritablePath = { readonly ok: true; readonly absolute: string; readonly existed: boolean } | { readonly ok: false; readonly reason: string };

/** Resolves where a file may be written: inside the root, never through a denied name, `..`, an absolute path or a link. */
export function resolveWritable(root: string, relative: string): WritablePath {
  const normalized = relative.replace(/\\/g, "/");
  if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) return { ok: false, reason: "mutlak yol kabul edilmez" };
  const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) return { ok: false, reason: "geçersiz yol" };
  if (segments.some((segment) => segment === ".." || /[<>:"|?*]/.test(segment) || /[. ]$/.test(segment))) return { ok: false, reason: "geçersiz yol" };
  const whole = resolveCanonicalPath(root, segments.join("/"));
  if (whole.ok) {
    if (isDirectory(whole.absolutePath)) return { ok: false, reason: "bu yol bir klasör" };
    return { ok: true, absolute: whole.absolutePath, existed: true };
  }
  if (whole.reason !== "not_found") return { ok: false, reason: whole.reason };
  // A new file: find the deepest ancestor that exists and check that one.
  for (let keep = segments.length - 1; keep >= 0; keep -= 1) {
    const ancestor = keep === 0 ? { ok: true as const, absolutePath: root, relativePath: "." } : resolveCanonicalPath(root, segments.slice(0, keep).join("/"));
    if (!ancestor.ok) {
      if (ancestor.reason === "not_found") continue;
      return { ok: false, reason: ancestor.reason };
    }
    if (!isDirectory(ancestor.absolutePath)) return { ok: false, reason: "üst yol bir klasör değil" };
    return { ok: true, absolute: path.join(ancestor.absolutePath, ...segments.slice(keep)), existed: false };
  }
  return { ok: false, reason: "geçersiz yol" };
}

export function writeFile(root: string, relative: string, content: string): ExecResult {
  if (content.length > MAX_WRITE_CHARS) return fail("İçerik çok büyük.");
  const target = resolveWritable(root, relative);
  if (!target.ok) return fail("Bu yola yazılamaz (" + target.reason + ").");
  try {
    fs.mkdirSync(path.dirname(target.absolute), { recursive: true });
    fs.writeFileSync(target.absolute, content, "utf8");
    return { ok: true, text: (target.existed ? "Dosyanın üzerine yazıldı: " : "Dosya oluşturuldu: ") + relative + " (" + String(content.length) + " karakter)" };
  } catch {
    return fail("Dosya yazılamadı.");
  }
}

/** The complete environment a command gets: no credential, no Hermes/Ruflo value, only what a shell needs. */
export function commandEnvironment(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const keep = ["SystemRoot", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "NUMBER_OF_PROCESSORS", "OS", "PROCESSOR_ARCHITECTURE"];
  const env: Record<string, string | undefined> = {};
  for (const key of keep) {
    const found = Object.keys(source).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (found && source[found] !== undefined) env[key] = source[found];
  }
  return env;
}

export function runCommand(root: string, command: string, timeoutMs: number = COMMAND_TIMEOUT_MS): Promise<ExecResult> {
  if (isCatastrophicCommand(command)) return Promise.resolve(fail("Bu komut güvenlik nedeniyle çalıştırılmaz."));
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      const comspec = process.env.ComSpec ?? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
      child = spawn(comspec, ["/d", "/s", "/c", '"' + command + '"'], {
        cwd: root,
        env: commandEnvironment(process.env) as NodeJS.ProcessEnv,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve(fail("Komut başlatılamadı."));
      return;
    }
    child.once("error", () => finish(fail("Komut başlatılamadı.")));
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(0, MAX_CAPTURE_CHARS);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      if (typeof child.pid === "number") void runTaskkill(["/PID", String(child.pid), "/T", "/F"]);
      finish(fail("Komut " + String(Math.round(timeoutMs / 1000)) + " saniyede bitmediği için durduruldu.\n" + boundOutput(output, MAX_TOOL_OUTPUT_CHARS)));
    }, timeoutMs);
    child.once("close", (code) => {
      finish({ ok: code === 0, text: "Çıkış kodu: " + String(code ?? "?") + "\n" + boundOutput(output, MAX_TOOL_OUTPUT_CHARS) });
    });
  });
}
