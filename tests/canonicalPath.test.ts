import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { resolveCanonicalRoot, resolveCanonicalPath, checkRootPolicy } from "../lib/canonicalPath";

let sandboxRoot: string;
let projectRoot: string;
let outsideDir: string;
let canonicalProjectRoot: string;

beforeAll(() => {
  sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vyroncode-test-"));
  projectRoot = path.join(sandboxRoot, "project");
  outsideDir = path.join(sandboxRoot, "outside");
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(projectRoot, "readme.txt"), "inside project");
  fs.writeFileSync(path.join(outsideDir, "secret.txt"), "outside project");
  fs.mkdirSync(path.join(projectRoot, "sub"));
  fs.writeFileSync(path.join(projectRoot, "sub", "nested.txt"), "nested inside project");
  fs.mkdirSync(path.join(projectRoot, ".git"));
  fs.writeFileSync(path.join(projectRoot, ".git", "config"), "fake git config");
  fs.writeFileSync(path.join(projectRoot, ".env"), "SECRET=1");

  const resolved = resolveCanonicalRoot(projectRoot);
  if (!resolved) throw new Error("setup failed: could not resolve project root");
  canonicalProjectRoot = resolved;

  // Windows junction pointing OUTSIDE the project root, created INSIDE it — the exact
  // escape vector the Threat Model doc calls out. `mklink /J` is the native Windows
  // way to create an NTFS junction without elevated privileges (unlike symlinks).
  if (process.platform === "win32") {
    const junctionPath = path.join(projectRoot, "escape_junction");
    execFileSync("cmd.exe", ["/c", "mklink", "/J", junctionPath, outsideDir]);
  }
});

afterAll(() => {
  fs.rmSync(sandboxRoot, { recursive: true, force: true });
});

describe("resolveCanonicalRoot", () => {
  it("resolves an existing directory to its canonical form", () => {
    expect(canonicalProjectRoot).toBeTruthy();
    expect(fs.existsSync(canonicalProjectRoot)).toBe(true);
  });

  it("returns null for a non-existent path", () => {
    expect(resolveCanonicalRoot(path.join(sandboxRoot, "does-not-exist"))).toBeNull();
  });
});

describe("resolveCanonicalPath", () => {
  it("allows a plain file inside the root", () => {
    const result = resolveCanonicalPath(canonicalProjectRoot, "readme.txt");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.relativePath).toBe("readme.txt");
  });

  it("allows a nested file inside the root", () => {
    const result = resolveCanonicalPath(canonicalProjectRoot, "sub/nested.txt");
    expect(result.ok).toBe(true);
  });

  it("rejects an absolute path outright, never resolving it against the root", () => {
    const result = resolveCanonicalPath(canonicalProjectRoot, outsideDir);
    expect(result).toEqual({ ok: false, reason: "absolute_path_rejected" });
  });

  it("rejects a .. escape sequence", () => {
    const result = resolveCanonicalPath(canonicalProjectRoot, "../outside/secret.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("path_outside_project_root");
  });

  it("denies .env regardless of containment", () => {
    const result = resolveCanonicalPath(canonicalProjectRoot, ".env");
    expect(result).toEqual({ ok: false, reason: "path_denied" });
  });

  it("denies .git internals regardless of containment", () => {
    const result = resolveCanonicalPath(canonicalProjectRoot, ".git/config");
    expect(result).toEqual({ ok: false, reason: "path_denied" });
  });

  it("returns not_found for a path that doesn't exist", () => {
    const result = resolveCanonicalPath(canonicalProjectRoot, "nope.txt");
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it.runIf(process.platform === "win32")(
    "blocks a junction created inside the project root that points outside it",
    () => {
      const result = resolveCanonicalPath(canonicalProjectRoot, "escape_junction/secret.txt");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("path_outside_project_root");
    }
  );
});

describe("checkRootPolicy", () => {
  it("allows a valid, narrow project root", () => {
    expect(checkRootPolicy(canonicalProjectRoot)).toEqual({ allowed: true });
  });

  it.runIf(process.platform === "win32")("rejects a drive root", () => {
    const driveRoot = fs.realpathSync.native(path.parse(sandboxRoot).root);
    expect(checkRootPolicy(driveRoot)).toEqual({ allowed: false, reason: "drive_root" });
  });

  it("rejects a POSIX-style root via path.parse(...).root equality", () => {
    // Platform-generic assertion of the same rule the drive-root test exercises concretely
    // on Windows: any path that IS its own filesystem root is rejected.
    const root = path.parse(sandboxRoot).root;
    expect(path.parse(root).root).toBe(root);
    expect(checkRootPolicy(root)).toEqual({ allowed: false, reason: "drive_root" });
  });

  it("rejects the user's home/profile root", () => {
    const home = fs.realpathSync.native(os.homedir());
    expect(checkRootPolicy(home)).toEqual({ allowed: false, reason: "home_root" });
  });

  it("rejects a common broad user folder (Desktop/Documents/Downloads/...) when it exists", () => {
    const home = fs.realpathSync.native(os.homedir());
    const candidates = ["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos", "OneDrive"];
    const existing = candidates
      .map((name) => path.join(home, name))
      .filter((p) => fs.existsSync(p));
    // Skip gracefully if none of these well-known folders exist on the test machine —
    // the policy function itself already no-ops on a missing candidate (see its own
    // try/catch), so this just avoids a false failure on an unusual environment.
    if (existing.length === 0) return;
    for (const candidate of existing) {
      const canonical = fs.realpathSync.native(candidate);
      expect(checkRootPolicy(canonical)).toEqual({ allowed: false, reason: "common_user_folder" });
    }
  });

  it("does NOT reject a narrow project folder nested inside a broad user folder", () => {
    // The policy denies the broad folder ITSELF, not everything under it — a real project
    // living at e.g. Documents\some-project must remain registrable.
    const home = fs.realpathSync.native(os.homedir());
    const documents = path.join(home, "Documents");
    if (!fs.existsSync(documents)) return;
    const nestedProject = path.join(documents, `vyroncode-policy-test-${Date.now()}`);
    fs.mkdirSync(nestedProject);
    try {
      const canonical = fs.realpathSync.native(nestedProject);
      expect(checkRootPolicy(canonical)).toEqual({ allowed: true });
    } finally {
      fs.rmSync(nestedProject, { recursive: true, force: true });
    }
  });
});
