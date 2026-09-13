import { describe, it, expect } from "vitest";
import { parseDiffHunks, findHunk } from "../lib/gitHunks";

const SAMPLE_DIFF = [
  "diff --git a/foo.ts b/foo.ts",
  "index 111..222 100644",
  "--- a/foo.ts",
  "+++ b/foo.ts",
  "@@ -1,3 +1,4 @@",
  " line1",
  "+added line",
  " line2",
  " line3",
  "@@ -10,2 +11,3 @@",
  " line10",
  "+another added line",
  " line11",
].join("\n");

describe("parseDiffHunks", () => {
  it("splits a diff into one entry per @@ header, each carrying only its own body lines", () => {
    const hunks = parseDiffHunks(SAMPLE_DIFF);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.header).toBe("@@ -1,3 +1,4 @@");
    expect(hunks[0]?.body).toContain("+added line");
    expect(hunks[0]?.body).not.toContain("+another added line");
    expect(hunks[1]?.header).toBe("@@ -10,2 +11,3 @@");
    expect(hunks[1]?.body).toContain("+another added line");
  });

  it("assigns sequential indices starting at 0", () => {
    const hunks = parseDiffHunks(SAMPLE_DIFF);
    expect(hunks.map((h) => h.index)).toEqual([0, 1]);
  });

  it("returns an empty array for a diff with no hunks (e.g. a rename-only change)", () => {
    expect(parseDiffHunks("diff --git a/x b/y\nsimilarity index 100%\nrename from x\nrename to y")).toHaveLength(0);
  });

  it("stops a file's hunks at the next 'diff --git' section instead of merging them", () => {
    const twoFileDiff = SAMPLE_DIFF + "\ndiff --git a/bar.ts b/bar.ts\n@@ -1,1 +1,1 @@\n-old\n+new";
    const hunks = parseDiffHunks(twoFileDiff);
    expect(hunks).toHaveLength(3);
    expect(hunks[2]?.header).toBe("@@ -1,1 +1,1 @@");
    expect(hunks[2]?.body).toContain("+new");
    expect(hunks[0]?.body).not.toContain("+new");
  });
});

describe("findHunk", () => {
  it("finds a hunk by matching header at the recorded index", () => {
    const hunk = findHunk(SAMPLE_DIFF, "@@ -10,2 +11,3 @@", 1);
    expect(hunk?.body).toContain("+another added line");
  });

  it("falls back to a header-only match when the index has shifted", () => {
    const hunk = findHunk(SAMPLE_DIFF, "@@ -10,2 +11,3 @@", 5);
    expect(hunk?.header).toBe("@@ -10,2 +11,3 @@");
  });

  it("returns null when no hunk with that header exists any more (the file changed) — the stale case", () => {
    expect(findHunk(SAMPLE_DIFF, "@@ -99,1 +99,1 @@", 0)).toBeNull();
  });
});
