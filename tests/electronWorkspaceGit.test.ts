import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const { mockGetCurrentCanonicalRoot } = vi.hoisted(() => ({ mockGetCurrentCanonicalRoot: vi.fn() }));
vi.mock("../electron/workspace-grant", () => ({ getCurrentCanonicalRoot: mockGetCurrentCanonicalRoot }));

import { getGitSummary } from "../electron/workspaceGit";

interface IndexEntrySpec {
  readonly path: string;
  readonly mtimeSeconds?: number;
  readonly mtimeNanoseconds?: number;
  readonly size?: number;
}

/** Builds a minimal, valid git index (version 2) buffer tracking exactly the given entries.
 * mtime/size default to 0 (deliberately mismatching any real file — used for tests that don't
 * care about modified/deleted detection); pass real values (see `trackedEntryFor`) to build a
 * fixture that correctly reports as "not modified". */
function buildGitIndexBuffer(entries: readonly IndexEntrySpec[]): Buffer {
  const header = Buffer.alloc(12);
  header.write("DIRC", 0, "ascii");
  header.writeUInt32BE(2, 4); // version 2
  header.writeUInt32BE(entries.length, 8);

  const entryBuffers = entries.map(({ path: p, mtimeSeconds = 0, mtimeNanoseconds = 0, size = 0 }) => {
    const fixed = Buffer.alloc(62);
    fixed.writeUInt32BE(mtimeSeconds, 8);
    fixed.writeUInt32BE(mtimeNanoseconds, 12);
    fixed.writeUInt32BE(size, 36);
    const nameBuf = Buffer.from(p, "utf8");
    fixed.writeUInt16BE(Math.min(nameBuf.length, 0xfff), 60); // flags: name length, no extended bit
    const raw = Buffer.concat([fixed, nameBuf, Buffer.from([0])]);
    const paddedLen = Math.ceil(raw.length / 8) * 8;
    return Buffer.concat([raw, Buffer.alloc(paddedLen - raw.length)]);
  });

  return Buffer.concat([header, ...entryBuffers]);
}

let sandboxRoot: string;

/** Writes `files` to disk first (every key — tracked or not). `trackedPaths` (a subset of
 * `files`' keys, defaulting to all of them) is what actually gets recorded in the index,
 * using each REAL, just-written file's own mtime+size — producing a fixture that correctly
 * reports as "not modified" by construction. Any path also listed in `trackedButStale` is
 * recorded with zeroed stat data instead, deliberately mismatching the real file, simulating
 * "modified". Paths in `trackedOnly` are recorded in the index with zeroed stat data and no
 * corresponding file on disk, for "deleted" tests. Any key in `files` NOT in `trackedPaths`
 * is written to disk but never added to the index at all — i.e. genuinely untracked. */
function makeRepo(
  name: string,
  opts: {
    head: string;
    files?: Record<string, string>;
    trackedPaths?: readonly string[];
    trackedOnly?: readonly string[];
    trackedButStale?: readonly string[];
  }
): string {
  const root = path.join(sandboxRoot, name);
  fs.mkdirSync(root, { recursive: true });
  const gitDir = path.join(root, ".git");
  fs.mkdirSync(gitDir);
  fs.writeFileSync(path.join(gitDir, "HEAD"), opts.head);

  const files = opts.files ?? {};
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  const trackedPaths = opts.trackedPaths ?? Object.keys(files);
  const trackedButStale = new Set(opts.trackedButStale ?? []);
  const entries: IndexEntrySpec[] = [];
  for (const rel of trackedPaths) {
    if (trackedButStale.has(rel)) {
      entries.push({ path: rel }); // zeroed stat — deliberately mismatches the real file, simulating "modified"
      continue;
    }
    const stat = fs.statSync(path.join(root, rel), { bigint: true });
    const mtimeSeconds = Number(stat.mtimeNs / 1_000_000_000n);
    const mtimeNanoseconds = Number(stat.mtimeNs % 1_000_000_000n);
    entries.push({ path: rel, mtimeSeconds, mtimeNanoseconds, size: Number(stat.size) });
  }
  for (const rel of opts.trackedOnly ?? []) {
    entries.push({ path: rel }); // no file on disk — simulates "deleted"
  }

  fs.writeFileSync(path.join(gitDir, "index"), buildGitIndexBuffer(entries));
  return root;
}

beforeAll(() => {
  sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vyroncode-git-test-"));
});

afterAll(() => {
  fs.rmSync(sandboxRoot, { recursive: true, force: true });
});

describe("getGitSummary — bounded, filesystem-only, read-only Git summary", () => {
  it("returns no_workspace when no grant exists", () => {
    mockGetCurrentCanonicalRoot.mockReturnValue(null);
    expect(getGitSummary().state).toBe("no_workspace");
  });

  it("returns not_a_repository when the workspace has no .git directory", () => {
    const root = path.join(sandboxRoot, "not-a-repo");
    fs.mkdirSync(root);
    mockGetCurrentCanonicalRoot.mockReturnValue(root);
    expect(getGitSummary().state).toBe("not_a_repository");
  });

  it("returns not_a_repository when .git is a file, not a directory (worktree/submodule case)", () => {
    const root = path.join(sandboxRoot, "worktree-style");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /somewhere/else");
    mockGetCurrentCanonicalRoot.mockReturnValue(root);
    expect(getGitSummary().state).toBe("not_a_repository");
  });

  it("reports branch, modified, deleted and untracked counts for a normal repo", () => {
    const root = makeRepo("normal-repo", {
      head: "ref: refs/heads/main\n",
      files: { "readme.txt": "tracked content, unchanged", "untracked.txt": "not tracked" },
      trackedPaths: ["readme.txt"], // only readme.txt is tracked; untracked.txt is written but never indexed
    });
    mockGetCurrentCanonicalRoot.mockReturnValue(root);
    const result = getGitSummary();
    expect(result.state).toBe("ok");
    expect(result.branch).toBe("main");
    expect(result.detached).toBe(false);
    expect(result.trackedChangesAvailable).toBe(true);
    expect(result.modifiedCount).toBe(0);
    expect(result.deletedCount).toBe(0);
    expect(result.untrackedCount).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("counts a tracked file whose real stat no longer matches the index as modified", () => {
    const root = makeRepo("modified-repo", {
      head: "ref: refs/heads/main\n",
      files: { "changed.txt": "new content on disk" },
      trackedButStale: ["changed.txt"], // index entry is zeroed, real file is not — mismatch
    });
    mockGetCurrentCanonicalRoot.mockReturnValue(root);
    const result = getGitSummary();
    expect(result.state).toBe("ok");
    expect(result.trackedChangesAvailable).toBe(true);
    expect(result.modifiedCount).toBe(1);
    expect(result.deletedCount).toBe(0);
  });

  it("counts a tracked file that no longer exists on disk as deleted", () => {
    const root = makeRepo("deleted-repo", {
      head: "ref: refs/heads/main\n",
      files: {},
      trackedOnly: ["gone.txt"], // recorded in the index, never written to disk
    });
    mockGetCurrentCanonicalRoot.mockReturnValue(root);
    const result = getGitSummary();
    expect(result.state).toBe("ok");
    expect(result.trackedChangesAvailable).toBe(true);
    expect(result.deletedCount).toBe(1);
    expect(result.modifiedCount).toBe(0);
  });

  it("never descends into .git itself when counting untracked files", () => {
    const root = makeRepo("no-git-double-count", {
      head: "ref: refs/heads/main\n",
      files: { "a.txt": "x" },
    });
    mockGetCurrentCanonicalRoot.mockReturnValue(root);
    const result = getGitSummary();
    expect(result.state).toBe("ok");
    expect(result.untrackedCount).toBe(0); // a.txt is tracked (matches its own real stat); never .git/HEAD or .git/index themselves
  });

  it("reports a detached HEAD without ever exposing the raw commit SHA", () => {
    const sha = "abcdef0123456789abcdef0123456789abcdef01";
    const root = makeRepo("detached-repo", {
      head: `${sha}\n`,
      files: {},
    });
    mockGetCurrentCanonicalRoot.mockReturnValue(root);
    const result = getGitSummary();
    expect(result.state).toBe("ok");
    expect(result.detached).toBe(true);
    expect(result.branch).toBeNull();
    expect(JSON.stringify(result)).not.toContain(sha);
  });

  it("falls back to unavailable for a malformed index (bad signature) rather than guessing", () => {
    const root = path.join(sandboxRoot, "bad-index-repo");
    fs.mkdirSync(root);
    const gitDir = path.join(root, ".git");
    fs.mkdirSync(gitDir);
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(gitDir, "index"), Buffer.from("NOTANINDEX"));
    mockGetCurrentCanonicalRoot.mockReturnValue(root);
    const result = getGitSummary();
    expect(result.state).toBe("unavailable");
    expect(result.untrackedCount).toBeNull();
    expect(result.modifiedCount).toBeNull();
    expect(result.deletedCount).toBeNull();
    expect(result.trackedChangesAvailable).toBe(false);
  });

  it("falls back to unavailable for an unsupported index version (v4, path-compressed)", () => {
    const root = path.join(sandboxRoot, "v4-index-repo");
    fs.mkdirSync(root);
    const gitDir = path.join(root, ".git");
    fs.mkdirSync(gitDir);
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    const header = Buffer.alloc(12);
    header.write("DIRC", 0, "ascii");
    header.writeUInt32BE(4, 4);
    header.writeUInt32BE(0, 8);
    fs.writeFileSync(path.join(gitDir, "index"), header);
    mockGetCurrentCanonicalRoot.mockReturnValue(root);
    expect(getGitSummary().state).toBe("unavailable");
  });

  it("falls back to unavailable for an unreadable/malformed HEAD file", () => {
    const root = path.join(sandboxRoot, "bad-head-repo");
    fs.mkdirSync(root);
    const gitDir = path.join(root, ".git");
    fs.mkdirSync(gitDir);
    fs.writeFileSync(path.join(gitDir, "HEAD"), "this is not a valid HEAD file\n");
    fs.writeFileSync(path.join(gitDir, "index"), buildGitIndexBuffer([]));
    mockGetCurrentCanonicalRoot.mockReturnValue(root);
    expect(getGitSummary().state).toBe("unavailable");
  });

  it("never returns the workspace's absolute path anywhere in the result", () => {
    const root = makeRepo("no-leak-repo", {
      head: "ref: refs/heads/main\n",
      files: { "a.txt": "x" },
    });
    mockGetCurrentCanonicalRoot.mockReturnValue(root);
    const result = getGitSummary();
    expect(JSON.stringify(result)).not.toContain(root.replace(/\\/g, "\\\\"));
  });

  it("never exposes a remote URL, credential, config content, or arbitrary .git file content", () => {
    const root = makeRepo("no-config-leak-repo", {
      head: "ref: refs/heads/main\n",
      files: { "a.txt": "x" },
    });
    fs.writeFileSync(
      path.join(root, ".git", "config"),
      '[remote "origin"]\n\turl = https://example.com/secret-repo.git\n[user]\n\temail = someone@example.com\n'
    );
    mockGetCurrentCanonicalRoot.mockReturnValue(root);
    const result = getGitSummary();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("example.com");
    expect(serialized).not.toContain("secret-repo");
    expect(Object.keys(result).sort()).toEqual(
      ["branch", "deletedCount", "detached", "modifiedCount", "state", "trackedChangesAvailable", "truncated", "untrackedCount"].sort()
    );
  });

  it("never invokes git, a shell, or child_process (no child_process usage in this module)", () => {
    // Comment-stripped: this file's own doc comment explains, in prose, that it "never
    // invokes... a shell, or `child_process`" — a naive substring check would self-trigger on
    // that sentence (the same class of issue documented elsewhere in this test suite).
    const source = fs.readFileSync(path.join(__dirname, "..", "electron", "workspaceGit.ts"), "utf8");
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/child_process|execFile|spawn\(|(?<!\.)exec\(/);
  });

  it("does not crash on any unexpected error — the whole computation is defensively wrapped", () => {
    // A directory literally named ".git" that is empty (no HEAD/index at all) must not throw.
    const root = path.join(sandboxRoot, "empty-git-dir-repo");
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(root, ".git"));
    mockGetCurrentCanonicalRoot.mockReturnValue(root);
    expect(() => getGitSummary()).not.toThrow();
    expect(getGitSummary().state).toBe("unavailable");
  });
});
