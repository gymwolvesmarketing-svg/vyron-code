import { describe, it, expect } from "vitest";
import fs from "node:fs";
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
    const entries = [...filesBlock.matchAll(/^\s+-\s+"?([^"\n]+)"?\s*$/gm)].map((m) => m[1]);
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
