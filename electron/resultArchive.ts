/**
 * Result archive - names and documents only. Pure: no fs, no Electron, no network.
 *
 * Long answers (a Konsey decision, a Planner run, a research report) take minutes and cost real money, yet a crash or a
 * history reset used to lose them with the screen. When one of these tasks finishes, the main process writes its answer to a
 * Markdown file: into the workspace folder's fixed subfolder when one is granted (electron/toolAdapters.ts goes through the
 * same confined writer the tools use), otherwise into the app's own data folder. This module decides the subfolder, the file
 * name and the document text; it never decides a path outside those fixed shapes.
 */

export type ArchiveKind = "konsey" | "planner" | "arastirma";

const KIND_LABEL: Readonly<Record<ArchiveKind, string>> = {
  konsey: "Konsey kararı",
  planner: "Multi-Model Planner sonucu",
  arastirma: "Araştırma raporu",
};

/** The subfolder an archive kind is written to (also the kind's own name). */
export function archiveFolder(kind: ArchiveKind): string {
  return kind;
}

/** Which tasks are archived: the Manager roles whose answers are long and expensive. Everything else is not saved. */
export function archiveKindForRole(role: unknown): ArchiveKind | null {
  switch (role) {
    case "council":
      return "konsey";
    case "task-orchestrator":
      return "planner";
    case "deep-research":
    case "deep-research-max":
    case "deep-research-search":
      return "arastirma";
    default:
      return null;
  }
}

function two(value: number): string {
  return value < 10 ? "0" + String(value) : String(value);
}

/** Local-time file name: 2026-10-09_12-30-45.md; attempt 2+ gets a "-2" suffix so a file is never overwritten. */
export function archiveFileName(date: Date, attempt: number = 1): string {
  const stamp =
    String(date.getFullYear()) + "-" + two(date.getMonth() + 1) + "-" + two(date.getDate()) + "_" + two(date.getHours()) + "-" + two(date.getMinutes()) + "-" + two(date.getSeconds());
  return stamp + (attempt > 1 ? "-" + String(attempt) : "") + ".md";
}

/** The path relative to the workspace folder (or to the app's archive folder): "konsey/2026-10-09_12-30-45.md". */
export function archiveRelativePath(kind: ArchiveKind, date: Date, attempt: number = 1): string {
  return archiveFolder(kind) + "/" + archiveFileName(date, attempt);
}

const MAX_QUESTION_HEAD = 600;

function readableDate(date: Date): string {
  return two(date.getDate()) + "." + two(date.getMonth() + 1) + "." + String(date.getFullYear()) + " " + two(date.getHours()) + ":" + two(date.getMinutes());
}

/** The Markdown document: title, when, the start of the question (for orientation) and the full answer. */
export function archiveDocument(kind: ArchiveKind, question: string, answer: string, date: Date): string {
  const head = question.trim();
  const shortHead = head.length > MAX_QUESTION_HEAD ? head.slice(0, MAX_QUESTION_HEAD - 1) + "…" : head;
  return (
    "# " + KIND_LABEL[kind] + " — " + readableDate(date) + "\n\n" +
    "Bu dosya Vyron Code tarafından otomatik kaydedildi (cevap ekranda da görünür).\n\n" +
    "## Soru (başlangıcı)\n\n" +
    shortHead.split("\n").map((line) => "> " + line).join("\n") + "\n\n" +
    "## Cevap\n\n" +
    answer.trim() + "\n"
  );
}

/** The line added under the answer on screen. `where` is what the user should look for. */
export function archiveNote(where: string): string {
  return "\n\n— Kaydedildi: " + where;
}
