import { describe, it, expect } from "vitest";
import {
  isNavEnabled,
  resolveMainView,
  partitionEntriesForDisplay,
  shouldShowContextRail,
  gitChangedFilesSummary,
} from "../lib/workspaceShell";

describe("isNavEnabled", () => {
  it("chat and more are always enabled, even with no project", () => {
    expect(isNavEnabled("chat", false)).toBe(true);
    expect(isNavEnabled("more", false)).toBe(true);
  });

  it("explorer, search, file, git and activity require an open project", () => {
    for (const view of ["explorer", "search", "file", "git", "activity"] as const) {
      expect(isNavEnabled(view, false)).toBe(false);
      expect(isNavEnabled(view, true)).toBe(true);
    }
  });
});

describe("resolveMainView", () => {
  it("passes through a project-scoped view when a project is open", () => {
    expect(resolveMainView("explorer", true)).toBe("explorer");
    expect(resolveMainView("git", true)).toBe("git");
  });

  it("falls back to chat for a project-scoped view when no project is open", () => {
    expect(resolveMainView("explorer", false)).toBe("chat");
    expect(resolveMainView("file", false)).toBe("chat");
    expect(resolveMainView("activity", false)).toBe("chat");
  });

  it("never needs a fallback for chat or more", () => {
    expect(resolveMainView("chat", false)).toBe("chat");
    expect(resolveMainView("more", false)).toBe("more");
  });
});

describe("partitionEntriesForDisplay", () => {
  it("groups known generated/internal top-level entries into secondary, others stay primary", () => {
    const entries = [
      { name: "app", type: "dir" as const },
      { name: ".next", type: "dir" as const },
      { name: "lib", type: "dir" as const },
      { name: ".claude", type: "dir" as const },
      { name: "data", type: "dir" as const },
      { name: "package.json", type: "file" as const },
    ];
    const { primary, secondary } = partitionEntriesForDisplay(entries);
    expect(primary.map((e) => e.name)).toEqual(["app", "lib", "package.json"]);
    expect(secondary.map((e) => e.name)).toEqual([".next", ".claude", "data"]);
  });

  it("preserves relative order within each group", () => {
    const entries = [
      { name: "node_modules", type: "dir" as const },
      { name: "app", type: "dir" as const },
      { name: "coverage", type: "dir" as const },
      { name: "lib", type: "dir" as const },
    ];
    const { primary, secondary } = partitionEntriesForDisplay(entries);
    expect(primary.map((e) => e.name)).toEqual(["app", "lib"]);
    expect(secondary.map((e) => e.name)).toEqual(["node_modules", "coverage"]);
  });

  it("returns an empty secondary group when nothing matches", () => {
    const entries = [{ name: "app", type: "dir" as const }, { name: "README.md", type: "file" as const }];
    const { primary, secondary } = partitionEntriesForDisplay(entries);
    expect(primary).toHaveLength(2);
    expect(secondary).toHaveLength(0);
  });

  it("does not drop or duplicate any entry", () => {
    const entries = [
      { name: ".next", type: "dir" as const },
      { name: "app", type: "dir" as const },
    ];
    const { primary, secondary } = partitionEntriesForDisplay(entries);
    expect(primary.length + secondary.length).toBe(entries.length);
  });
});

describe("shouldShowContextRail", () => {
  it("is false with no active session, so an empty rail never consumes screen space", () => {
    expect(shouldShowContextRail(null)).toBe(false);
  });

  it("is true once a session exists", () => {
    expect(shouldShowContextRail("sess1")).toBe(true);
  });
});

describe("gitChangedFilesSummary", () => {
  it("reports a clean working tree honestly", () => {
    expect(gitChangedFilesSummary(0)).toBe("Working tree clean.");
  });

  it("uses singular phrasing for exactly one changed file", () => {
    expect(gitChangedFilesSummary(1)).toBe("1 changed file.");
  });

  it("uses plural phrasing and the real count for more than one", () => {
    expect(gitChangedFilesSummary(27)).toBe("27 changed files.");
  });
});
