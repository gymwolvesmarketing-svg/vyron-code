/**
 * Pure policy and protocol helpers for approved tool use - VYRON_CODE_APPROVED_TOOLS.
 *
 * The model never runs anything. It can only *ask*, in plain text, for one of four fixed actions; the main
 * process parses that text here, validates every field against hard limits, asks the user through a native
 * dialog (write and command actions), and only then runs a fixed implementation (electron/toolExecutors.ts)
 * confined to the workspace folder the user picked. Everything in this file is data shaping: no fs, no process,
 * no network, no Electron.
 */

export type ToolName = "list_dir" | "read_file" | "write_file" | "run_command";

export type ToolCall =
  | { readonly tool: "list_dir"; readonly path: string }
  | { readonly tool: "read_file"; readonly path: string }
  | { readonly tool: "write_file"; readonly path: string; readonly content: string }
  | { readonly tool: "run_command"; readonly command: string };

export const MAX_TOOL_STEPS = 30;
export const MAX_PATH_CHARS = 260;
export const MAX_WRITE_CHARS = 200_000;
export const MAX_COMMAND_CHARS = 1_000;
export const MAX_TOOL_OUTPUT_CHARS = 12_000;
export const MAX_TRANSCRIPT_CHARS = 60_000;
export const MAX_LOG_LINES = 20;

export type ApprovalChoice = "once" | "always" | "deny";

export interface ApprovalRequest {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  /** Stable key for "always allow": scoped to the workspace and the kind (and, for commands, the exact text). */
  readonly key: string;
}

export function needsApproval(call: ToolCall): boolean {
  return call.tool === "write_file" || call.tool === "run_command";
}

/**
 * The fixed instruction that teaches the model the four actions. It is sent as the start of the FIRST USER message (not as a
 * system message: the local agent's own system prompt says it has no tools and wins over a system message), framed as a
 * planner that can only act by writing one JSON line. Measured against the real local model, this framing made it use the
 * bridge reliably where "you have tools" wording made it answer "I have no access". It contains no path, key or user data.
 */
export const TOOL_PROTOCOL = [
  "Sen bir planlayıcısın. Görevi yapmak için Vyron Code'un araç köprüsünü kullanabilirsin; köprüye bir şey yaptırmanın tek yolu tek bir JSON nesnesi yazmaktır.",
  "Bir işlem gerekiyorsa YALNIZCA o adımın JSON'unu yaz, başka hiçbir metin ekleme. Köprü sonucu bir sonraki mesajda gelir. Mümkün biçimler:",
  '{"tool":"list_dir","path":"."}  -> klasörü listeler',
  '{"tool":"read_file","path":"src/a.txt"}  -> dosyayı okur',
  '{"tool":"write_file","path":"src/a.txt","content":"..."}  -> dosya yazar (kullanıcı onayı gerekir)',
  '{"tool":"run_command","command":"npm test"}  -> komut çalıştırır (kullanıcı onayı gerekir)',
  "Yollar çalışma klasörüne göreli olmalıdır. Kendin dosya yazmış ya da komut çalıştırmış gibi davranma: yalnızca köprü sonucunda gördüklerini söyle.",
  "Görev araç gerektirmiyorsa ya da iş bittiyse, JSON olmayan düz metinle nihai yanıtı yaz. Bir işlem reddedilirse başka bir yol dene ya da nedenini açıkla.",
  "Bir yazılım projesi üzerinde çalışıyorsun: önce klasör özetine ve ilgili dosyalara bak (README, package.json, kaynak klasörleri), projenin ne olduğunu ve nerede kaldığını anla, sonra işi adım adım ilerlet. Var olan kodu okumadan üzerine yazma.",
].join("\n");

/**
 * Measured against the real local model: about one task in three it answers a file/command task in plain text - either
 * "I have no tools" or (worse) a made-up "done, the file was created" - instead of using the bridge. So a first reply
 * that is not a tool request is answered once with this reminder; a task that really needs no tool gets the same answer
 * again. After that single reminder the reply stands, and the answer says honestly that no tool was used.
 */
export const TOOL_REMINDER =
  "Yanıtını yeniden değerlendir. Dosya listeleme, okuma, yazma ya da komut çalıştırma gereken bir görevse bunları yalnızca araç köprüsüyle yapabilirsin; kendin yapmış ya da 'oluşturuldu' demiş gibi anlatma. " +
  "Bir araç gerekiyorsa YALNIZCA ilk adımın JSON'unu yaz, başka metin ekleme. Görev gerçekten araç gerektirmiyorsa aynı yanıtı kısaca yinele.";

/**
 * The second and last reminder, for a model that still answers "I have no access". It states plainly that the bridge is
 * real and shows the exact first step, which is what finally moves a stubborn model to write the JSON.
 */
export const TOOL_REMINDER_FINAL =
  "Araç köprüsü bu konuşmada GERÇEKTEN çalışıyor: yazdığın JSON'u Vyron Code çalıştırır ve sonucu bir sonraki mesajda sana verir. Bu bir sohbet değil, gerçek bir çalışma klasörü. 'Erişimim yok' ya da 'taranmış gibi davranamam' deme. " +
  'Şimdi YALNIZCA tek bir JSON yaz; klasörü görmek için ilk adım: {"tool":"list_dir","path":"."}';

/** The first message of a tool run: the protocol followed by the user's task. */
/** `overview` is a bounded, read-only listing of the workspace folder that the main process took itself (no model involved). */
export function firstToolMessage(task: string, overview?: string | null): string {
  const folder = overview && overview.length > 0 ? "\n\nÇalışma klasörü özeti:\n" + overview : "";
  return TOOL_PROTOCOL + folder + "\n\nGörev:\n" + task;
}

function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Finds the first JSON object with a "tool" key (models wrap JSON in prose or code fences). */
function firstJsonObject(text: string): unknown {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    const end = balancedEnd(text, start);
    if (end < 0) continue;
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1));
      if (typeof parsed === "object" && parsed !== null && "tool" in parsed) return parsed;
    } catch {
      // Not valid JSON: try the next candidate.
    }
  }
  return null;
}

export type ParsedTool = { readonly kind: "call"; readonly call: ToolCall } | { readonly kind: "invalid"; readonly reason: string } | { readonly kind: "final" };

function cleanPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_PATH_CHARS) return null;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) < 32) return null;
  return text;
}

/**
 * Reads the model's reply. No JSON tool object = a final answer. A tool object with unknown names or bad fields is
 * "invalid" (the loop tells the model and lets it retry); extra fields are ignored, never forwarded.
 */
export function parseToolCall(reply: string): ParsedTool {
  const raw = firstJsonObject(reply);
  if (raw === null) return { kind: "final" };
  const record = raw as Record<string, unknown>;
  switch (record.tool) {
    case "list_dir":
    case "read_file": {
      const p = cleanPath(record.path ?? (record.tool === "list_dir" ? "." : undefined));
      return p === null ? { kind: "invalid", reason: "geçersiz yol" } : { kind: "call", call: { tool: record.tool, path: p } };
    }
    case "write_file": {
      const p = cleanPath(record.path);
      if (p === null) return { kind: "invalid", reason: "geçersiz yol" };
      if (typeof record.content !== "string") return { kind: "invalid", reason: "içerik metin olmalı" };
      if (record.content.length > MAX_WRITE_CHARS) return { kind: "invalid", reason: "içerik çok büyük" };
      return { kind: "call", call: { tool: "write_file", path: p, content: record.content } };
    }
    case "run_command": {
      const command = typeof record.command === "string" ? record.command.trim() : "";
      if (command.length === 0 || command.length > MAX_COMMAND_CHARS) return { kind: "invalid", reason: "geçersiz komut" };
      for (let i = 0; i < command.length; i += 1) {
        const code = command.charCodeAt(i);
        if ((code < 32 && code !== 9) || code === 127) return { kind: "invalid", reason: "geçersiz komut" };
      }
      return { kind: "call", call: { tool: "run_command", command } };
    }
    default:
      return { kind: "invalid", reason: "bilinmeyen araç" };
  }
}

const CATASTROPHIC = [
  /\bformat(\.com)?\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\bbcdedit\b/i,
  /\bshutdown(\.exe)?\b/i,
  /\breg(\.exe)?\s+delete\b/i,
  /\b(rd|rmdir)\s+\/s\b[^&|]*\b[a-z]:\\?\s*($|[&|])/i,
  /\bdel\s+(\/[a-z]+\s+)*[a-z]:\\\*/i,
  /\bremove-item\b[^&|]*-recurse[^&|]*\b[a-z]:\\\s*($|[&|])/i,
  /\bcipher\s+\/w\b/i,
];

/** Commands that are refused outright, even with approval (disk formatting, boot config, wiping a drive root...). */
export function isCatastrophicCommand(command: string): boolean {
  return CATASTROPHIC.some((pattern) => pattern.test(command));
}

/** Bounded plain-text result of an action, fed back to the model and shown in the log. */
export function boundOutput(text: string, max: number = MAX_TOOL_OUTPUT_CHARS): string {
  return text.length > max ? text.slice(0, max) + "\n…(kısaltıldı)" : text;
}

function firstLine(text: string, max: number): string {
  const line = text.split(/\r?\n/)[0] ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

/** The text of the native approval dialog. Names the folder, never an absolute path. */
export function approvalRequest(call: ToolCall, workspaceKey: string, folderName: string, existed: boolean | null): ApprovalRequest | null {
  if (call.tool === "write_file") {
    const size = String(call.content.length) + " karakter";
    return {
      title: "Vyron Code — dosya yazma izni",
      message: "Yapay zeka \"" + folderName + "\" klasöründe bir dosya yazmak istiyor.",
      detail: (existed ? "Var olan dosyanın ÜZERİNE YAZILACAK: " : "Yeni dosya: ") + call.path + "\n" + size + "\n\n\"Her zaman izin ver\", bu klasördeki tüm dosya yazmalarına izin verir.",
      key: "write|" + workspaceKey,
    };
  }
  if (call.tool === "run_command") {
    return {
      title: "Vyron Code — komut çalıştırma izni",
      message: "Yapay zeka \"" + folderName + "\" klasöründe bir komut çalıştırmak istiyor.",
      detail: call.command + "\n\n\"Her zaman izin ver\", yalnızca bu klasörde bu tam komuta izin verir.",
      key: "run|" + workspaceKey + "|" + call.command,
    };
  }
  return null;
}

export function describeCall(call: ToolCall): string {
  switch (call.tool) {
    case "list_dir":
      return "listeleme " + call.path;
    case "read_file":
      return "okuma " + call.path;
    case "write_file":
      return "yazma " + call.path;
    case "run_command":
      return "komut " + firstLine(call.command, 80);
  }
}

export type LogOutcome = "ok" | "denied" | "failed" | "invalid";

export interface LogEntry {
  readonly outcome: LogOutcome;
  readonly text: string;
}

export function logLine(entry: LogEntry): string {
  const mark = entry.outcome === "ok" ? "✓" : entry.outcome === "denied" ? "✗ reddedildi:" : entry.outcome === "invalid" ? "! geçersiz istek:" : "! başarısız:";
  return mark + " " + entry.text;
}

/** The closing section appended to a tool-run answer: what was actually done, in order. */
export function toolLogFooter(entries: readonly LogEntry[]): string {
  if (entries.length === 0) return "\n\n— Araç kullanılmadı: bu yanıt için hiçbir dosya okunmadı ya da yazılmadı ve hiçbir komut çalıştırılmadı.";
  const shown = entries.slice(0, MAX_LOG_LINES).map(logLine);
  const extra = entries.length > MAX_LOG_LINES ? ["… ve " + String(entries.length - MAX_LOG_LINES) + " işlem daha"] : [];
  return "\n\n— Araç günlüğü:\n" + shown.concat(extra).join("\n");
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** Keeps the newest turns within the transcript budget (the first message, the task, is always kept). */
export function trimTranscript(messages: readonly ChatMessage[]): ChatMessage[] {
  const out = messages.slice();
  let total = out.reduce((sum, m) => sum + m.content.length, 0);
  while (total > MAX_TRANSCRIPT_CHARS && out.length > 2) {
    const removed = out.splice(1, 1)[0];
    total -= removed ? removed.content.length : 0;
  }
  return out;
}

/** Flattens a transcript for a single-prompt executor (a Ruflo agent). */
export function flattenTranscript(messages: readonly ChatMessage[]): string {
  return messages.map((m) => (m.role === "assistant" ? "[Önceki yanıtın]\n" : m.role === "system" ? "[Kurallar]\n" : "[Kullanıcı / araç sonucu]\n") + m.content).join("\n\n");
}
