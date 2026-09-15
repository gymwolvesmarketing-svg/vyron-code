import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const { mockGetCurrentCanonicalRoot } = vi.hoisted(() => ({ mockGetCurrentCanonicalRoot: vi.fn() }));
vi.mock("../electron/workspace-grant", () => ({ getCurrentCanonicalRoot: mockGetCurrentCanonicalRoot }));

import { resolveWorkspacePath } from "../electron/workspaceAccess";

let sandboxRoot: string;
let projectRoot: string;

beforeAll(() => {
  sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vyroncode-access-test-"));
  projectRoot = path.join(sandboxRoot, "project");
  fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(projectRoot, "readme.txt"), "hello");
});

afterAll(() => {
  fs.rmSync(sandboxRoot, { recursive: true, force: true });
});

describe("resolveWorkspacePath — shared access-validation helper", () => {
  it("returns no_workspace when no grant exists", () => {
    mockGetCurrentCanonicalRoot.mockReturnValue(null);
    const result = resolveWorkspacePath(".");
    expect(result).toEqual({ ok: false, reason: "no_workspace" });
  });

  it("resolves a valid relative path within the granted root", () => {
    mockGetCurrentCanonicalRoot.mockReturnValue(projectRoot);
    const result = resolveWorkspacePath("readme.txt");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.relativePath).toBe("readme.txt");
      expect(result.canonicalRoot).toBe(projectRoot);
    }
  });

  it("rejects an absolute path as invalid_path", () => {
    mockGetCurrentCanonicalRoot.mockReturnValue(projectRoot);
    const result = resolveWorkspacePath("C:\\Windows\\System32");
    expect(result).toEqual({ ok: false, reason: "invalid_path" });
  });

  it("rejects a traversal attempt as invalid_path", () => {
    mockGetCurrentCanonicalRoot.mockReturnValue(projectRoot);
    const result = resolveWorkspacePath("../outside.txt");
    expect(result).toEqual({ ok: false, reason: "invalid_path" });
  });

  it("never returns the canonical root's own absolute path as invalid_path noise — 'invalid_path' and 'no_workspace' are the only two failure reasons", () => {
    mockGetCurrentCanonicalRoot.mockReturnValue(projectRoot);
    const result = resolveWorkspacePath("does-not-exist.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["no_workspace", "invalid_path"]).toContain(result.reason);
    }
  });

  it("rejects a request string longer than the explicit maximum length, before any fs work", () => {
    mockGetCurrentCanonicalRoot.mockReturnValue(projectRoot);
    const result = resolveWorkspacePath("a".repeat(5000));
    expect(result).toEqual({ ok: false, reason: "invalid_path" });
  });

  it("treats an empty string the same as the root sentinel '.' — safe, not a security escape", () => {
    mockGetCurrentCanonicalRoot.mockReturnValue(projectRoot);
    const result = resolveWorkspacePath("");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.relativePath).toBe(".");
  });

  it.each([
    ["drive-letter absolute path", "C:\\Windows\\System32"],
    ["drive-letter, forward slashes", "C:/Windows/System32"],
    ["UNC path", "\\\\server\\share\\file.txt"],
    ["UNC path, forward slashes", "//server/share/file.txt"],
    ["device path", "\\\\.\\PhysicalDrive0"],
    ["device path, forward slashes", "//./PhysicalDrive0"],
    ["URL-like path", "file:///C:/Windows/System32"],
    ["null-byte path", "readme.txt\u0000.png"],
    ["basic traversal", "../outside.txt"],
    ["nested traversal", "sub/../../outside.txt"],
    ["encoded traversal (never decoded, so treated as a literal, non-existent segment)", "%2e%2e/outside.txt"],
    ["absolute path with traversal appended", "C:\\..\\outside.txt"],
  ])("rejects a %s request as invalid_path, never as a successful escape", (_label, input) => {
    mockGetCurrentCanonicalRoot.mockReturnValue(projectRoot);
    const result = resolveWorkspacePath(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_path");
    }
  });
});
