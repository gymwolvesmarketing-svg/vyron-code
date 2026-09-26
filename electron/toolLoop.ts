/**
 * The approved-tool loop - VYRON_CODE_APPROVED_TOOLS. Pure and dependency-injected (no Electron, fs, process or network).
 *
 * Each round the model is asked for its next move. A plain-text reply ends the task; a JSON tool request is parsed and
 * validated (electron/toolPolicy.ts), sent to the user for approval when it writes a file or runs a command, executed by
 * a fixed implementation confined to the workspace folder, and its bounded result is fed back. At most MAX_TOOL_STEPS
 * actions run per task, and the answer ends with a log of what was really done or refused.
 */
import {
  MAX_CALLS_PER_REPLY,
  MAX_TOOL_CALLS,
  MAX_TOOL_OUTPUT_CHARS,
  MAX_TOOL_STEPS,
  approvalRequest,
  boundOutput,
  describeCall,
  TOOL_REMINDER,
  TOOL_REMINDER_FINAL,
  firstToolMessage,
  needsApproval,
  parseToolCalls,
  toolLogFooter,
  trimTranscript,
  type ApprovalChoice,
  type ApprovalRequest,
  type ChatMessage,
  type LogEntry,
  type ToolCall,
} from "./toolPolicy";

export interface ToolWorkspace {
  /** Stable id of the granted folder (used to scope "always allow"); never an absolute path. */
  readonly key: string;
  /** Folder name shown to the user. */
  readonly folderName: string;
}

export interface ToolLoopDeps {
  ask(messages: readonly ChatMessage[]): Promise<string | null>;
  workspace(): ToolWorkspace | null;
  /** Asks the user (or consults saved "always" permissions). */
  approve(request: ApprovalRequest): Promise<ApprovalChoice>;
  execute(call: ToolCall): Promise<{ readonly ok: boolean; readonly text: string }>;
  /** Whether a file to be written already exists (only used to word the approval); null = unknown. */
  fileExists(relativePath: string): boolean | null;
  /** A bounded read-only picture of the workspace folder (tree + key files), taken by the main process; null = none. */
  overview?(): string | null;
}

export type ToolLoopResult = { readonly ok: true; readonly text: string } | { readonly ok: false };

export async function runToolLoop(deps: ToolLoopDeps, task: string): Promise<ToolLoopResult> {
  let messages: ChatMessage[] = [{ role: "user", content: firstToolMessage(task, deps.workspace() === null ? null : (deps.overview?.() ?? null)) }];
  const log: LogEntry[] = [];
  let reminders = 0;
  let executed = 0;

  for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
    const reply = await deps.ask(trimTranscript(messages));
    if (reply === null) return interrupted(log);
    const requests = parseToolCalls(reply);
    if (requests.length === 0) {
      // A plain reply before any tool ran is challenged twice (models invent "done" or "no tools"); after that it stands.
      if (reminders < 2 && log.length === 0) {
        reminders += 1;
        messages = messages.concat([
          { role: "assistant", content: reply },
          { role: "user", content: reminders === 1 ? TOOL_REMINDER : TOOL_REMINDER_FINAL },
        ]);
        continue;
      }
      return { ok: true, text: reply + toolLogFooter(log) };
    }

    // One reply can carry several requests (a model reads three files at once): they run in order, each result is labelled.
    const perResult = Math.min(MAX_TOOL_OUTPUT_CHARS, Math.floor((3 * MAX_TOOL_OUTPUT_CHARS) / Math.max(1, requests.length)));
    const parts: string[] = [];
    for (const request of requests.slice(0, MAX_CALLS_PER_REPLY)) {
      if (request.kind === "invalid") {
        log.push({ outcome: "invalid", text: request.reason });
        parts.push("Geçersiz araç isteği (" + request.reason + "). Biçime uy.");
      } else if (executed >= MAX_TOOL_CALLS) {
        log.push({ outcome: "failed", text: describeCall(request.call) + " — araç çağrısı sınırına ulaşıldı" });
        parts.push("Araç çağrısı sınırına ulaşıldı; bu istek çalıştırılmadı.");
      } else {
        executed += 1;
        parts.push(await handle(deps, request.call, log, perResult));
      }
    }
    const feedback = requests.length === 1 ? (parts[0] ?? "") : parts.map((part, index) => "[" + String(index + 1) + "/" + String(parts.length) + "] " + part).join("\n\n");
    messages = messages.concat([
      { role: "assistant", content: reply },
      { role: "user", content: feedback },
    ]);
  }

  // Step budget used up: ask once, without tools, for the final answer.
  messages = messages.concat({ role: "user", content: "Adım sınırına ulaşıldı. Araç kullanmadan, şimdiye kadarki işi özetleyen nihai yanıtı düz metin olarak yaz." });
  const closing = await deps.ask(trimTranscript(messages));
  if (closing === null) return interrupted(log);
  const text = parseToolCalls(closing).length === 0 ? closing : "Adım sınırına ulaşıldı; iş tamamlanamadı.";
  return { ok: true, text: text + toolLogFooter(log) };
}

/**
 * The model stopped answering half way. When tools already did something the user must not lose that: the answer says so
 * plainly and lists what really happened. Nothing done yet = an ordinary failure.
 */
function interrupted(log: LogEntry[]): ToolLoopResult {
  if (log.length === 0) return { ok: false };
  return { ok: true, text: "Model yanıt vermeyi bıraktı; iş yarım kaldı. Şimdiye kadar yapılanlar aşağıda; aynı görevi tekrar göndererek kaldığın yerden devam edebilirsin." + toolLogFooter(log) };
}

async function handle(deps: ToolLoopDeps, call: ToolCall, log: LogEntry[], maxOutput: number = MAX_TOOL_OUTPUT_CHARS): Promise<string> {
  const workspace = deps.workspace();
  if (workspace === null) {
    log.push({ outcome: "failed", text: describeCall(call) + " — çalışma klasörü seçili değil" });
    return "Araç sonucu: çalışma klasörü seçili değil. Sonraki adımın JSON'unu yaz ya da düz metinle yanıtla.";
  }
  if (needsApproval(call)) {
    const existed = call.tool === "write_file" ? deps.fileExists(call.path) : null;
    const request = approvalRequest(call, workspace.key, workspace.folderName, existed);
    const choice: ApprovalChoice = request === null ? "deny" : await deps.approve(request);
    if (choice === "deny") {
      log.push({ outcome: "denied", text: describeCall(call) });
      return "Araç sonucu: kullanıcı bu işlemi reddetti. Sonraki adımın JSON'unu yaz ya da düz metinle yanıtla.";
    }
  }
  const result = await deps.execute(call);
  log.push({ outcome: result.ok ? "ok" : "failed", text: describeCall(call) });
  return "Araç sonucu (" + call.tool + "):\n" + boundOutput(result.text, maxOutput) + "\n\nSonraki adımın JSON'unu yaz; iş bittiyse JSON olmayan düz metinle nihai yanıtı ver.";
}
