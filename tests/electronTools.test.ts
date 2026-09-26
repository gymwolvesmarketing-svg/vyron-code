import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_COMMAND_CHARS,
  MAX_LOG_LINES,
  MAX_PATH_CHARS,
  MAX_TOOL_OUTPUT_CHARS,
  MAX_TOOL_STEPS,
  MAX_TRANSCRIPT_CHARS,
  MAX_WRITE_CHARS,
  TOOL_PROTOCOL,
  TOOL_REMINDER,
  firstToolMessage,
  approvalRequest,
  boundOutput,
  flattenTranscript,
  isCatastrophicCommand,
  needsApproval,
  parseToolCall,
  toolLogFooter,
  trimTranscript,
  type ApprovalChoice,
  type ApprovalRequest,
  type ChatMessage,
  type ToolCall,
} from "../electron/toolPolicy";
import { commandEnvironment, listDir, projectOverview, readFile, resolveWritable, runCommand, writeFile } from "../electron/toolExecutors";
import { runToolLoop, type ToolLoopDeps } from "../electron/toolLoop";

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
      { tool: "run_command", command: "dir" },
    ];
    expect(calls.map(needsApproval)).toEqual([false, false, true, true]);
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
    expect(run.key).toBe("run|ws1|npm test");
    expect(approvalRequest({ tool: "read_file", path: "a" }, "ws1", "P", null)).toBeNull();
    expect(run.key).not.toBe(approvalRequest({ tool: "run_command", command: "npm test " + "&& calc" }, "ws1", "Proje", null)!.key);
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
      ['{"tool":"write_file","path":"a.txt","content":"1"}', '{"tool":"run_command","command":"dir"}', '{"tool":"write_file","path":"b.txt","content":"2"}', "SON"],
      { approve: async (request) => (approvals.push(request), choices.shift() ?? "deny") },
    );
    const result = await runToolLoop(deps, "g");
    expect(approvals.map((a) => a.key)).toEqual(["write|ws1", "run|ws1|dir", "write|ws1"]);
    expect(executed.map((c) => c.tool)).toEqual(["write_file", "write_file"]);
    expect(seen[2]!.at(-1)!.content).toContain("kullanıcı bu işlemi reddetti");
    expect(result.ok && result.text).toContain("✗ reddedildi: komut dir");
  });

  it("does not run a tool when the approval helper cannot describe it (safe default = deny)", async () => {
    const { deps, executed } = makeDeps(['{"tool":"run_command","command":"dir"}', "SON"], { approve: async () => "deny" });
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
    expect(second.ok && second.text).toContain("iş tamamlanamadı");
    expect(stubborn.executed).toHaveLength(MAX_TOOL_STEPS);
  });

  it("fails safely when the model does not answer, and reports a failed execution as such", async () => {
    expect(await runToolLoop(makeDeps([null]).deps, "g")).toEqual({ ok: false });
    expect(await runToolLoop(makeDeps(['{"tool":"list_dir","path":"."}', null]).deps, "g")).toEqual({ ok: false });
    const { deps } = makeDeps(['{"tool":"read_file","path":"x"}', "SON"], { execute: async () => ({ ok: false, text: "yok" }) });
    const result = await runToolLoop(deps, "g");
    expect(result.ok && result.text).toContain("! başarısız: okuma x");
  });
});

describe("challenging a first plain reply", () => {
  it("challenges a first plain reply once, and a task that needs no tool simply repeats its answer", async () => {
    const { deps, seen, executed } = makeDeps(["Doğrudan yanıt", "Doğrudan yanıt (tekrar)"]);
    const result = await runToolLoop(deps, "görev");
    expect(seen).toHaveLength(2);
    expect(seen[1]!.at(-1)!.content).toBe(TOOL_REMINDER);
    expect(executed).toHaveLength(0);
    expect(result.ok && result.text.startsWith("Doğrudan yanıt (tekrar)")).toBe(true);
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

  it("reminds only once: a second plain reply stands with the honest 'no tool used' line", async () => {
    const { deps, seen, executed } = makeDeps(["Araç erişimim yok.", "Gerçekten erişimim yok, üzgünüm."]);
    const result = await runToolLoop(deps, "g");
    expect(seen).toHaveLength(2);
    expect(executed).toHaveLength(0);
    expect(result.ok && result.text).toContain("Gerçekten erişimim yok");
    expect(result.ok && result.text).toContain("Araç kullanılmadı");
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
  it("the approval dialog is native and offers exactly the three choices", () => {
    const code = fs.readFileSync(path.join(dir, "toolAdapters.ts"), "utf8");
    expect(code).toContain('buttons: ["Bir kez izin ver", "Her zaman izin ver", "Reddet"]');
    expect(code).toContain("defaultId: 2");
    expect(code).toContain("cancelId: 2");
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

  it("allows a real build session: 30 steps, larger outputs and transcript", () => {
    expect(MAX_TOOL_STEPS).toBe(30);
    expect(MAX_TOOL_OUTPUT_CHARS).toBe(12_000);
    expect(MAX_TRANSCRIPT_CHARS).toBe(60_000);
    expect(TOOL_PROTOCOL).toContain("Var olan kodu okumadan üzerine yazma");
  });
});
