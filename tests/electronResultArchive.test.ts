import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { archiveDocument, archiveFileName, archiveKindForRole, archiveNote, archiveRelativePath } from "../electron/resultArchive";

const WHEN = new Date(2026, 9, 9, 12, 30, 45); // 9 Oct 2026, 12:30:45 local time

describe("result archive: which tasks are saved", () => {
  it("saves the long, expensive roles and nothing else", () => {
    expect(archiveKindForRole("council")).toBe("konsey");
    expect(archiveKindForRole("task-orchestrator")).toBe("planner");
    for (const role of ["deep-research", "deep-research-max", "deep-research-search"]) expect(archiveKindForRole(role)).toBe("arastirma");
    for (const role of ["coder", "reviewer", "tester", "planner", "researcher", "system-architect", "security-auditor", "", null, undefined, 5, {}]) expect(archiveKindForRole(role)).toBeNull();
  });
});

describe("result archive: names and document", () => {
  it("builds a local-time file name, and a suffix for a repeat so nothing is overwritten", () => {
    expect(archiveFileName(WHEN)).toBe("2026-10-09_12-30-45.md");
    expect(archiveFileName(WHEN, 2)).toBe("2026-10-09_12-30-45-2.md");
    expect(archiveFileName(new Date(2026, 0, 2, 3, 4, 5))).toBe("2026-01-02_03-04-05.md");
  });

  it("paths are exactly <kind>/<file>: a fixed subfolder, never anything the model chose", () => {
    expect(archiveRelativePath("konsey", WHEN)).toBe("konsey/2026-10-09_12-30-45.md");
    expect(archiveRelativePath("arastirma", WHEN, 3)).toBe("arastirma/2026-10-09_12-30-45-3.md");
    for (const kind of ["konsey", "planner", "arastirma"] as const) expect(archiveRelativePath(kind, WHEN)).toMatch(/^[a-z]+\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.md$/);
  });

  it("the document has a title, the date, the start of the question (quoted) and the whole answer", () => {
    const answer = "KARAR\n\n1. Madde\n2. Madde";
    const long = "S".repeat(2000);
    const text = archiveDocument("konsey", "Birinci satır\nİkinci satır " + long, answer, WHEN);
    expect(text.startsWith("# Konsey kararı — 09.10.2026 12:30\n")).toBe(true);
    expect(text).toContain("> Birinci satır\n> İkinci satır ");
    expect(text).toContain("…");
    expect(text).not.toContain("S".repeat(700));
    expect(text).toContain("## Cevap\n\nKARAR\n\n1. Madde\n2. Madde\n");
    expect(archiveDocument("planner", "q", "a", WHEN)).toContain("# Multi-Model Planner sonucu");
    expect(archiveDocument("arastirma", "q", "a", WHEN)).toContain("# Araştırma raporu");
  });

  it("the on-screen note names where the file is", () => {
    expect(archiveNote("konsey/x.md (klasör: Tahminist)")).toBe("\n\n— Kaydedildi: konsey/x.md (klasör: Tahminist)");
  });
});

describe("result archive: wiring and containment", () => {
  const dir = path.join(__dirname, "..", "electron");
  const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("the module is pure: no fs, no Electron, no network, no process", () => {
    const code = strip(fs.readFileSync(path.join(dir, "resultArchive.ts"), "utf8"));
    expect(code).not.toMatch(/\bimport\b|require\(|fetch\s*\(|process\.|node:fs|electron/);
  });

  it("main saves Konsey / Planner answers after a successful Ruflo run, and only then", () => {
    const code = strip(fs.readFileSync(path.join(dir, "main.ts"), "utf8"));
    expect(code).toContain("archiveKindForRole(agentType)");
    expect(code).toMatch(/if \(result\.ok && kind\)/);
    expect(code).toContain("tools.archive(kind, prompt, result.text)");
  });
});
