import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const { mockGetCurrentCanonicalRoot } = vi.hoisted(() => ({ mockGetCurrentCanonicalRoot: vi.fn() }));
vi.mock("../electron/workspace-grant", () => ({ getCurrentCanonicalRoot: mockGetCurrentCanonicalRoot }));

import { listEntries } from "../electron/workspaceExplorer";

let sandboxRoot: string;
let projectRoot: string;

beforeAll(() => {
  sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vyroncode-explorer-test-"));
  projectRoot = path.join(sandboxRoot, "project");
  fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(projectRoot, "readme.txt"), "hello");
  fs.mkdirSync(path.join(projectRoot, "src"));
  fs.writeFileSync(path.join(projectRoot, "src", "index.ts"), "export {}");
  fs.mkdirSync(path.join(projectRoot, ".git"));
  fs.writeFileSync(path.join(projectRoot, ".git", "config"), "fake");
  fs.mkdirSync(path.join(projectRoot, "node_modules"));
  fs.writeFileSync(path.join(projectRoot, ".env"), "SECRET=1");

  const outsideDir = path.join(sandboxRoot, "outside");
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(outsideDir, "secret.txt"), "outside");
});

afterAll(() => {
  fs.rmSync(sandboxRoot, { recursive: true, force: true });
});

describe("listEntries — bounded, read-only directory listing", () => {
  it("returns no_workspace when no grant exists", () => {
    mockGetCurrentCanonicalRoot.mockReturnValue(null);
    expect(listEntries(".").state).toBe("no_workspace");
  });

  it("lists the root directory, excluding denied names (.git, node_modules, .env)", () => {
    mockGetCurrentCanonicalRoot.mockReturnValue(projectRoot);
    const result = listEntries(".");
    expect(result.state).toBe("ok");
    const names = result.entries.map((e) => e.name).sort();
    expect(names).toEqual(["readme.txt", "src"]);
    expect(names).not.toContain(".git");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".env");
  });

  it("lists a nested directory via its relative path", () => {
    mockGetCurrentCanonicalRoot.mockReturnValue(projectRoot);
    const result = listEntries("src");
    expect(result.state).toBe("ok");
    expect(result.entries.map((e) => e.name)).toEqual(["index.ts"]);
    expect(result.entries[0]?.type).toBe("file");
    expect(result.entries[0]?.relativePath).toBe("src/index.ts");
  });

  it("distinguishes directories from files, directories sorted first", () => {
    mockGetCurrentCanonicalRoot.mockReturnValue(projectRoot);
    const result = listEntries(".");
    expect(result.entries[0]?.type).toBe("dir");
    expect(result.entries[0]?.name).toBe("src");
  });

  it("rejects an absolute path request", () => {
    mockGetCurrentCanonicalRoot.mockReturnValue(projectRoot);
    const result = listEntries("C:\\Windows");
    expect(result.state).toBe("invalid_path");
    expect(result.entries).toEqual([]);
  });

  it("rejects a traversal request that would escape the granted root", () => {
    mockGetCurrentCanonicalRoot.mockReturnValue(projectRoot);
    const result = listEntries("../outside");
    expect(result.state).toBe("invalid_path");
    expect(result.entries).toEqual([]);
  });

  it.each([
    ["UNC path", "\\\\server\\share"],
    ["device path", "\\\\.\\PhysicalDrive0"],
    ["URL-like path", "file:///C:/Windows"],
    ["null-byte path", "src\u0000/index.ts"],
    ["encoded traversal (never decoded)", "%2e%2e/outside"],
    ["oversized request string", "a".repeat(5000)],
  ])("safely rejects a %s request as invalid_path, never as a successful listing", (_label, input) => {
    mockGetCurrentCanonicalRoot.mockReturnValue(projectRoot);
    const result = listEntries(input);
    expect(result.state).not.toBe("ok");
    expect(result.entries).toEqual([]);
  });

  it("returns not_a_directory for a file path", () => {
    mockGetCurrentCanonicalRoot.mockReturnValue(projectRoot);
    const result = listEntries("readme.txt");
    expect(result.state).toBe("not_a_directory");
  });

  it("never reads file contents while listing — only metadata", () => {
    mockGetCurrentCanonicalRoot.mockReturnValue(projectRoot);
    const readSpy = vi.spyOn(fs, "readFileSync");
    listEntries(".");
    expect(readSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();
  });

  it("applies an explicit item-count limit and reports truncation", () => {
    const bigDirRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vyroncode-explorer-big-"));
    for (let i = 0; i < 600; i++) {
      fs.writeFileSync(path.join(bigDirRoot, `file-${String(i).padStart(4, "0")}.txt`), "x");
    }
    mockGetCurrentCanonicalRoot.mockReturnValue(bigDirRoot);
    const result = listEntries(".");
    expect(result.state).toBe("ok");
    expect(result.entries.length).toBeLessThanOrEqual(500);
    expect(result.truncated).toBe(true);
    fs.rmSync(bigDirRoot, { recursive: true, force: true });
  });
});
