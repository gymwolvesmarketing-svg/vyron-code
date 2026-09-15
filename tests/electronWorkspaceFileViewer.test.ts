import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const { mockGetCurrentCanonicalRoot } = vi.hoisted(() => ({ mockGetCurrentCanonicalRoot: vi.fn() }));
vi.mock("../electron/workspace-grant", () => ({ getCurrentCanonicalRoot: mockGetCurrentCanonicalRoot }));

import { readTextFile } from "../electron/workspaceFileViewer";

let sandboxRoot: string;
let projectRoot: string;

beforeAll(() => {
  sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vyroncode-viewer-test-"));
  projectRoot = path.join(sandboxRoot, "project");
  fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(projectRoot, "readme.txt"), "line one\nline two\nline three");
  fs.mkdirSync(path.join(projectRoot, "src"));
  fs.writeFileSync(path.join(projectRoot, "src", "binary.dat"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  fs.writeFileSync(path.join(projectRoot, "big.txt"), "x".repeat(2 * 1024 * 1024));

  const outsideDir = path.join(sandboxRoot, "outside");
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(outsideDir, "secret.txt"), "outside");
});

afterAll(() => {
  fs.rmSync(sandboxRoot, { recursive: true, force: true });
});

describe("readTextFile — bounded, read-only text preview", () => {
  it("returns no_workspace when no grant exists", () => {
    mockGetCurrentCanonicalRoot.mockReturnValue(null);
    expect(readTextFile("readme.txt").state).toBe("no_workspace");
  });

  it("reads a small text file and reports its line count", () => {
    mockGetCurrentCanonicalRoot.mockReturnValue(projectRoot);
    const result = readTextFile("readme.txt");
    expect(result.state).toBe("ok");
    expect(result.content).toBe("line one\nline two\nline three");
    expect(result.lineCount).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.relativePath).toBe("readme.txt");
  });

  it("rejects an absolute path", () => {
    mockGetCurrentCanonicalRoot.mockReturnValue(projectRoot);
    const result = readTextFile("C:\\Windows\\win.ini");
    expect(result.state).toBe("invalid_path");
    expect(result.content).toBeNull();
  });

  it("rejects a traversal attempt that would escape the granted root", () => {
    mockGetCurrentCanonicalRoot.mockReturnValue(projectRoot);
    const result = readTextFile("../outside/secret.txt");
    expect(result.state).toBe("invalid_path");
    expect(result.content).toBeNull();
  });

  it.each([
    ["UNC path", "\\\\server\\share\\file.txt"],
    ["device path", "\\\\.\\PhysicalDrive0"],
    ["URL-like path", "file:///C:/Windows/win.ini"],
    ["null-byte path", "readme.txt\u0000.png"],
    ["encoded traversal (never decoded)", "%2e%2e/outside/secret.txt"],
    ["oversized request string", "a".repeat(5000)],
  ])("safely rejects a %s read request, never as a successful read", (_label, input) => {
    mockGetCurrentCanonicalRoot.mockReturnValue(projectRoot);
    const result = readTextFile(input);
    expect(result.state).not.toBe("ok");
    expect(result.content).toBeNull();
  });

  it("returns not_a_file for a directory path", () => {
    mockGetCurrentCanonicalRoot.mockReturnValue(projectRoot);
    const result = readTextFile("src");
    expect(result.state).toBe("not_a_file");
  });

  it("detects binary content and refuses to preview it", () => {
    mockGetCurrentCanonicalRoot.mockReturnValue(projectRoot);
    const result = readTextFile("src/binary.dat");
    expect(result.state).toBe("binary");
    expect(result.content).toBeNull();
  });

  it("refuses an oversized file rather than reading it", () => {
    mockGetCurrentCanonicalRoot.mockReturnValue(projectRoot);
    const result = readTextFile("big.txt");
    expect(result.state).toBe("too_large");
    expect(result.content).toBeNull();
  });

  it("never leaks the workspace's absolute path through the result", () => {
    mockGetCurrentCanonicalRoot.mockReturnValue(projectRoot);
    const result = readTextFile("readme.txt");
    expect(JSON.stringify(result)).not.toContain(projectRoot.replace(/\\/g, "\\\\"));
  });
});
