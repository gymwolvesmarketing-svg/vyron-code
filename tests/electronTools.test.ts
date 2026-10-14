import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_CALLS_PER_REPLY,
  MAX_TOOL_CALLS,
  MAX_ACTION_NUDGES,
  MAX_COMMAND_CHARS,
  MAX_LOG_LINES,
  MAX_PATH_CHARS,
  MAX_TOOL_OUTPUT_CHARS,
  MAX_TOOL_STEPS,
  MAX_TRANSCRIPT_CHARS,
  MAX_WRITE_CHARS,
  TOOL_CUT_OFF_NUDGE,
  TOOL_NUDGE,
  TOOL_PROTOCOL,
  TOOL_REMINDER,
  TOOL_REMINDER_FINAL,
  firstToolMessage,
  approvalRequest,
  boundOutput,
  flattenTranscript,
  isCatastrophicCommand,
  isEmptyOrAnnouncement,
  looksLikeCutOffToolCall,
  isReadOnlyCommand,
  needsApproval,
  parseToolCall,
  parseToolCalls,
  toolLogFooter,
  trimTranscript,
  type ApprovalChoice,
  type ApprovalRequest,
  type ChatMessage,
  type ToolCall,
  describeCall,
  isBlockedBrowserHost,
  isPrivateAddress,
  parseBrowserUrl,
  shortUrl,
} from "../electron/toolPolicy";
import { commandEnvironment, listDir, projectOverview, readFile, resolveWritable, runCommand, writeFile } from "../electron/toolExecutors";
import { runToolLoop, type ToolLoopDeps } from "../electron/toolLoop";
import { MAX_RUFLO_ASK_CHARS } from "../electron/rufloBridge";

vi.mock("electron", () => ({ clipboard: { writeText: () => undefined }, app: { getPath: () => os.tmpdir() }, dialog: {} }));

// ------------------------------------------------------------------------------------------------ policy

describe("tool protocol and parsing", () => {
  it("the protocol names exactly the four actions and no path, key or secret", () => {
    for (const tool of ["list_dir", "read_file", "write_file", "run_command"]) expect(TOOL_PROTOCOL).toContain('"tool":"' + tool + '"');
    expect(TOOL_PROTOCOL).not.toMatch(/[A-Za-z]:\\|api|key|token/i);
  });

  it("parses each tool, tolerating prose and code fences around the JSON", () => {
    expect(parseToolCall('{"tool":"list_dir","path":"src"}')).toEqual({ kind: "call", call: { tool: "list_dir", path: "src" } });
    expect(parseToolCall('{"tool":"list_dir"}')).toEqual({ kind: "call", call: { tool: "list_dir", path: "." } });
    expect(parseToolCall("Önce bakayım:\n```json\n" + '{"tool":"read_file","path":"a.txt"}' + "\n```")).toEqual({ kind: "call", call: { tool: "read_file", path: "a.txt" } });
    expect(parseToolCall('{"tool":"write_file","path":"a/b.txt","content":"x } y"}')).toEqual({ kind: "call", call: { tool: "write_file", path: "a/b.txt", content: "x } y" } });
    expect(parseToolCall('{"tool":"run_command","command":"  npm test  "}')).toEqual({ kind: "call", call: { tool: "run_command", command: "npm test" } });
  });

  it("treats a reply without a tool object as the final answer, including unrelated JSON", () => {
    expect(parseToolCall("Bitti. Sonuç: 42")).toEqual({ kind: "final" });
    expect(parseToolCall('{"sonuc": 1}')).toEqual({ kind: "final" });
    expect(parseToolCall("{ kapanmamış")).toEqual({ kind: "final" });
    expect(parseToolCall("")).toEqual({ kind: "final" });
  });

  it("finds a later tool object after an unrelated one", () => {
    expect(parseToolCall('{"a":1} sonra {"tool":"read_file","path":"x"}')).toEqual({ kind: "call", call: { tool: "read_file", path: "x" } });
  });

  it("rejects unknown tools and bad fields, never forwarding extra fields", () => {
    for (const bad of [
      '{"tool":"delete_everything","path":"."}',
      '{"tool":"read_file"}',
      '{"tool":"read_file","path":5}',
      '{"tool":"read_file","path":""}',
      '{"tool":"write_file","path":"a"}',
      '{"tool":"write_file","path":"a","content":5}',
      '{"tool":"run_command","command":""}',
      '{"tool":"run_command","command":5}',
      '{"tool":5}',
    ]) {
      expect(parseToolCall(bad).kind, bad).toBe("invalid");
    }
    const call = parseToolCall('{"tool":"read_file","path":"a","env":{"X":"1"},"cwd":"C:\\\\"}');
    expect(call).toEqual({ kind: "call", call: { tool: "read_file", path: "a" } });
  });

  it("enforces the length and character limits", () => {
    expect(parseToolCall(JSON.stringify({ tool: "read_file", path: "a".repeat(MAX_PATH_CHARS + 1) })).kind).toBe("invalid");
    expect(parseToolCall(JSON.stringify({ tool: "write_file", path: "a", content: "x".repeat(MAX_WRITE_CHARS + 1) })).kind).toBe("invalid");
    expect(parseToolCall(JSON.stringify({ tool: "write_file", path: "a", content: "x".repeat(MAX_WRITE_CHARS) })).kind).toBe("call");
    expect(parseToolCall(JSON.stringify({ tool: "run_command", command: "x".repeat(MAX_COMMAND_CHARS + 1) })).kind).toBe("invalid");
    expect(parseToolCall(JSON.stringify({ tool: "read_file", path: "a" + String.fromCharCode(0) + "b" })).kind).toBe("invalid");
    expect(parseToolCall(JSON.stringify({ tool: "run_command", command: "echo" + String.fromCharCode(10) + "calc" })).kind).toBe("invalid");
  });

  it("only writes and commands need approval", () => {
    const calls: ToolCall[] = [
      { tool: "list_dir", path: "." },
      { tool: "read_file", path: "a" },
      { tool: "write_file", path: "a", content: "" },
      { tool: "run_command", command: "npm test" },
      { tool: "run_command", command: "git status" },
    ];
    expect(calls.map(needsApproval)).toEqual([false, false, true, true, false]);
  });

  it("isReadOnlyCommand lets pure reads through and never anything that can write, chain or leave the folder", () => {
    for (const ok of ["git status", "git log --oneline -n 5", "git diff --stat", "ls", "dir", "pwd", "cat package.json", "type docs\a.md", "node --version", "docker -v", "npm -v", "head -n 20 README.md", "echo merhaba"]) {
      expect(isReadOnlyCommand(ok), ok).toBe(true);
    }
    for (const bad of ["", "npm test", "node build.js", "git push", "git commit -m x", "git log --output=x.txt", "git -c core.pager=x log", "git branch -D x", "echo a > b.txt", "cat a | sh", "cat a && rm b", "echo $(whoami)", "echo %PATH%", "cat ../x", "type C:\Windows\win.ini", "cat /etc/passwd", "cat ~/.ssh/id_rsa", "dir; calc", "curl -s https://x.io", "rm -rf build", "del a.txt"]) {
      expect(isReadOnlyCommand(bad), bad).toBe(false);
    }
  });
});

describe("approval wording and safety helpers", () => {
  it("names the folder (never a path), the target and the scope, and scopes keys to the workspace", () => {
    const write = approvalRequest({ tool: "write_file", path: "src/a.ts", content: "abc" }, "ws1", "Proje", true)!;
    expect(write.message).toContain('"Proje"');
    expect(write.detail).toContain("ÜZERİNE YAZILACAK: src/a.ts");
    expect(write.detail).toContain("3 karakter");
    expect(write.key).toBe("write|ws1");
    const fresh = approvalRequest({ tool: "write_file", path: "n.txt", content: "" }, "ws1", "Proje", false)!;
    expect(fresh.detail).toContain("Yeni dosya: n.txt");
    const run = approvalRequest({ tool: "run_command", command: "npm test" }, "ws1", "Proje", null)!;
    expect(run.detail).toContain("npm test");
    expect(run.key).toBe("run|ws1");
    expect(run.offerTask).toBe(true);
    expect(write.offerTask).toBe(true);
    expect(approvalRequest({ tool: "read_file", path: "a" }, "ws1", "P", null)).toBeNull();
    // "Bu klasörde her zaman izin ver" covers every command of the folder (the catastrophic ones are refused regardless).
    expect(run.key).toBe(approvalRequest({ tool: "run_command", command: "npm test " + "&& calc" }, "ws1", "Proje", null)!.key);
    expect(run.key).not.toBe(approvalRequest({ tool: "run_command", command: "npm test" }, "ws2", "Proje", null)!.key);
  });

  it("refuses catastrophic commands and lets ordinary ones through", () => {
    for (const bad of ["format c:", "diskpart", "bcdedit /set x", "shutdown /s /t 0", "reg delete HKLM\\Software /f", "rd /s /q C:\\", "del /s /q C:\\*", "cipher /w:C:"]) {
      expect(isCatastrophicCommand(bad), bad).toBe(true);
    }
    for (const ok of ["npm test", "git status", "dir", "node build.js", "echo hi", "rd /s /q build", "del temp.txt"]) expect(isCatastrophicCommand(ok), ok).toBe(false);
  });

  it("bounds output, builds a capped log footer and trims transcripts while keeping the task", () => {
    expect(boundOutput("x".repeat(MAX_TOOL_OUTPUT_CHARS + 50))).toContain("(kısaltıldı)");
    expect(boundOutput("kısa")).toBe("kısa");
    expect(toolLogFooter([])).toContain("Araç kullanılmadı");
    const many = Array.from({ length: MAX_LOG_LINES + 3 }, () => ({ outcome: "ok" as const, text: "yazma a" }));
    const footer = toolLogFooter(many);
    expect(footer).toContain("Araç günlüğü");
    expect(footer).toContain("… ve 3 işlem daha");
    expect(toolLogFooter([{ outcome: "denied", text: "komut x" }])).toContain("✗ reddedildi: komut x");
    const big: ChatMessage[] = [
      { role: "system", content: "S" },
      { role: "user", content: "GÖREV" },
      ...Array.from({ length: 12 }, (_v, i) => ({ role: "user" as const, content: String(i) + "x".repeat(5000) })),
    ];
    const trimmed = trimTranscript(big);
    expect(trimmed[0]!.content).toBe("S");
    expect(trimmed.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS + 5100);
    expect(trimmed[trimmed.length - 1]!.content.startsWith("11")).toBe(true);
    expect(flattenTranscript([{ role: "user", content: "a" }, { role: "assistant", content: "b" }])).toContain("[Önceki yanıtın]");
  });
});

// ------------------------------------------------------------------------------------------------ executors

describe("tool executors (real files, confined to the workspace root)", () => {
  let base: string;
  let root: string;
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "vyron-tools-"));
    root = path.join(base, "ws");
  });
  // The workspace is created per test so realpath resolves after mkdir.
  function makeRoot(): void {
    fs.mkdirSync(path.join(base, "ws", "src"), { recursive: true });
    root = fs.realpathSync.native(path.join(base, "ws"));
    fs.writeFileSync(path.join(root, "hello.txt"), "merhaba", "utf8");
    fs.writeFileSync(path.join(root, ".env"), "SECRET=1", "utf8");
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(base, "outside.txt"), "dışarıda", "utf8");
  }
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("lists and reads inside the root, and refuses secrets, escapes and absolute paths", () => {
    makeRoot();
    expect(listDir(root, ".").text.split("\n").sort()).toEqual([".env", "hello.txt", "node_modules/", "src/"].sort());
    expect(readFile(root, "hello.txt")).toEqual({ ok: true, text: "merhaba" });
    for (const bad of [".env", "node_modules", "../outside.txt", "..\\outside.txt", path.join(base, "outside.txt"), "C:\\Windows\\win.ini", "src/../../outside.txt"]) {
      expect(readFile(root, bad).ok, bad).toBe(false);
    }
    expect(listDir(root, "hello.txt").ok).toBe(false);
    expect(readFile(root, "src").ok).toBe(false);
    expect(readFile(root, "yok.txt").ok).toBe(false);
  });

  it("refuses binary and oversized files", () => {
    makeRoot();
    fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([1, 2, 0, 3]));
    expect(readFile(root, "bin.dat")).toMatchObject({ ok: false });
    fs.writeFileSync(path.join(root, "big.txt"), "x".repeat(300_000));
    expect(readFile(root, "big.txt")).toMatchObject({ ok: false });
  });

  it("writes new files (creating folders) and overwrites existing ones, only inside the root", () => {
    makeRoot();
    expect(writeFile(root, "src/yeni/a.txt", "içerik")).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(root, "src", "yeni", "a.txt"), "utf8")).toBe("içerik");
    expect(writeFile(root, "hello.txt", "değişti")).toMatchObject({ ok: true, text: expect.stringContaining("üzerine yazıldı") });
    expect(fs.readFileSync(path.join(root, "hello.txt"), "utf8")).toBe("değişti");
    const w = resolveWritable(root, "src/z.txt");
    expect(w).toMatchObject({ ok: true, existed: false });
    expect(resolveWritable(root, "hello.txt")).toMatchObject({ ok: true, existed: true });
  });

  it("refuses every escape and denied name when writing", () => {
    makeRoot();
    const before = fs.readdirSync(base).sort();
    for (const bad of ["../evil.txt", "src/../../evil.txt", "..\\evil.txt", path.join(base, "evil.txt"), "C:\\evil.txt", ".env", "src/.env", ".git/config", "node_modules/x.js", "a.pem", "id_rsa", "con:", "a<b.txt", "trail.", "", ".", "src"]) {
      expect(writeFile(root, bad, "x").ok, bad).toBe(false);
    }
    expect(fs.readdirSync(base).sort()).toEqual(before);
    expect(fs.readFileSync(path.join(root, ".env"), "utf8")).toBe("SECRET=1");
    expect(writeFile(root, "a.txt", "x".repeat(MAX_WRITE_CHARS + 1)).ok).toBe(false);
  });

  it("does not follow a junction that points outside the root", () => {
    makeRoot();
    const outside = path.join(base, "outdir");
    fs.mkdirSync(outside);
    try {
      fs.symlinkSync(outside, path.join(root, "link"), "junction");
    } catch {
      return; // links unavailable on this machine: nothing to verify
    }
    expect(writeFile(root, "link/pwned.txt", "x").ok).toBe(false);
    expect(fs.existsSync(path.join(outside, "pwned.txt"))).toBe(false);
    expect(readFile(root, "link/anything").ok).toBe(false);
  });

  it("runs a command in the workspace with an allowlisted environment and reports the exit code and output", async () => {
    makeRoot();
    const ok = await runCommand(root, "cd && echo merhaba");
    expect(ok.ok).toBe(true);
    expect(ok.text).toContain("Çıkış kodu: 0");
    expect(ok.text.toLowerCase()).toContain(root.toLowerCase());
    expect(ok.text).toContain("merhaba");
    const failed = await runCommand(root, "exit 3");
    expect(failed).toMatchObject({ ok: false });
    expect(failed.text).toContain("Çıkış kodu: 3");
  });

  it("never leaks a credential-like variable into a command", async () => {
    makeRoot();
    process.env.HERMES_API_KEY = "LEAK-CANARY-1";
    process.env.OPENROUTER_API_KEY = "LEAK-CANARY-2";
    try {
      const result = await runCommand(root, "set");
      expect(result.text).not.toContain("LEAK-CANARY");
      const env = commandEnvironment({ Path: "C:\\x", SYSTEMROOT: "C:\\Windows", HERMES_API_KEY: "k", NODE_OPTIONS: "--x", Temp: "C:\\t" });
      expect(Object.keys(env).sort()).toEqual(["PATH", "SystemRoot", "TEMP"].sort());
    } finally {
      delete process.env.HERMES_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it("stops a command that runs too long, refuses catastrophic ones and bounds output", async () => {
    makeRoot();
    const slow = await runCommand(root, "ping -n 30 127.0.0.1", 700);
    expect(slow.ok).toBe(false);
    expect(slow.text).toContain("durduruldu");
    expect(await runCommand(root, "format c:")).toMatchObject({ ok: false, text: expect.stringContaining("güvenlik") });
    const loud = await runCommand(root, "for /L %i in (1,1,4000) do @echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(loud.text.length).toBeLessThan(MAX_TOOL_OUTPUT_CHARS + 200);
  }, 30_000);
});

// ------------------------------------------------------------------------------------------------ loop

function makeDeps(script: Array<string | null>, overrides: Partial<ToolLoopDeps> = {}) {
  const seen: ChatMessage[][] = [];
  const approvals: ApprovalRequest[] = [];
  const executed: ToolCall[] = [];
  let i = 0;
  const deps: ToolLoopDeps = {
    ask: async (messages) => {
      seen.push(messages.slice());
      if (i >= script.length) return "SON";
      return script[i++] as string | null;
    },
    workspace: () => ({ key: "ws1", folderName: "Proje" }),
    approve: async (request) => {
      approvals.push(request);
      return "once";
    },
    execute: async (call) => {
      executed.push(call);
      return { ok: true, text: "tamam: " + call.tool };
    },
    fileExists: () => false,
    ...overrides,
  };
  return { deps, seen, approvals, executed };
}

describe("runToolLoop", () => {
  it("starts with the protocol and the task, then feeds tool results back and ends with a log", async () => {
    const { deps, seen, executed, approvals } = makeDeps(['{"tool":"list_dir","path":"."}', '{"tool":"read_file","path":"a.txt"}', "Bitti: özet"]);
    const result = await runToolLoop(deps, "GÖREV METNİ");
    expect(seen[0]).toEqual([{ role: "user", content: firstToolMessage("GÖREV METNİ") }]);
    expect(seen[0]![0]!.content.startsWith(TOOL_PROTOCOL)).toBe(true);
    expect(seen[0]![0]!.content.endsWith("Görev:\nGÖREV METNİ")).toBe(true);
    expect(seen.every((messages) => messages.every((m) => m.role !== "system"))).toBe(true);
    expect(seen[1]!.at(-1)!.content).toContain("Araç sonucu (list_dir)");
    expect(executed.map((c) => c.tool)).toEqual(["list_dir", "read_file"]);
    expect(approvals).toHaveLength(0);
    expect(result.ok && result.text).toContain("Bitti: özet");
    expect(result.ok && result.text).toContain("✓ listeleme .");
    expect(result.ok && result.text).toContain("✓ okuma a.txt");
  });

  it("asks before every write and command, executes only after approval, and reports a refusal to the model", async () => {
    const choices: ApprovalChoice[] = ["once", "deny", "always"];
    const { deps, approvals, executed, seen } = makeDeps(
      ['{"tool":"write_file","path":"a.txt","content":"1"}', '{"tool":"run_command","command":"npm test"}', '{"tool":"write_file","path":"b.txt","content":"2"}', "SON"],
      { approve: async (request) => (approvals.push(request), choices.shift() ?? "deny") },
    );
    const result = await runToolLoop(deps, "g");
    expect(approvals.map((a) => a.key)).toEqual(["write|ws1", "run|ws1", "write|ws1"]);
    expect(executed.map((c) => c.tool)).toEqual(["write_file", "write_file"]);
    expect(seen[2]!.at(-1)!.content).toContain("kullanıcı bu işlemi reddetti");
    expect(result.ok && result.text).toContain("✗ reddedildi: komut npm test");
  });

  it("'task' covers every later write and command of this run but never a page action, and a read-only command is not asked at all", async () => {
    const asked: string[] = [];
    const { deps, executed } = makeDeps(
      ['{"tool":"write_file","path":"a.txt","content":"1"}', '{"tool":"run_command","command":"npm test"}', '{"tool":"write_file","path":"b.txt","content":"2"}', '{"tool":"run_command","command":"git status"}', "SON"],
      { approve: async (request) => (asked.push(request.key), "task") },
    );
    await runToolLoop(deps, "g");
    expect(asked).toEqual(["write|ws1"]);
    expect(executed.map((c) => c.tool)).toEqual(["write_file", "run_command", "write_file", "run_command"]);
  });

  it("does not run a tool when the approval helper cannot describe it (safe default = deny)", async () => {
    const { deps, executed } = makeDeps(['{"tool":"run_command","command":"npm test"}', "SON"], { approve: async () => "deny" });
    await runToolLoop(deps, "g");
    expect(executed).toHaveLength(0);
  });

  it("reports a missing workspace folder to the model instead of acting", async () => {
    const { deps, executed } = makeDeps(['{"tool":"read_file","path":"a"}', "SON"], { workspace: () => null });
    const result = await runToolLoop(deps, "g");
    expect(executed).toHaveLength(0);
    expect(result.ok && result.text).toContain("çalışma klasörü seçili değil");
  });

  it("lets the model retry after an invalid request", async () => {
    const { deps, seen } = makeDeps(['{"tool":"rm_rf","path":"."}', "Tamam, araç kullanmadan yanıtlıyorum."]);
    const result = await runToolLoop(deps, "g");
    expect(seen[1]!.at(-1)!.content).toContain("Geçersiz araç isteği");
    expect(result.ok && result.text).toContain("! geçersiz istek: bilinmeyen araç");
  });

  it("stops after the step budget and asks once for a final answer without tools", async () => {
    const endless = Array(MAX_TOOL_STEPS).fill('{"tool":"list_dir","path":"."}') as string[];
    const { deps, executed, seen } = makeDeps([...endless, "Özet: yeterince baktım"]);
    const result = await runToolLoop(deps, "g");
    expect(executed).toHaveLength(MAX_TOOL_STEPS);
    expect(seen).toHaveLength(MAX_TOOL_STEPS + 1);
    expect(seen.at(-1)!.at(-1)!.content).toContain("Adım sınırına ulaşıldı");
    expect(result.ok && result.text).toContain("Özet: yeterince baktım");
    const stubborn = makeDeps([...endless, '{"tool":"list_dir","path":"."}']);
    const second = await runToolLoop(stubborn.deps, "g");
    expect(second.ok && second.text).toContain("iş yarım kaldı");
    expect(second.ok && second.text).toContain("Devam et");
    expect(stubborn.executed).toHaveLength(MAX_TOOL_STEPS);
  });

  it("fails safely when the model does not answer, and reports a failed execution as such", async () => {
    expect(await runToolLoop(makeDeps([null]).deps, "g")).toEqual({ ok: false });
    // After a tool already ran the work is kept: see "a model that stops answering half way".
    const { deps } = makeDeps(['{"tool":"read_file","path":"x"}', "SON"], { execute: async () => ({ ok: false, text: "yok" }) });
    const result = await runToolLoop(deps, "g");
    expect(result.ok && result.text).toContain("! başarısız: okuma x");
  });
});

describe("a tool request that was cut off mid-way", () => {
  const CUT = '{"tool":"write_file","path":"a.py","content":"def f(x):\\n    return x +';
  it("looksLikeCutOffToolCall recognises a JSON tool request that starts but cannot be parsed, and nothing else", () => {
    expect(looksLikeCutOffToolCall(CUT)).toBe(true);
    expect(looksLikeCutOffToolCall('  {"tool": "list_dir", "path": "." ')).toBe(true);
    expect(looksLikeCutOffToolCall("Dosyayı yazıyorum.")).toBe(false);
    expect(looksLikeCutOffToolCall('{"başlık": "bir JSON cevap"}')).toBe(false);
    expect(looksLikeCutOffToolCall("Sonuç: {\"tool\":\"x\"")).toBe(false);
  });
  it("is not taken as the final answer: the model is asked again, smaller, and the next full request runs", async () => {
    const { deps, seen, executed } = makeDeps([CUT, '{"tool":"write_file","path":"a.py","content":"x"}', "a.py yazıldı."]);
    const lines: string[] = [];
    const result = await runToolLoop({ ...deps, onProgress: (l) => lines.push(l) }, "g");
    expect(seen[1]!.at(-1)!.content).toBe(TOOL_CUT_OFF_NUDGE);
    expect(executed.map((c) => c.tool)).toEqual(["write_file"]);
    expect(lines[0]).toContain("yarıda kesildi");
    expect(result.ok && result.text).toContain("a.py yazıldı.");
  });
  it("asks at most MAX_ACTION_NUDGES times, then the reply stands (no endless loop)", async () => {
    const { deps, seen } = makeDeps(Array(10).fill(CUT) as string[]);
    await runToolLoop(deps, "g");
    expect(seen.length).toBeLessThanOrEqual(1 + MAX_ACTION_NUDGES + 2);
  });
});

describe("live progress", () => {
  it("reports one line per finished step and per nudge while the loop runs", async () => {
    const lines: string[] = [];
    const { deps } = makeDeps(['{"tool":"read_file","path":"a.txt"}', "Şimdi dosyaları yazıyorum.", '{"tool":"list_dir","path":"."}', "Bitti: iki adım yapıldı."]);
    await runToolLoop({ ...deps, onProgress: (line) => lines.push(line) }, "g");
    expect(lines).toEqual(["✓ okuma a.txt", "↻ model işi anlattı ya da boş döndü, araç isteği için dürtüldü", "✓ listeleme ."]);
  });
});

describe("a reply that only announces the next action, or is empty, after tools ran", () => {
  it("nudges an announcement ('...yazıyorum.') instead of ending the task, then follows the JSON the model finally writes", async () => {
    const { deps, seen, executed } = makeDeps([
      '{"tool":"list_dir","path":"."}',
      "Devam ediyorum: eksik kısım iskelet. İlk olarak iskelet dosyalarını yazıyorum.",
      '{"tool":"write_file","path":"apps/a.txt","content":"X"}',
      "apps/a.txt oluşturuldu ve doğrulandı.",
    ]);
    const result = await runToolLoop(deps, "P0");
    expect(seen[2]!.at(-1)!.content).toBe(TOOL_NUDGE);
    expect(executed.map((c) => c.tool)).toEqual(["list_dir", "write_file"]);
    expect(result.ok && result.text).toContain("oluşturuldu ve doğrulandı");
    expect(result.ok && result.text).toContain("✓ yazma apps/a.txt");
  });

  it("nudges an empty reply (the model spent its whole budget thinking)", async () => {
    const { deps, seen } = makeDeps(['{"tool":"list_dir","path":"."}', "", "Klasör boş, rapor: yapılacak bir şey yok."]);
    const result = await runToolLoop(deps, "g");
    expect(seen[2]!.at(-1)!.content).toBe(TOOL_NUDGE);
    expect(seen[2]!.at(-2)!.content).toBe("(boş yanıt)");
    expect(result.ok && result.text).toContain("rapor: yapılacak bir şey yok");
  });

  it("nudges at most MAX_ACTION_NUDGES times, then the reply stands (no endless loop)", async () => {
    const stubborn = Array(10).fill("Şimdi dosyaları yazıyorum.") as string[];
    const { deps, seen } = makeDeps(['{"tool":"list_dir","path":"."}', ...stubborn]);
    const result = await runToolLoop(deps, "g");
    expect(seen).toHaveLength(1 + 1 + MAX_ACTION_NUDGES);
    expect(result.ok && result.text.startsWith("Şimdi dosyaları yazıyorum.")).toBe(true);
  });

  it("a normal final summary after tools is not nudged, and isEmptyOrAnnouncement is conservative", async () => {
    const { deps, seen } = makeDeps(['{"tool":"list_dir","path":"."}', "Klasörde iki dosya var: a.txt ve b.txt."]);
    await runToolLoop(deps, "g");
    expect(seen).toHaveLength(2);
    expect(isEmptyOrAnnouncement("Klasörde iki dosya var.")).toBe(false);
    expect(isEmptyOrAnnouncement("Dosyayı şimdi oluşturuyorum")).toBe(true);
    expect(isEmptyOrAnnouncement("  \n ")).toBe(true);
  });
});

describe("challenging a first plain reply", () => {
  it("challenges a plain reply (twice at most), and a task that needs no tool simply repeats its answer", async () => {
    const { deps, seen, executed } = makeDeps(["Doğrudan yanıt", "Doğrudan yanıt (tekrar)", "Doğrudan yanıt (son)"]);
    const result = await runToolLoop(deps, "görev");
    expect(seen).toHaveLength(3);
    expect(seen[1]!.at(-1)!.content).toBe(TOOL_REMINDER);
    expect(seen[2]!.at(-1)!.content).toBe(TOOL_REMINDER_FINAL);
    expect(executed).toHaveLength(0);
    expect(result.ok && result.text.startsWith("Doğrudan yanıt (son)")).toBe(true);
    expect(result.ok && result.text).toContain("Araç kullanılmadı");
  });

  it("turns a made-up 'file created' reply into a real tool call after the reminder", async () => {
    const { deps, seen, executed, approvals } = makeDeps([
      "notlar.txt oluşturuldu.",
      '{"tool":"write_file","path":"notlar.txt","content":"X"}',
      "Gerçekten oluşturuldu.",
    ]);
    const result = await runToolLoop(deps, "notlar.txt oluştur");
    expect(seen).toHaveLength(3);
    expect(executed.map((c) => c.tool)).toEqual(["write_file"]);
    expect(approvals).toHaveLength(1);
    expect(result.ok && result.text).toContain("✓ yazma notlar.txt");
  });

  it("reminds at most twice: a third plain reply stands with the honest 'no tool used' line", async () => {
    const { deps, seen, executed } = makeDeps(["Araç erişimim yok.", "Gerçekten erişimim yok.", "Üzgünüm, erişimim yok."]);
    const result = await runToolLoop(deps, "g");
    expect(seen).toHaveLength(3);
    expect(executed).toHaveLength(0);
    expect(result.ok && result.text).toContain("Üzgünüm, erişimim yok");
    expect(result.ok && result.text).toContain("Araç kullanılmadı");
  });

  it("a stubborn model that refuses once and then follows the second, explicit reminder ends up using the tool", async () => {
    const { deps, seen, executed } = makeDeps(["Bu ortamda araç köprüsüne erişimim yok.", "Yine erişimim yok.", '{"tool":"list_dir","path":"."}', "Klasörde bir dosya var."]);
    const result = await runToolLoop(deps, "klasörü tara");
    expect(seen).toHaveLength(4);
    expect(seen[2]!.at(-1)!.content).toBe(TOOL_REMINDER_FINAL);
    expect(TOOL_REMINDER_FINAL).toContain('{"tool":"list_dir","path":"."}');
    expect(executed.map((c) => c.tool)).toEqual(["list_dir"]);
    expect(result.ok && result.text).toContain("✓ listeleme .");
  });

  it("does not remind after a tool has already been used", async () => {
    const { deps, seen } = makeDeps(['{"tool":"list_dir","path":"."}', "Listeledim, bitti."]);
    const result = await runToolLoop(deps, "g");
    expect(seen).toHaveLength(2);
    expect(result.ok && result.text).toContain("Listeledim");
  });

  it("does not remind after an invalid tool request either (the model already tried the bridge)", async () => {
    const { deps, seen } = makeDeps(['{"tool":"nope"}', "Tamam, düz yanıt."]);
    await runToolLoop(deps, "g");
    expect(seen).toHaveLength(2);
    expect(seen[1]!.at(-1)!.content).toContain("Geçersiz araç isteği");
  });
});

describe("static properties", () => {
  const dir = path.join(__dirname, "..", "electron");
  const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  it("policy and loop are pure: no electron, node, fs, process or network access", () => {
    for (const file of ["toolPolicy.ts", "toolLoop.ts"]) {
      const code = strip(fs.readFileSync(path.join(dir, file), "utf8"));
      expect(code, file).not.toMatch(/from ["'](electron|node:[^"']+|fs|path)["']|process\.|fetch\(|require\(|child_process/);
    }
  });
  it("commands are spawned once, without a shell, from a fixed argument shape", () => {
    const code = strip(fs.readFileSync(path.join(dir, "toolExecutors.ts"), "utf8"));
    expect((code.match(/\bspawn\(/g) ?? []).length).toBe(1);
    expect(code).toContain("shell: false");
    expect(code).toContain('["/d", "/s", "/c"');
    expect(code).not.toMatch(/env:\s*process\.env|shell:\s*true|execSync/);
  });
  it("the approval dialog is native, with Reddet as default: four choices for writes and commands, three for everything else", () => {
    const code = fs.readFileSync(path.join(dir, "toolAdapters.ts"), "utf8");
    expect(code).toContain('["Bir kez izin ver", "Bu görevde hepsine izin ver", "Bu klasörde her zaman izin ver", "Reddet"]');
    expect(code).toContain('["Bir kez izin ver", "Her zaman izin ver", "Reddet"]');
    expect(code).toContain("defaultId: buttons.length - 1");
    expect(code).toContain("cancelId: buttons.length - 1");
    expect(code).toContain("dialog.showMessageBox");
  });
});

describe("workspace overview (the model starts from the real project)", () => {
  let base: string;
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "vyron-overview-"));
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("shows two levels of the tree and the head of the manifest, and leaves out vendor folders and secrets", () => {
    fs.mkdirSync(path.join(base, "src", "lib"), { recursive: true });
    fs.mkdirSync(path.join(base, "node_modules", "x"), { recursive: true });
    fs.mkdirSync(path.join(base, ".git"));
    fs.writeFileSync(path.join(base, "package.json"), '{"name":"demo-proje"}', "utf8");
    fs.writeFileSync(path.join(base, "README.md"), "# Demo", "utf8");
    fs.writeFileSync(path.join(base, ".env"), "SECRET=1", "utf8");
    fs.writeFileSync(path.join(base, "src", "index.ts"), "export {}", "utf8");
    const root = fs.realpathSync.native(base);
    const text = projectOverview(root) as string;
    expect(text).toContain("src/");
    expect(text).toContain("src/index.ts");
    expect(text).toContain("package.json (başı)");
    expect(text).toContain("demo-proje");
    expect(text).toContain("# Demo");
    expect(text).not.toMatch(/node_modules|\.git\b|SECRET|\.env/);
    expect(text.length).toBeLessThanOrEqual(5_000);
  });

  it("is bounded on a huge folder and reports an empty one", () => {
    for (let i = 0; i < 400; i += 1) fs.writeFileSync(path.join(base, "f" + String(i) + ".txt"), "x", "utf8");
    expect((projectOverview(fs.realpathSync.native(base)) as string).split("\n").length).toBeLessThanOrEqual(160);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "vyron-empty-"));
    try {
      expect(projectOverview(fs.realpathSync.native(empty))).toBe("(boş klasör)");
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("goes into the first message between the protocol and the task, and only when there is a folder", async () => {
    expect(firstToolMessage("G", "src/\nindex.ts")).toBe(TOOL_PROTOCOL + "\n\nÇalışma klasörü özeti:\nsrc/\nindex.ts\n\nGörev:\nG");
    expect(firstToolMessage("G")).toBe(TOOL_PROTOCOL + "\n\nGörev:\nG");
    const { deps, seen } = makeDeps(["Bitti"], { overview: () => "OZET" });
    await runToolLoop(deps, "GÖREV");
    expect(seen[0]![0]!.content).toContain("Çalışma klasörü özeti:\nOZET");
    const none = makeDeps(["Bitti"], { overview: () => "OZET", workspace: () => null });
    await runToolLoop(none.deps, "GÖREV");
    expect(none.seen[0]![0]!.content).not.toContain("OZET");
  });

  it("allows a real build session: 150 steps (a P0 scaffold hit the old 30-step ceiling after ~73 actions), larger outputs and transcript", () => {
    expect(MAX_TOOL_STEPS).toBe(150);
    expect(MAX_TOOL_CALLS).toBe(600);
    expect(MAX_LOG_LINES).toBe(100);
    expect(MAX_TOOL_OUTPUT_CHARS).toBe(60_000);
    expect(MAX_TRANSCRIPT_CHARS).toBe(350_000);
    expect(TOOL_PROTOCOL).toContain("Var olan kodu okumadan üzerine yazma");
    expect(TOOL_PROTOCOL).toContain("tekrar list_dir ile listeleme");
    expect(TOOL_PROTOCOL).toContain("aynı denetimi tekrarlamak yerine doğrudan uygulamaya geç");
  });
});

describe("a model that stops answering half way", () => {
  it("keeps what was done: the answer says the work is unfinished and lists the real actions", async () => {
    const { deps, executed } = makeDeps(['{"tool":"list_dir","path":"."}', '{"tool":"read_file","path":"a.txt"}', null]);
    const result = await runToolLoop(deps, "görev");
    expect(executed.map((c) => c.tool)).toEqual(["list_dir", "read_file"]);
    expect(result.ok).toBe(true);
    expect(result.ok && result.text).toContain("Model yanıt vermeyi bıraktı; iş yarım kaldı");
    expect(result.ok && result.text).toContain("✓ listeleme .");
    expect(result.ok && result.text).toContain("✓ okuma a.txt");
  });

  it("with nothing done yet it is still an ordinary failure", async () => {
    const { deps } = makeDeps([null]);
    expect(await runToolLoop(deps, "görev")).toEqual({ ok: false });
  });

  it("the Ruflo prompt allowance covers the largest tool transcript (or a long run would be refused mid-way)", () => {
    expect(MAX_RUFLO_ASK_CHARS).toBeGreaterThan(MAX_TRANSCRIPT_CHARS + 10_000);
    const biggest = flattenTranscript([{ role: "user", content: "x".repeat(MAX_TRANSCRIPT_CHARS) }]);
    expect(biggest.length).toBeLessThanOrEqual(MAX_RUFLO_ASK_CHARS);
  });
});

describe("several tool requests in one reply", () => {
  it("parseToolCalls reads every request in order: lines, commas, arrays and prose around them", () => {
    const reply = 'Önce şunlara bakayım:\n{"tool":"list_dir","path":"src"},{"tool":"read_file","path":"a.ts"}\n```json\n[{"tool":"read_file","path":"b.ts"}]\n```';
    const calls = parseToolCalls(reply);
    expect(calls.map((c) => (c.kind === "call" ? c.call.tool + ":" + (c.call as { path: string }).path : "?"))).toEqual(["list_dir:src", "read_file:a.ts", "read_file:b.ts"]);
    expect(parseToolCalls("Düz yanıt, JSON yok.")).toEqual([]);
    expect(parseToolCalls('{"not":"a tool"}')).toEqual([]);
  });

  it("keeps invalid ones in place (the model is told) and caps a reply at the per-reply limit", () => {
    const mixed = parseToolCalls('{"tool":"nope"}\n{"tool":"read_file","path":"a.ts"}\n{"tool":"read_file","path":""}');
    expect(mixed.map((c) => c.kind)).toEqual(["invalid", "call", "invalid"]);
    const many = Array.from({ length: 20 }, (_, i) => '{"tool":"read_file","path":"f' + String(i) + '.ts"}').join("\n");
    expect(parseToolCalls(many)).toHaveLength(MAX_CALLS_PER_REPLY);
  });

  it("parseToolCall (single) still returns the first request only", () => {
    expect(parseToolCall('{"tool":"read_file","path":"a"}{"tool":"read_file","path":"b"}')).toEqual({ kind: "call", call: { tool: "read_file", path: "a" } });
  });

  it("the loop runs all requests of a reply in order and feeds back one labelled message", async () => {
    const { deps, executed, seen } = makeDeps(['{"tool":"list_dir","path":"."}\n{"tool":"read_file","path":"a.txt"}\n{"tool":"read_file","path":"b.txt"}', "Üçünü de okudum."]);
    const result = await runToolLoop(deps, "tara");
    expect(executed.map((c) => c.tool)).toEqual(["list_dir", "read_file", "read_file"]);
    const feedback = seen[1]!.at(-1)!.content;
    expect(feedback).toContain("[1/3] Araç sonucu (list_dir)");
    expect(feedback).toContain("[3/3] Araç sonucu (read_file)");
    expect(result.ok && result.text).toContain("✓ listeleme .");
    expect(result.ok && result.text).toContain("✓ okuma b.txt");
  });

  it("a write in the middle of a batch still asks for approval, and a refusal only skips that one", async () => {
    const { deps, executed, approvals } = makeDeps(['{"tool":"read_file","path":"a.txt"}\n{"tool":"write_file","path":"x.txt","content":"1"}\n{"tool":"read_file","path":"b.txt"}', "Bitti."], {
      approve: async () => "deny",
    });
    const result = await runToolLoop(deps, "g");
    expect(approvals).toBeDefined();
    expect(executed.map((c) => c.tool + ":" + (c as { path?: string }).path)).toEqual(["read_file:a.txt", "read_file:b.txt"]);
    expect(result.ok && result.text).toContain("✗ reddedildi");
  });

  it("a single request keeps the plain, unlabelled feedback", async () => {
    const { deps, seen } = makeDeps(['{"tool":"list_dir","path":"."}', "Bitti."]);
    await runToolLoop(deps, "g");
    expect(seen[1]!.at(-1)!.content).toMatch(/^Araç sonucu \(list_dir\)/);
  });

  it("stops executing after the task-wide call ceiling and says so", async () => {
    const batch = Array.from({ length: MAX_CALLS_PER_REPLY }, (_, i) => '{"tool":"read_file","path":"f' + String(i) + '.ts"}').join("\n");
    const rounds = Math.ceil(MAX_TOOL_CALLS / MAX_CALLS_PER_REPLY) + 1;
    const script = Array.from({ length: rounds }, () => batch).concat("Bitti.");
    const { deps, executed, seen } = makeDeps(script);
    await runToolLoop(deps, "g");
    expect(executed.length).toBe(MAX_TOOL_CALLS);
    expect(seen.at(-1)!.at(-1)!.content).toContain("Araç çağrısı sınırına ulaşıldı");
  });

  it("the protocol tells the model it may batch independent requests", () => {
    expect(TOOL_PROTOCOL).toContain("en fazla 8 JSON nesnesi");
    expect(MAX_CALLS_PER_REPLY).toBe(8);
  });
});

describe("browser safety rules (pure)", () => {
  it("refuses loopback, private, link-local, CGNAT, multicast and intranet hosts, and allows ordinary public ones", () => {
    for (const blocked of [
      "localhost", "LOCALHOST", "localhost.", "app.localhost", "127.0.0.1", "127.8.8.8", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.255.255",
      "192.168.1.10", "169.254.169.254", "100.64.0.1", "100.127.255.255", "198.18.0.1", "224.0.0.1", "255.255.255.255", "192.0.0.5",
      "[::1]", "[::]", "[fe80::1]", "[fc00::1]", "[fd12:3456::1]", "[::ffff:7f00:1]", "[::ffff:127.0.0.1]",
      "yazici.local", "nas.lan", "sunucu.internal", "ofis.home.arpa", "intranet", "wiki", "", "   ",
    ]) expect(isBlockedBrowserHost(blocked), blocked).toBe(true);
    for (const ok of ["example.com", "www.google.com", "gymwolves.com.tr", "8.8.8.8", "172.32.0.1", "172.15.255.255", "100.63.255.255", "192.169.0.1", "[2606:4700:4700::1111]", "[2a00:1450::1]"]) {
      expect(isBlockedBrowserHost(ok), ok).toBe(false);
    }
  });

  it("judges resolved addresses the same way (v4 and v6, with or without brackets)", () => {
    for (const blocked of ["127.0.0.1", "10.0.0.1", "192.168.0.5", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "[::1]", "not-an-ip"]) expect(isPrivateAddress(blocked), blocked).toBe(true);
    for (const ok of ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946", "2001:4860:4860::8888"]) expect(isPrivateAddress(ok), ok).toBe(false);
  });

  it("parseBrowserUrl: adds https to a bare name, keeps http(s) only, and rejects credentials, private hosts and junk", () => {
    expect(parseBrowserUrl("ornek.com")).toEqual({ ok: true, url: "https://ornek.com/", host: "ornek.com" });
    expect(parseBrowserUrl("  https://Ornek.com/a b?x=1#y ")).toEqual({ ok: true, url: "https://ornek.com/a%20b?x=1#y", host: "ornek.com" });
    expect(parseBrowserUrl("http://ornek.com:8080/")).toMatchObject({ ok: true, host: "ornek.com" });
    for (const bad of [
      "", "   ", "file:///C:/Windows/win.ini", "ftp://ornek.com", "javascript:alert(1)", "data:text/html,x", "chrome://settings", "about:blank",
      "https://kullanici:parola@ornek.com/", "http://127.0.0.1:20128/", "http://localhost:8642", "https://[::1]/", "http://2130706433/", "http://0x7f.1/",
      "http://0177.0.0.1/", "http://intranet/", "https://ornek.com/\u0001", "https://" + "a".repeat(2100) + ".com",
    ]) {
      expect(parseBrowserUrl(bad).ok, bad.slice(0, 60)).toBe(false);
    }
  });

  it("shortUrl shows host and path only, never the query or fragment", () => {
    expect(shortUrl("https://magaza.example/giris?token=GIZLI#x")).toBe("magaza.example/giris");
    expect(shortUrl("https://magaza.example/")).toBe("magaza.example");
    expect(shortUrl("https://magaza.example/" + "p".repeat(300)).length).toBeLessThanOrEqual(100);
  });
});

describe("browser tool requests: parsing, approval and logging", () => {
  it("parses the four browser requests; the address is normalised and an index may be a number or a short numeric string", () => {
    expect(parseToolCall('{"tool":"browser_open","url":"ornek.com"}')).toEqual({ kind: "call", call: { tool: "browser_open", url: "https://ornek.com/" } });
    expect(parseToolCall('{"tool":"browser_read"}')).toEqual({ kind: "call", call: { tool: "browser_read" } });
    expect(parseToolCall('{"tool":"browser_click","index":3}')).toEqual({ kind: "call", call: { tool: "browser_click", index: 3 } });
    expect(parseToolCall('{"tool":"browser_click","index":" 12 "}')).toEqual({ kind: "call", call: { tool: "browser_click", index: 12 } });
    expect(parseToolCall('{"tool":"browser_type","index":2,"text":"mont","submit":true}')).toEqual({ kind: "call", call: { tool: "browser_type", index: 2, text: "mont", submit: true } });
    // submit is only ever the literal true.
    expect(parseToolCall('{"tool":"browser_type","index":2,"text":"x","submit":"true"}')).toEqual({ kind: "call", call: { tool: "browser_type", index: 2, text: "x", submit: false } });
    expect(parseToolCall('{"tool":"browser_type","index":2,"text":""}')).toMatchObject({ kind: "call" });
  });

  it("rejects bad addresses and indexes as invalid requests the model is told about", () => {
    for (const reply of [
      '{"tool":"browser_open"}', '{"tool":"browser_open","url":5}', '{"tool":"browser_open","url":"http://127.0.0.1:20128/"}', '{"tool":"browser_open","url":"file:///C:/x"}',
      '{"tool":"browser_click"}', '{"tool":"browser_click","index":-1}', '{"tool":"browser_click","index":150}', '{"tool":"browser_click","index":1.5}', '{"tool":"browser_click","index":"abc"}',
      '{"tool":"browser_type","index":1}', '{"tool":"browser_type","index":1,"text":5}', '{"tool":"browser_type","index":999,"text":"x"}',
      '{"tool":"browser_type","index":1,"text":"' + "x".repeat(5001) + '"}',
    ]) {
      expect(parseToolCall(reply).kind, reply.slice(0, 70)).toBe("invalid");
    }
  });

  it("everything that changes a page or navigates needs approval; reading the open page does not", () => {
    expect(needsApproval({ tool: "browser_open", url: "https://ornek.com/" })).toBe(true);
    expect(needsApproval({ tool: "browser_click", index: 0 })).toBe(true);
    expect(needsApproval({ tool: "browser_type", index: 0, text: "x", submit: false })).toBe(true);
    expect(needsApproval({ tool: "browser_read" })).toBe(false);
  });

  it("the open dialog names the site, shortens the address, and scopes 'always' to the folder and the host", () => {
    const request = approvalRequest({ tool: "browser_open", url: "https://magaza.example/giris?token=GIZLI" }, "ws1", "Proje", null)!;
    expect(request.title).toContain("web sitesi açma izni");
    expect(request.message).toContain('"Proje"');
    expect(request.detail).toContain("magaza.example\nmagaza.example/giris");
    expect(JSON.stringify(request)).not.toContain("GIZLI");
    expect(request.key).toBe("browser-open|ws1|magaza.example");
    expect(approvalRequest({ tool: "browser_open", url: "https://baska.example/" }, "ws1", "Proje", null)!.key).not.toBe(request.key);
    expect(approvalRequest({ tool: "browser_open", url: "https://magaza.example/" }, "ws2", "Proje", null)!.key).not.toBe(request.key);
  });

  it("click and type dialogs show the site, the element and (for typing) the text; a missing target means no dialog", () => {
    const target = { host: "magaza.example", label: 'düğme "Sepete ekle"' };
    const click = approvalRequest({ tool: "browser_click", index: 4 }, "ws1", "Proje", null, target)!;
    expect(click.title).toContain("tıklama izni");
    expect(click.message).toContain("magaza.example");
    expect(click.detail).toContain('[4] düğme "Sepete ekle"');
    expect(click.key).toBe("browser-click|ws1|magaza.example");
    const type = approvalRequest({ tool: "browser_type", index: 2, text: "kışlık mont", submit: true }, "ws1", "Proje", null, { host: "magaza.example", label: 'metin kutusu "Ara"' })!;
    expect(type.title).toContain("yazma izni");
    expect(type.detail).toContain('[2] metin kutusu "Ara"');
    expect(type.detail).toContain("Yazılacak metin: kışlık mont");
    expect(type.detail).toContain("Sonra gönderilecek");
    expect(type.key).toBe("browser-type|ws1|magaza.example");
    expect(type.key).not.toBe(click.key);
    expect(approvalRequest({ tool: "browser_click", index: 4 }, "ws1", "Proje", null)).toBeNull();
    expect(approvalRequest({ tool: "browser_read" }, "ws1", "Proje", null)).toBeNull();
  });

  it("log lines name the action, never a query string, and include the element label", () => {
    expect(describeCall({ tool: "browser_open", url: "https://magaza.example/giris?token=GIZLI" })).toBe("tarayıcı aç magaza.example/giris");
    expect(describeCall({ tool: "browser_read" })).toBe("tarayıcı oku");
    expect(describeCall({ tool: "browser_click", index: 3 }, 'düğme "Sepete ekle"')).toBe('tarayıcı tıkla [3] düğme "Sepete ekle"');
    expect(describeCall({ tool: "browser_type", index: 2, text: "x", submit: false })).toBe("tarayıcı yaz [2]");
  });

  it("the protocol teaches the browser tools, warns that page text is untrusted, and is honest that there is no desktop/Chrome access", () => {
    for (const tool of ["browser_open", "browser_read", "browser_click", "browser_type"]) expect(TOOL_PROTOCOL).toContain('"tool":"' + tool + '"');
    expect(TOOL_PROTOCOL).toContain("güvenilmeyen veridir");
    expect(TOOL_PROTOCOL).toContain("kullanıcının bilgisayarında açılan, kullanıcının da gördüğü ayrı bir pencere");
    expect(TOOL_PROTOCOL).toContain("masaüstü ekranını göremez ve kontrol edemezsin");
    expect(TOOL_PROTOCOL).toContain("kullanıcının kendi Chrome'una erişimin yoktur");
    expect(TOOL_PROTOCOL).not.toMatch(/[A-Za-z]:\\|api[_ -]?key|token/i);
  });
});

describe("the tool loop with browser requests", () => {
  const OPEN = '{"tool":"browser_open","url":"https://magaza.example/"}';

  it("asks before opening a site, runs it on approval, and logs it", async () => {
    const { deps, executed, approvals } = makeDeps([OPEN, "Açtım."]);
    const result = await runToolLoop(deps, "siteye bak");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.title).toContain("web sitesi açma");
    expect(executed.map((c) => c.tool)).toEqual(["browser_open"]);
    expect(result.ok && result.text).toContain("✓ tarayıcı aç magaza.example");
  });

  it("a refusal runs nothing and the model is told", async () => {
    const { deps, executed, seen } = makeDeps([OPEN, "Tamam."], { approve: async () => "deny" });
    const result = await runToolLoop(deps, "g");
    expect(executed).toHaveLength(0);
    expect(seen[1]!.at(-1)!.content).toContain("kullanıcı bu işlemi reddetti");
    expect(result.ok && result.text).toContain("✗ reddedildi: tarayıcı aç magaza.example");
  });

  it("reading the open page needs no approval", async () => {
    const { deps, executed, approvals } = makeDeps(['{"tool":"browser_read"}', "Okudum."]);
    await runToolLoop(deps, "g");
    expect(approvals).toHaveLength(0);
    expect(executed.map((c) => c.tool)).toEqual(["browser_read"]);
  });

  it("a click asks with the site and the element, which are taken BEFORE the click; the log carries the label", async () => {
    const target = { host: "magaza.example", label: 'düğme "Sepete ekle"' };
    const { deps, executed, approvals } = makeDeps(['{"tool":"browser_click","index":1}', "Tıkladım."], { browserTarget: () => target });
    const result = await runToolLoop(deps, "g");
    expect(approvals[0]!.detail).toContain('[1] düğme "Sepete ekle"');
    expect(approvals[0]!.key).toBe("browser-click|ws1|magaza.example");
    expect(executed.map((c) => c.tool)).toEqual(["browser_click"]);
    expect(result.ok && result.text).toContain('✓ tarayıcı tıkla [1] düğme "Sepete ekle"');
  });

  it("with no page open a click or a type is not approved at all: the executor just reports that no page is open", async () => {
    const { deps, executed, approvals } = makeDeps(['{"tool":"browser_click","index":1}\n{"tool":"browser_type","index":0,"text":"x"}', "Sayfa yokmuş."], { browserTarget: () => null });
    await runToolLoop(deps, "g");
    expect(approvals).toHaveLength(0);
    expect(executed.map((c) => c.tool)).toEqual(["browser_click", "browser_type"]);
  });

  it("a batch mixes reads and approved actions in order; a refused one only skips itself", async () => {
    const target = { host: "magaza.example", label: null };
    const { deps, executed } = makeDeps(['{"tool":"browser_read"}\n{"tool":"browser_click","index":0}\n{"tool":"browser_read"}', "Bitti."], {
      browserTarget: () => target,
      approve: async () => "deny",
    });
    await runToolLoop(deps, "g");
    expect(executed.map((c) => c.tool)).toEqual(["browser_read", "browser_read"]);
  });

  it("an address the policy refuses never reaches approval or execution", async () => {
    const { deps, executed, approvals } = makeDeps(['{"tool":"browser_open","url":"http://127.0.0.1:20128/"}', "Olmadı."]);
    const result = await runToolLoop(deps, "g");
    expect(approvals).toHaveLength(0);
    expect(executed).toHaveLength(0);
    expect(result.ok && result.text).toContain("! geçersiz istek: yerel ve özel ağ adreslerine erişim yasak");
  });
});
