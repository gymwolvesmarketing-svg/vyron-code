/**
 * Fixed-operation adapters that give electron/rufloBridge.ts a real Ruflo child process - main process only.
 *
 * The runtime (a plain node.exe plus the full Ruflo package, see scripts/build-ruflo-runtime.mjs) ships inside
 * the app's resources. It is started with `spawn` (shell:false, no visible window), fixed arguments
 * (`ruflo.js mcp start`, stdio transport: no listening port), a working directory under the app's own data
 * folder, and an allowlisted environment that redirects HOME/APPDATA into that folder so Ruflo can neither read
 * nor write the user's real profile. Ruflo's model calls go to the local auth proxy (loopback) with the Hermes
 * credential, which exists only in this child's environment. Nothing here takes a value from the renderer.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { PROXY_ORIGIN, readApiKey, runTaskkill } from "./localAiAdapters";
import { createRufloBridge, type RufloBridge, type RufloDeps, type RufloTransport } from "./rufloBridge";

const MAX_LINE_BUFFER = 4 * 1024 * 1024;
const GRACEFUL_WAIT_MS = 3_000;

/** Pure: the runtime folder for a packaged or a development run. */
export function resolveRuntimeDir(resourcesPath: string | undefined, isPackaged: boolean, compiledDir: string): string {
  if (isPackaged && resourcesPath) return path.join(resourcesPath, "ruflo-runtime");
  return path.resolve(compiledDir, "..", "..", "build", "ruflo-runtime");
}

/** Pure: the complete, allowlisted child environment. Nothing else from the parent environment is passed. */
export function buildRufloEnvironment(
  apiKey: string,
  workRoot: string,
  systemRoot: string | undefined,
): Record<string, string | undefined> {
  const root = systemRoot && systemRoot.length > 0 ? systemRoot : "C:\\Windows";
  return {
    SystemRoot: root,
    PATH: path.join(root, "System32") + ";" + root,
    HOME: workRoot,
    USERPROFILE: workRoot,
    APPDATA: path.join(workRoot, "appdata"),
    LOCALAPPDATA: path.join(workRoot, "localappdata"),
    TEMP: path.join(workRoot, "tmp"),
    TMP: path.join(workRoot, "tmp"),
    RUFLO_PROVIDER: "openrouter",
    OPENROUTER_BASE_URL: PROXY_ORIGIN,
    OPENROUTER_API_KEY: apiKey,
    OPENROUTER_DEFAULT_MODEL: "hermes-agent",
  };
}

function wrapTransport(child: ChildProcess): RufloTransport | null {
  let exited = false;
  const exitListeners: Array<() => void> = [];
  const lineListeners: Array<(line: string) => void> = [];
  // A failed spawn emits "error" asynchronously; it must never become an unhandled exception in the main process.
  child.once("error", () => {
    exited = true;
    for (const listener of exitListeners) listener();
  });
  if (typeof child.pid !== "number" || !child.stdin || !child.stdout) return null;
  child.once("exit", () => {
    exited = true;
    for (const listener of exitListeners) listener();
  });
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    if (buffer.length > MAX_LINE_BUFFER) buffer = buffer.slice(-MAX_LINE_BUFFER);
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) for (const listener of lineListeners) listener(line);
      index = buffer.indexOf("\n");
    }
  });
  // Output on stderr is drained and discarded: it can hold prompts, so it is never logged or forwarded.
  child.stderr?.on("data", () => undefined);
  child.stdin.on("error", () => undefined);
  const stdin = child.stdin;
  const transport: RufloTransport = {
    send: (line) => {
      if (exited) throw new Error("closed");
      stdin.write(line + "\n");
    },
    onLine: (listener) => {
      lineListeners.push(listener);
    },
    onExit: (listener) => {
      exitListeners.push(listener);
    },
    hasExited: () => exited,
  };
  pids.set(transport, child.pid);
  return transport;
}

const pids = new WeakMap<RufloTransport, number>();

export function createRufloDeps(options: { workRoot: string; resourcesPath: string | undefined; isPackaged: boolean }): RufloDeps {
  const runtimeDir = resolveRuntimeDir(options.resourcesPath, options.isPackaged, __dirname);
  const nodeExe = path.join(runtimeDir, "node.exe");
  const cli = path.join(runtimeDir, "node_modules", "ruflo", "bin", "ruflo.js");
  return {
    readApiKey,
    async clearMemory() {
      // Ruflo keeps its persistent memory (vector index + database) in these two folders of its working directory.
      for (const folder of [".swarm", ".claude-flow"]) rmSync(path.join(options.workRoot, folder), { recursive: true, force: true });
    },
    start(apiKey) {
      try {
        if (!existsSync(nodeExe) || !existsSync(cli)) return null;
        for (const sub of ["", "appdata", "localappdata", "tmp"]) mkdirSync(path.join(options.workRoot, sub), { recursive: true });
        const child = spawn(nodeExe, [cli, "mcp", "start"], {
          cwd: options.workRoot,
          env: buildRufloEnvironment(apiKey, options.workRoot, process.env.SystemRoot) as NodeJS.ProcessEnv,
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
        return wrapTransport(child);
      } catch {
        return null;
      }
    },
    async stop(transport) {
      const pid = pids.get(transport);
      if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || transport.hasExited()) return;
      await runTaskkill(["/PID", String(pid), "/T"]);
      const deadline = Date.now() + GRACEFUL_WAIT_MS;
      while (!transport.hasExited() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      if (!transport.hasExited()) await runTaskkill(["/PID", String(pid), "/T", "/F"]);
    },
  };
}

export function createProductionRufloBridge(options: { workRoot: string; resourcesPath: string | undefined; isPackaged: boolean }): RufloBridge {
  return createRufloBridge(createRufloDeps(options));
}
