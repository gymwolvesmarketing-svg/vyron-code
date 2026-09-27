import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toAsarUnpackedPath } from "../electron/localAiAdapters";

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const pkg = JSON.parse(read("package.json")) as { main: string; scripts: Record<string, string>; devDependencies: Record<string, string> };
const builderConfig = read("electron-builder.yml");
const gitignore = read(".gitignore").split(/\r?\n/).map((l) => l.trim());

function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

describe("packaging - configuration", () => {
  it("declares the compiled Electron entry point as the package main", () => {
    expect(pkg.main).toBe("dist-electron/electron/main.js");
  });

  it("defines the four explicit electron scripts, none using a dev server, npx or a shell script", () => {
    for (const name of ["electron:build", "electron:run", "electron:package", "electron:dist"]) {
      expect(pkg.scripts[name], name).toBeTruthy();
      expect(pkg.scripts[name]).not.toMatch(/next (dev|start)|npx|powershell|cmd /i);
    }
    expect(pkg.scripts["electron:package"]).toContain("electron-builder --win dir");
    expect(pkg.scripts["electron:dist"]).toContain("electron-builder --win nsis");
    expect(pkg.scripts["build:electron"]).toBeTruthy();
  });

  it("uses electron-builder with the fixed app identity, executable name and a per-user NSIS installer", () => {
    expect(pkg.devDependencies["electron-builder"]).toBeTruthy();
    expect(builderConfig).toMatch(/^appId: com\.vyron\.code$/m);
    expect(builderConfig).toMatch(/^productName: Vyron Code$/m);
    expect(builderConfig).toMatch(/executableName: VyronCode/);
    expect(builderConfig).toMatch(/target: nsis/);
    expect(builderConfig).toMatch(/target: dir/);
    expect(builderConfig).toMatch(/requestedExecutionLevel: asInvoker/);
    expect(builderConfig).toMatch(/perMachine: false/);
    expect(builderConfig).toMatch(/createDesktopShortcut: true/);
    expect(builderConfig).toMatch(/createStartMenuShortcut: true/);
  });

  it("never publishes", () => {
    expect(builderConfig).toMatch(/^publish: null$/m);
    expect(pkg.scripts["electron:dist"]).not.toMatch(/--publish/);
  });

  it("ships only the compiled electron code and the auth proxy script: no node_modules, source, tests, data or env files", () => {
    const filesBlock = builderConfig.slice(builderConfig.indexOf("\nfiles:"), builderConfig.indexOf("\nasarUnpack:"));
    const entries = [...filesBlock.matchAll(/^\s+-\s+"?([^"\n]+)"?\s*$/gm)].map((m) => (m[1] ?? "").trim());
    expect(entries).toEqual(["package.json", "dist-electron/**/*", "scripts/hermes-auth-proxy.mjs", "!**/node_modules/**", "!**/*.map"]);
  });

  it("unpacks exactly the auth proxy script so a separate Node process can run it", () => {
    const block = builderConfig.slice(builderConfig.indexOf("\nasarUnpack:"), builderConfig.indexOf("\nwin:"));
    expect([...block.matchAll(/^\s+-\s+(.+?)\s*$/gm)].map((m) => m[1])).toEqual(["scripts/hermes-auth-proxy.mjs"]);
  });

  it("build output directories and installer artifacts are ignored by Git", () => {
    for (const entry of ["release/", "dist-electron/", "out/", "win-unpacked/", "*.exe", "*.blockmap", "latest.yml"]) {
      expect(gitignore, entry).toContain(entry);
    }
  });
});

describe("packaging - startup architecture", () => {
  const main = stripComments(read("electron/main.ts"));
  const adapters = stripComments(read("electron/localAiAdapters.ts"));

  it("loads only the bundled static renderer file: no internal UI server, no Next server, no URL load", () => {
    expect(main).toMatch(/\.loadFile\(path\.join\(__dirname, "renderer\.html"\)\)/);
    for (const code of [main, adapters]) {
      expect(code).not.toMatch(/loadURL|createServer|next (dev|start)|\bnpx\b|\bnpm\b|from ["']next|require\(["']next/);
    }
  });

  it("spawns processes only from the two fixed adapter sites, never with a shell", () => {
    expect((adapters.match(/\bspawn\(/g) ?? []).length).toBe(2);
    expect((adapters.match(/shell: false/g) ?? []).length).toBe(2);
    expect(adapters).not.toMatch(/shell:\s*true/);
    expect(main).not.toMatch(/child_process/);
  });

  it("no startup input (path, port, command, env) can come from the renderer", () => {
    const preload = stripComments(read("electron/preload.ts"));
    expect(preload).not.toMatch(/\b(port|command|spawn|execPath|environment)\b/i);
    expect(main).toContain("LOCAL_AI_IPC_CHANNELS.LOCAL_AI_GET_STATE, () =>");
  });

  it("keeps the Electron hardening flags", () => {
    const policy = read("electron/security-policy.ts");
    for (const flag of ["contextIsolation: true", "nodeIntegration: false", "sandbox: true", "webSecurity: true", "webviewTag: false"]) {
      expect(policy).toContain(flag);
    }
  });
});

describe("packaging - resource resolution", () => {
  it("maps a path inside app.asar to app.asar.unpacked and leaves other paths untouched", () => {
    const sep = path.sep;
    const packed = ["C:", "Apps", "Vyron", "resources", "app.asar", "scripts", "hermes-auth-proxy.mjs"].join(sep);
    const unpacked = ["C:", "Apps", "Vyron", "resources", "app.asar.unpacked", "scripts", "hermes-auth-proxy.mjs"].join(sep);
    expect(toAsarUnpackedPath(packed)).toBe(unpacked);
    const dev = ["D:", "Vyron Code", "scripts", "hermes-auth-proxy.mjs"].join(sep);
    expect(toAsarUnpackedPath(dev)).toBe(dev);
    expect(toAsarUnpackedPath(unpacked)).toBe(unpacked);
  });

  it("the proxy script is resolved through the unpacked-path mapping and exists where the package takes it from", () => {
    expect(fs.existsSync(path.join(root, "scripts", "hermes-auth-proxy.mjs"))).toBe(true);
    expect(read("electron/localAiAdapters.ts")).toContain(
      'toAsarUnpackedPath(path.resolve(__dirname, "..", "..", "scripts", "hermes-auth-proxy.mjs"))',
    );
  });

  it("every renderer asset the window loads is produced by the electron build", () => {
    expect(read("scripts/copy-electron-assets.mjs")).toContain('"renderer.html", "renderer.css"');
    expect(read("electron/renderer.html")).toContain("renderer.js");
  });
});

describe("packaging - brand assets and application icon", () => {
  const assets = path.join(root, "electron", "assets");

  it("ships the application icon (multi-size .ico plus PNG) and the two UI brand images", () => {
    for (const name of ["icon.ico", "icon.png", "logo.png", "mark.png"]) {
      expect(fs.statSync(path.join(assets, name)).size, name).toBeGreaterThan(1000);
    }
    const ico = fs.readFileSync(path.join(assets, "icon.ico"));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(6);
    const png = fs.readFileSync(path.join(assets, "icon.png"));
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(256);
    expect(png.readUInt32BE(16)).toBe(png.readUInt32BE(20));
  });

  it("uses the icon for the Windows executable/installer and for the BrowserWindow", () => {
    expect(builderConfig).toMatch(/icon: electron\/assets\/icon\.ico/);
    expect(read("electron/main.ts")).toContain('icon: path.join(__dirname, "assets", "icon.png")');
  });

  it("copies the brand images next to the renderer during the electron build, and the page references only those", () => {
    const copy = read("scripts/copy-electron-assets.mjs");
    for (const name of ["assets/logo.png", "assets/mark.png", "assets/icon.png"]) expect(copy).toContain(name);
    const html = read("electron/renderer.html");
    const refs = [...html.matchAll(/src="(assets\/[^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(fs.existsSync(path.join(root, "electron", ref as string)), ref).toBe(true);
    expect(html).not.toMatch(/src="(https?:|data:|\/\/)/);
  });
});

describe("packaging - Ruflo runtime", () => {
  it("copies the runtime into resources/ruflo-runtime with an afterPack hook (extraResources drops node_modules)", () => {
    expect(builderConfig).toMatch(/^afterPack: scripts\/after-pack-ruflo\.cjs\s*$/m);
    expect(builderConfig).not.toMatch(/^extraResources:/m);
    const hook = read("scripts/after-pack-ruflo.cjs");
    expect(hook).toContain('"resources", "ruflo-runtime"');
    expect(hook).toContain("fs.cpSync(source, target, { recursive: true })");
    expect(hook).toContain("Ruflo runtime is missing");
  });

  it("package and dist scripts verify the runtime first, and dedicated runtime scripts exist", () => {
    expect(pkg.scripts["runtime:ruflo"]).toBe("node scripts/build-ruflo-runtime.mjs");
    expect(pkg.scripts["runtime:ruflo:verify"]).toBe("node scripts/build-ruflo-runtime.mjs --verify");
    expect(pkg.scripts["electron:package"]).toMatch(/^npm run runtime:ruflo:verify && /);
    expect(pkg.scripts["electron:dist"]).toMatch(/^npm run runtime:ruflo:verify && /);
  });

  it("the runtime build pins the Ruflo version and keeps every Windows x64 binary while removing the others", async () => {
    const mod = (await import("../scripts/build-ruflo-runtime.mjs")) as unknown as { RUFLO_VERSION: string; isForeignPlatformPath(p: string): boolean };
    expect(mod.RUFLO_VERSION).toBe("3.44.0");
    for (const foreign of [
      "@agntcy/slim-bindings-linux-x64-gnu",
      "@agntcy/slim-bindings-darwin-arm64",
      "@agntcy/slim-bindings-win32-arm64-msvc",
      "onnxruntime-node/bin/napi-v6/linux/x64",
      "onnxruntime-node/bin/napi-v6/darwin",
      "onnxruntime-node/bin/napi-v6/win32/arm64",
      "argon2/prebuilds/linux-x64",
      "@ruvector/gnn/npm/darwin-x64",
    ]) {
      expect(mod.isForeignPlatformPath(foreign), foreign).toBe(true);
    }
    for (const keep of [
      "@agntcy/slim-bindings-win32-x64-msvc",
      "onnxruntime-node/bin/napi-v6/win32/x64",
      "onnxruntime-node/bin/napi-v6",
      "argon2/prebuilds/win32-x64",
      "@ruvector/gnn/npm/win32-x64-msvc",
      "ruflo",
      "better-sqlite3",
      "@claude-flow/cli",
    ]) {
      expect(mod.isForeignPlatformPath(keep), keep).toBe(false);
    }
  });

  it("the runtime folder is never committed", () => {
    expect(gitignore).toContain("build/");
  });
});

describe("Ruflo prompt limit patch (long Manager tasks and tool runs must not be refused)", () => {
  async function mod() {
    return (await import("../scripts/build-ruflo-runtime.mjs")) as unknown as { RUFLO_TEXT_LIMIT: number; ensureRufloTextLimit(dir: string): boolean };
  }
  function fakeRuntime(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyron-ruflo-patch-"));
    const file = path.join(dir, "node_modules", "@claude-flow", "cli-core", "dist", "src", "mcp-tools", "validate-input.js");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
    return dir;
  }
  const ORIGINAL = "export function validateText(value, label, maxLen = 10_000) {\n  return value;\n}\n";

  it("raises Ruflo's 10,000-character default once, and is idempotent", async () => {
    const { ensureRufloTextLimit, RUFLO_TEXT_LIMIT } = await mod();
    const dir = fakeRuntime(ORIGINAL);
    try {
      expect(ensureRufloTextLimit(dir)).toBe(true);
      const file = path.join(dir, "node_modules", "@claude-flow", "cli-core", "dist", "src", "mcp-tools", "validate-input.js");
      expect(fs.readFileSync(file, "utf8")).toContain("maxLen = " + String(RUFLO_TEXT_LIMIT).replace(/\B(?=(\d{3})+(?!\d))/g, "_") + ") {");
      expect(RUFLO_TEXT_LIMIT).toBe(600_000);
      expect(ensureRufloTextLimit(dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-patches a runtime an older build already patched to a different limit (a version bump must not get stuck)", async () => {
    const { ensureRufloTextLimit, RUFLO_TEXT_LIMIT } = await mod();
    const dir = fakeRuntime("export function validateText(value, label, maxLen = 200_000) {\n  return value;\n}\n");
    try {
      expect(ensureRufloTextLimit(dir)).toBe(true);
      const file = path.join(dir, "node_modules", "@claude-flow", "cli-core", "dist", "src", "mcp-tools", "validate-input.js");
      expect(fs.readFileSync(file, "utf8")).toContain("maxLen = " + String(RUFLO_TEXT_LIMIT).replace(/\B(?=(\d{3})+(?!\d))/g, "_") + ") {");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to ship when Ruflo's validator no longer has the expected shape", async () => {
    const { ensureRufloTextLimit } = await mod();
    const dir = fakeRuntime("export function validateText(value) { return value; }\n");
    try {
      expect(() => ensureRufloTextLimit(dir)).toThrow(/no longer applies/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the shipped-runtime verification applies the patch, and the app's largest prompts fit under the limit", async () => {
    const script = fs.readFileSync(path.join(__dirname, "..", "scripts", "build-ruflo-runtime.mjs"), "utf8");
    expect(script).toMatch(/verifyRuntime[\s\S]*ensureRufloTextLimit\(dir\)/);
    const { RUFLO_TEXT_LIMIT } = await mod();
    const bridge = fs.readFileSync(path.join(__dirname, "..", "electron", "rufloBridge.ts"), "utf8");
    const asks = Number(/MAX_RUFLO_ASK_CHARS = ([\d_]+)/.exec(bridge)![1]!.replace(/_/g, ""));
    expect(asks).toBeLessThanOrEqual(RUFLO_TEXT_LIMIT);
  });
});
