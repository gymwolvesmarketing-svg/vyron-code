/**
 * The approved-tool loop - VYRON_CODE_APPROVED_TOOLS. Pure and dependency-injected (no Electron, fs, process or network).
 *
 * Each round the model is asked for its next move. A plain-text reply ends the task; a JSON tool request is parsed and
 * validated (electron/toolPolicy.ts), sent to the user for approval when it writes a file or runs a command, executed by
 * a fixed implementation confined to the workspace folder, and its bounded result is fed back. At most MAX_TOOL_STEPS
 * actions run per task, and the answer ends with a log of what was really done or refused.
 */
import {
  MAX_TOOL_STEPS,
  TOOL_PROTOCOL,
  approvalRequest,
  boundOutput,
  describeCall,
  needsApproval,
  parseToolCall,
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
}

export type ToolLoopResult = { readonly ok: true; readonly text: string } | { readonly ok: false };

export async function runToolLoop(deps: ToolLoopDeps, task: string): Promise<ToolLoopResult> {
  let messages: ChatMessage[] = [
    { role: "system", content: TOOL_PROTOCOL },
    { role: "user", content: task },
  ];
  const log: LogEntry[] = [];

  for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
    const reply = await deps.ask(trimTranscript(messages));
    if (reply === null) return { ok: false };
    const parsed = parseToolCall(reply);
    if (parsed.kind === "final") return { ok: true, text: reply + toolLogFooter(log) };

    let feedback: string;
    if (parsed.kind === "invalid") {
      log.push({ outcome: "invalid", text: parsed.reason });
      feedback = "Geçersiz araç isteği (" + parsed.reason + "). Biçime uy ya da nihai yanıtı düz metin olarak yaz.";
    } else {
      feedback = await handle(deps, parsed.call, log);
    }
    messages = messages.concat([
      { role: "assistant", content: reply },
      { role: "user", content: feedback },
    ]);
  }

  // Step budget used up: ask once, without tools, for the final answer.
  messages = messages.concat({ role: "user", content: "Adım sınırına ulaşıldı. Araç kullanmadan, şimdiye kadarki işi özetleyen nihai yanıtı düz metin olarak yaz." });
  const closing = await deps.ask(trimTranscript(messages));
  if (closing === null) return { ok: false };
  const parsedClosing = parseToolCall(closing);
  const text = parsedClosing.kind === "final" ? closing : "Adım sınırına ulaşıldı; iş tamamlanamadı.";
  return { ok: true, text: text + toolLogFooter(log) };
}

async function handle(deps: ToolLoopDeps, call: ToolCall, log: LogEntry[]): Promise<string> {
  const workspace = deps.workspace();
  if (workspace === null) {
    log.push({ outcome: "failed", text: describeCall(call) + " — çalışma klasörü seçili değil" });
    return "Araç sonucu: çalışma klasörü seçili değil.";
  }
  if (needsApproval(call)) {
    const existed = call.tool === "write_file" ? deps.fileExists(call.path) : null;
    const request = approvalRequest(call, workspace.key, workspace.folderName, existed);
    const choice: ApprovalChoice = request === null ? "deny" : await deps.approve(request);
    if (choice === "deny") {
      log.push({ outcome: "denied", text: describeCall(call) });
      return "Araç sonucu: kullanıcı bu işlemi reddetti.";
    }
  }
  const result = await deps.execute(call);
  log.push({ outcome: result.ok ? "ok" : "failed", text: describeCall(call) });
  return "Araç sonucu (" + call.tool + "):\n" + boundOutput(result.text);
}
