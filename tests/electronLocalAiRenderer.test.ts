import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const electronDir = path.join(__dirname, "..", "electron");
const html = fs.readFileSync(path.join(electronDir, "renderer.html"), "utf8");
const rendererSource = fs.readFileSync(path.join(electronDir, "renderer.ts"), "utf8");
const rendererJs = ts.transpileModule(rendererSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

// ---------------------------------------------------------------------------------------------
// A tiny fake DOM built from the REAL renderer.html, so the REAL renderer script runs against the
// real ids, initial hidden/disabled attributes and initial text. Assigning innerHTML throws, so any
// use of it (which would defeat plain-text rendering) fails a test.
// ---------------------------------------------------------------------------------------------
class FakeElement {
  readonly id: string;
  readonly tagName: string;
  hidden = false;
  disabled = false;
  value = "";
  className = "";
  textContentValue = "";
  readonly listeners: Record<string, Array<(event: Record<string, unknown>) => void>> = {};
  constructor(id: string, tagName: string, private readonly doc: FakeDocument) {
    this.id = id;
    this.tagName = tagName;
  }
  get textContent(): string {
    return this.textContentValue;
  }
  set textContent(value: string) {
    this.textContentValue = String(value);
  }
  set innerHTML(_value: string) {
    throw new Error("innerHTML must never be assigned");
  }
  addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  dispatch(type: string, extra: Record<string, unknown> = {}): { defaultPrevented: boolean } {
    const event: Record<string, unknown> & { defaultPrevented: boolean } = {
      type,
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true;
      },
      ...extra,
    };
    for (const listener of this.listeners[type] ?? []) listener(event);
    return event;
  }
  focus(): void {
    this.doc.activeElement = this;
  }
  click(): void {
    if (this.disabled) return;
    this.dispatch("click");
  }
}

class FakeDocument {
  readonly elements = new Map<string, FakeElement>();
  activeElement: FakeElement | null = null;
  readonly listeners: Record<string, Array<(event: Record<string, unknown>) => void>> = {};
  constructor(markup: string) {
    const tagPattern = /<([a-zA-Z0-9]+)\b([^>]*)>/g;
    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(markup)) !== null) {
      const attributes = match[2] ?? "";
      const idMatch = /\bid="([^"]+)"/.exec(attributes);
      if (!idMatch) continue;
      const element = new FakeElement(idMatch[1]!, match[1]!.toLowerCase(), this);
      element.hidden = /\shidden(\s|$|>)/.test(` ${attributes} `);
      element.disabled = /\sdisabled(\s|$|>)/.test(` ${attributes} `);
      element.className = /\bclass="([^"]*)"/.exec(attributes)?.[1] ?? "";
      const inner = new RegExp(`^([^<]*)</${match[1]}>`).exec(markup.slice(match.index + match[0].length));
      if (inner) element.textContentValue = (inner[1] ?? "").trim();
      this.elements.set(element.id, element);
    }
  }
  getElementById(id: string): FakeElement | null {
    return this.elements.get(id) ?? null;
  }
  addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  dispatch(type: string, extra: Record<string, unknown> = {}): { defaultPrevented: boolean } {
    const event: Record<string, unknown> & { defaultPrevented: boolean } = {
      type,
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true;
      },
      ...extra,
    };
    for (const listener of this.listeners[type] ?? []) listener(event);
    return event;
  }
}

type LocalAiState =
  | { state: "starting"; stage: "checking" | "gateway" | "proxy" | "verifying" }
  | { state: "ready" }
  | { state: "unavailable"; category: "hermes_start_failed" | "secure_connection_unverified" | "model_unresponsive" | "unavailable" };

interface TaskState {
  state: string;
  draftLength: number | null;
  text: string | null;
  truncated: boolean;
}

const IDLE: TaskState = { state: "idle", draftLength: null, text: null, truncated: false };

function setup(options: { bridge?: boolean; initial?: LocalAiState; throwOnState?: boolean } = {}) {
  const doc = new FakeDocument(html);
  let currentState: LocalAiState = options.initial ?? { state: "starting", stage: "checking" };
  const calls = {
    getState: 0,
    retry: 0,
    copy: 0,
    review: [] as unknown[],
    send: 0,
    clear: 0,
  };
  const behavior = {
    copyResult: { copied: true } as { copied: boolean } | "throw",
    retryState: { state: "starting", stage: "checking" } as LocalAiState,
    reviewResult: null as TaskState | null,
    sendResult: { state: "completed", draftLength: null, text: "Yanıt metni", truncated: false } as TaskState,
    sendGate: null as Promise<void> | null,
  };
  const timers: Array<{ id: number; at: number; delay: number; fn: () => void }> = [];
  let now = 0;
  let nextTimerId = 1;
  const windowObject: Record<string, unknown> = {
    setTimeout: (fn: () => void, delay: number) => {
      const id = nextTimerId++;
      timers.push({ id, at: now + delay, delay, fn });
      return id;
    },
    clearTimeout: (id: number) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
  };
  if (options.bridge !== false) {
    windowObject.vyronDesktop = {
      localAi: {
        getLocalAiState: async () => {
          calls.getState += 1;
          if (options.throwOnState) throw new Error("boom");
          return currentState;
        },
        retryLocalAiStartup: async () => {
          calls.retry += 1;
          currentState = behavior.retryState;
          return behavior.retryState;
        },
        copyLocalAiDiagnostics: async () => {
          calls.copy += 1;
          if (behavior.copyResult === "throw") throw new Error("boom");
          return behavior.copyResult;
        },
      },
      hermes: {
        getTaskSubmissionState: async () => IDLE,
        reviewTaskDraft: async (request: { draft: string }) => {
          calls.review.push(request);
          return behavior.reviewResult ?? { state: "review_ready", draftLength: request.draft.length, text: null, truncated: false };
        },
        sendReviewedTask: async () => {
          calls.send += 1;
          if (behavior.sendGate) await behavior.sendGate;
          return behavior.sendResult;
        },
        clearTaskSubmission: async () => {
          calls.clear += 1;
          return IDLE;
        },
      },
    };
  }
  const context = vm.createContext({ document: doc, window: windowObject, console: {} });
  vm.runInContext(rendererJs, context);

  const flush = async () => {
    for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const advance = async (ms: number) => {
    now += ms;
    const due = timers.filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at);
    for (const timer of due) {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
      timer.fn();
    }
    await flush();
  };
  const el = (id: string): FakeElement => {
    const element = doc.getElementById(id);
    if (!element) throw new Error(`missing element ${id}`);
    return element;
  };
  const visibleView = (): string[] => ["startup", "ready", "review", "unavailable"].filter((name) => !el(`view-${name}`).hidden);
  const setAi = async (state: LocalAiState) => {
    currentState = state;
    await advance(3_100);
  };
  const type = (text: string) => {
    el("task-draft-input").value = text;
    el("task-draft-input").dispatch("input");
  };
  return { doc, el, calls, behavior, timers, flush, advance, visibleView, setAi, type, setBehaviorState: (s: LocalAiState) => (currentState = s) };
}

async function ready(options: { bridge?: boolean } = {}) {
  const t = setup({ ...options, initial: { state: "ready" } });
  await t.flush();
  return t;
}

describe("renderer - startup state", () => {
  it("shows only the startup view initially, with the calm Turkish startup copy and a progress indicator", async () => {
    const t = setup();
    await t.flush();
    expect(t.visibleView()).toEqual(["startup"]);
    expect(t.el("startup-title").textContent).toBe("Vyron Code hazırlanıyor");
    expect(t.el("startup-message").textContent).toBe("Yerel AI bağlantısı kontrol ediliyor…");
    expect(t.el("ai-status-text").textContent).toBe("Yerel AI başlatılıyor");
    expect(t.el("ai-status").className).toContain("ai-status-starting");
  });

  it("maps every startup stage to its own fixed message and never shows raw stage names", async () => {
    const t = setup();
    const expected: Record<string, string> = {
      checking: "Yerel AI bağlantısı kontrol ediliyor…",
      gateway: "Yerel AI motoru başlatılıyor…",
      proxy: "Güvenli bağlantı hazırlanıyor…",
      verifying: "Güvenli bağlantı doğrulanıyor…",
    };
    for (const stage of Object.keys(expected) as Array<"checking" | "gateway" | "proxy" | "verifying">) {
      t.setBehaviorState({ state: "starting", stage });
      await t.advance(700);
      expect(t.el("startup-message").textContent).toBe(expected[stage]);
    }
  });

  it("polls quickly while starting and slowly once ready", async () => {
    const t = setup();
    await t.flush();
    expect(t.timers.map((timer) => timer.delay)).toEqual([600]);
    await t.setAi({ state: "ready" });
    expect(t.timers.map((timer) => timer.delay)).toEqual([3000]);
  });

  it("clears any leftover main-process task state on every page load", async () => {
    const t = setup();
    await t.flush();
    expect(t.calls.clear).toBeGreaterThanOrEqual(1);
  });

  it("never shows a technical detail while starting", async () => {
    const t = setup();
    await t.flush();
    const visibleText = ["startup-title", "startup-message", "ai-status-text"].map((id) => t.el(id).textContent).join(" ");
    expect(visibleText).not.toMatch(/\d{4,5}|http|127\.|localhost|hermes|proxy|gateway|key|token|api/i);
  });
});

describe("renderer - ready workspace", () => {
  it("shows the composer, the ready pill and the fixed disclosure, and focuses the task field", async () => {
    const t = await ready();
    expect(t.visibleView()).toEqual(["ready"]);
    expect(t.el("ai-status-text").textContent).toBe("Yerel AI hazır");
    expect(t.el("ai-status").className).toContain("ai-status-ready");
    expect(t.el("ready-title").textContent).toBe("Ne üzerinde çalışmak istiyorsun?");
    expect(t.el("task-draft-hint").textContent).toBe("Yalnız bu metin gönderilir. Dosya, workspace, Git veya araç bağlamı paylaşılmaz.");
    expect(t.doc.activeElement?.id).toBe("task-draft-input");
  });

  it("keeps the review button disabled until there is a valid draft", async () => {
    const t = await ready();
    expect(t.el("task-review-btn").disabled).toBe(true);
    t.type("   \n\t ");
    expect(t.el("task-review-btn").disabled).toBe(true);
    t.type("Bir özet yaz");
    expect(t.el("task-review-btn").disabled).toBe(false);
  });

  it("rejects an over-long draft and a draft with a control character, with fixed messages", async () => {
    const t = await ready();
    t.type("a".repeat(4001));
    expect(t.el("task-review-btn").disabled).toBe(true);
    expect(t.el("task-draft-error").hidden).toBe(false);
    expect(t.el("task-draft-error").textContent).toBe("Metin çok uzun. En fazla 4000 karakter yazabilirsin.");
    t.type("merhaba" + String.fromCharCode(0) + "dünya");
    expect(t.el("task-review-btn").disabled).toBe(true);
    expect(t.el("task-draft-error").textContent).toBe("Metin desteklenmeyen karakterler içeriyor.");
    t.type("a".repeat(4000));
    expect(t.el("task-review-btn").disabled).toBe(false);
    expect(t.el("task-draft-error").hidden).toBe(true);
  });

  it("accepts multi-line text with tabs and newlines", async () => {
    const t = await ready();
    t.type("satır bir\n\tsatır iki");
    expect(t.el("task-review-btn").disabled).toBe(false);
  });
});

describe("renderer - unavailable state", () => {
  const categories: Array<[Extract<LocalAiState, { state: "unavailable" }>["category"], string]> = [
    ["hermes_start_failed", "Hermes başlatılamadı"],
    ["secure_connection_unverified", "Güvenli bağlantı doğrulanamadı"],
    ["model_unresponsive", "Yerel model yanıt vermiyor"],
    ["unavailable", "Yerel AI kullanılamıyor"],
  ];

  it.each(categories)("shows the fixed message for category %s", async (category, message) => {
    const t = setup({ initial: { state: "unavailable", category } });
    await t.flush();
    expect(t.visibleView()).toEqual(["unavailable"]);
    expect(t.el("unavailable-title").textContent).toBe("Yerel AI şu anda hazır değil.");
    expect(t.el("unavailable-category").textContent).toBe(message);
    expect(t.el("ai-status-text").textContent).toBe("Yerel AI kullanılamıyor");
    expect(t.doc.activeElement?.id).toBe("unavailable-title");
  });

  it("offers exactly the two actions, Tekrar dene and Tanılama bilgilerini kopyala", async () => {
    const t = setup({ initial: { state: "unavailable", category: "unavailable" } });
    await t.flush();
    expect(t.el("ai-retry-btn").textContent).toBe("Tekrar dene");
    expect(t.el("ai-copy-diagnostics-btn").textContent).toBe("Tanılama bilgilerini kopyala");
  });

  it("retry makes exactly one explicit request and returns to the startup view", async () => {
    const t = setup({ initial: { state: "unavailable", category: "hermes_start_failed" } });
    await t.flush();
    t.el("ai-retry-btn").click();
    await t.flush();
    expect(t.calls.retry).toBe(1);
    expect(t.visibleView()).toEqual(["startup"]);
  });

  it("never retries by itself, however long the page sits unavailable", async () => {
    const t = setup({ initial: { state: "unavailable", category: "hermes_start_failed" } });
    await t.flush();
    for (let i = 0; i < 5; i += 1) await t.advance(3_100);
    expect(t.calls.retry).toBe(0);
  });

  it("copy shows only a fixed confirmation, never the diagnostics text, and a fixed message on failure", async () => {
    const t = setup({ initial: { state: "unavailable", category: "unavailable" } });
    await t.flush();
    t.el("ai-copy-diagnostics-btn").click();
    await t.flush();
    expect(t.calls.copy).toBe(1);
    expect(t.el("ai-copy-status").textContent).toBe("Tanılama bilgileri kopyalandı.");
    t.behavior.copyResult = { copied: false };
    t.el("ai-copy-diagnostics-btn").click();
    await t.flush();
    expect(t.el("ai-copy-status").textContent).toBe("Tanılama bilgileri kopyalanamadı.");
    t.behavior.copyResult = "throw";
    t.el("ai-copy-diagnostics-btn").click();
    await t.flush();
    expect(t.el("ai-copy-status").textContent).toBe("Tanılama bilgileri kopyalanamadı.");
  });

  it("treats a missing desktop bridge as unavailable with a generic message and harmless buttons", async () => {
    const t = setup({ bridge: false });
    await t.flush();
    expect(t.visibleView()).toEqual(["unavailable"]);
    expect(t.el("unavailable-category").textContent).toBe("Yerel AI kullanılamıyor");
    t.el("ai-retry-btn").click();
    t.el("ai-copy-diagnostics-btn").click();
    await t.flush();
    expect(t.calls.retry + t.calls.copy).toBe(0);
  });

  it("a rejected state request becomes the generic unavailable state, never an error detail", async () => {
    const t = setup({ throwOnState: true });
    await t.advance(700);
    expect(t.visibleView()).toEqual(["unavailable"]);
    expect(t.el("unavailable-category").textContent).toBe("Yerel AI kullanılamıyor");
  });

  it("losing the local AI while a task is on screen resets the task flow, clears main-process state, and keeps only the in-memory draft", async () => {
    const t = await ready();
    t.type("Gizli olmayan bir görev");
    t.el("task-review-btn").click();
    await t.flush();
    expect(t.visibleView()).toEqual(["review"]);
    const clearsBefore = t.calls.clear;
    await t.setAi({ state: "unavailable", category: "model_unresponsive" });
    expect(t.visibleView()).toEqual(["unavailable"]);
    expect(t.calls.clear).toBeGreaterThan(clearsBefore);
    expect(t.el("task-review-text").textContent).toBe("");
    await t.setAi({ state: "ready" });
    expect(t.visibleView()).toEqual(["ready"]);
    expect(t.el("task-draft-input").value).toBe("Gizli olmayan bir görev");
  });
});

describe("renderer - review, send, response and clear (existing D-11 behavior preserved)", () => {
  it("review sends exactly one { draft } object and shows the exact text with the four fixed disclosures", async () => {
    const t = await ready();
    const draft = "Bu benim görevim.\n\tİkinci satır  ";
    t.type(draft);
    t.el("task-review-btn").click();
    await t.flush();
    expect(t.calls.review).toEqual([{ draft }]);
    expect(Object.keys(t.calls.review[0] as object)).toEqual(["draft"]);
    expect(t.visibleView()).toEqual(["review"]);
    expect(t.el("task-review-text").textContent).toBe(draft);
    expect(t.el("review-title").textContent).toBe("Göndermeden önce incele");
    expect(html).toContain("Yalnız bu metni gönderir");
    expect(html).toContain("Dosya, workspace, Git veya araç bağlamı göndermez");
    expect(html).toContain("Araçlar ve MCP kapalıdır");
    expect(html).toContain("Kalıcı task geçmişi oluşturmaz");
    expect(t.el("task-send-btn").textContent).toBe("İncelenen task'ı gönder");
    expect(t.el("task-review-back-btn").textContent).toBe("Geri dön");
    expect(t.doc.activeElement?.id).toBe("review-title");
  });

  it("refuses a review result whose reported length does not match the draft", async () => {
    const t = await ready();
    t.behavior.reviewResult = { state: "review_ready", draftLength: 3, text: null, truncated: false };
    t.type("uzun bir metin");
    t.el("task-review-btn").click();
    await t.flush();
    expect(t.visibleView()).toEqual(["ready"]);
    expect(t.el("task-draft-error").textContent).toBe("Taslak incelemeye alınamadı. Lütfen tekrar deneyin.");
  });

  it("send is explicit, happens once, shows the progress text, then the bounded plain-text answer", async () => {
    const t = await ready();
    t.type("Merhaba");
    t.el("task-review-btn").click();
    await t.flush();
    let release!: () => void;
    t.behavior.sendGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.el("task-send-btn").click();
    await t.flush();
    expect(t.calls.send).toBe(1);
    expect(t.el("task-send-status").textContent).toBe("Yanıt hazırlanıyor…");
    expect(t.el("task-send-status").hidden).toBe(false);
    expect(t.el("task-send-btn").disabled).toBe(true);
    expect(t.el("task-review-back-btn").disabled).toBe(true);
    t.el("task-send-btn").dispatch("click");
    await t.flush();
    expect(t.calls.send).toBe(1);
    release();
    await t.flush();
    expect(t.el("task-response-section").hidden).toBe(false);
    expect(t.el("task-response-title").textContent).toBe("Yanıt");
    expect(t.el("task-response-text").textContent).toBe("Yanıt metni");
    expect(t.el("task-send-status").hidden).toBe(true);
    expect(t.el("task-response-truncated-note").hidden).toBe(true);
    expect(t.doc.activeElement?.id).toBe("task-response-title");
  });

  it("renders a hostile answer as inert text: no markup, no element creation, no innerHTML", async () => {
    const t = await ready();
    const hostile = '<img src=x onerror="alert(1)"> **bold** [link](https://example.test) <script>alert(2)</script>';
    t.behavior.sendResult = { state: "completed", draftLength: null, text: hostile, truncated: false };
    t.type("x");
    t.el("task-review-btn").click();
    await t.flush();
    t.el("task-send-btn").click();
    await t.flush();
    expect(t.el("task-response-text").textContent).toBe(hostile);
    expect(rendererSource.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|createElement|DOMParser/);
  });

  it("shows the truncation note only when the answer was truncated", async () => {
    const t = await ready();
    t.behavior.sendResult = { state: "completed", draftLength: null, text: "kısaltılmış", truncated: true };
    t.type("x");
    t.el("task-review-btn").click();
    await t.flush();
    t.el("task-send-btn").click();
    await t.flush();
    expect(t.el("task-response-truncated-note").hidden).toBe(false);
    expect(t.el("task-response-truncated-note").textContent).toBe("Yanıt kısaltıldı.");
  });

  it("a failed send shows one fixed message and never a detail; back is available again", async () => {
    const t = await ready();
    t.behavior.sendResult = { state: "safe_failure", draftLength: null, text: "raw provider error body", truncated: false };
    t.type("x");
    t.el("task-review-btn").click();
    await t.flush();
    t.el("task-send-btn").click();
    await t.flush();
    expect(t.el("task-send-status").textContent).toBe("Yanıt alınamadı. Lütfen tekrar deneyin.");
    expect(t.el("task-response-text").textContent).toBe("");
    expect(t.el("task-review-back-btn").disabled).toBe(false);
  });

  it("an unauthorized send result says the local AI is not ready and resumes state polling", async () => {
    const t = await ready();
    t.behavior.sendResult = { state: "unauthorized", draftLength: null, text: null, truncated: false };
    t.type("x");
    t.el("task-review-btn").click();
    await t.flush();
    const getStateBefore = t.calls.getState;
    t.el("task-send-btn").click();
    await t.flush();
    expect(t.el("task-send-status").textContent).toBe("Yerel AI şu anda hazır değil.");
    expect(t.calls.getState).toBeGreaterThan(getStateBefore);
  });

  it("back invalidates the review: it clears the main-process snapshot and nothing can be sent without a new review", async () => {
    const t = await ready();
    t.type("İlk metin");
    t.el("task-review-btn").click();
    await t.flush();
    const clearsBefore = t.calls.clear;
    t.el("task-review-back-btn").click();
    await t.flush();
    expect(t.calls.clear).toBeGreaterThan(clearsBefore);
    expect(t.visibleView()).toEqual(["ready"]);
    expect(t.el("task-review-text").textContent).toBe("");
    t.el("task-send-btn").dispatch("click");
    await t.flush();
    expect(t.calls.send).toBe(0);
    expect(t.el("task-draft-input").value).toBe("İlk metin");
  });

  it("editing the draft after going back requires a new review of the new text", async () => {
    const t = await ready();
    t.type("Eski metin");
    t.el("task-review-btn").click();
    await t.flush();
    t.el("task-review-back-btn").click();
    await t.flush();
    t.type("Yeni metin");
    t.el("task-review-btn").click();
    await t.flush();
    expect(t.calls.review).toEqual([{ draft: "Eski metin" }, { draft: "Yeni metin" }]);
    expect(t.el("task-review-text").textContent).toBe("Yeni metin");
  });

  it("Yanıtı temizle clears the answer, the draft and the main-process state, and returns to a fresh composer", async () => {
    const t = await ready();
    t.type("Bir soru");
    t.el("task-review-btn").click();
    await t.flush();
    t.el("task-send-btn").click();
    await t.flush();
    const clearsBefore = t.calls.clear;
    t.el("task-clear-response-btn").click();
    await t.flush();
    expect(t.calls.clear).toBeGreaterThan(clearsBefore);
    expect(t.el("task-draft-input").value).toBe("");
    expect(t.el("task-response-text").textContent).toBe("");
    expect(t.el("task-response-section").hidden).toBe(true);
    expect(t.visibleView()).toEqual(["ready"]);
    expect(t.el("task-review-btn").disabled).toBe(true);
    expect(t.doc.activeElement?.id).toBe("task-draft-input");
  });

  it("a stale review response cannot reopen the review after the user has moved on", async () => {
    const t = await ready();
    t.type("Metin");
    t.el("task-review-btn").click();
    t.el("task-review-back-btn").dispatch("click");
    await t.flush();
    expect(t.visibleView()).not.toContain("review");
  });
});

describe("renderer - keyboard and focus", () => {
  it("Ctrl+Enter in the task field starts the review, and plain Enter does not", async () => {
    const t = await ready();
    t.type("Klavye ile");
    const plain = t.el("task-draft-input").dispatch("keydown", { key: "Enter", ctrlKey: false, metaKey: false });
    await t.flush();
    expect(plain.defaultPrevented).toBe(false);
    expect(t.calls.review).toEqual([]);
    const combo = t.el("task-draft-input").dispatch("keydown", { key: "Enter", ctrlKey: true, metaKey: false });
    await t.flush();
    expect(combo.defaultPrevented).toBe(true);
    expect(t.calls.review).toEqual([{ draft: "Klavye ile" }]);
  });

  it("Ctrl+Enter does nothing while the draft is invalid", async () => {
    const t = await ready();
    t.type("   ");
    t.el("task-draft-input").dispatch("keydown", { key: "Enter", ctrlKey: true });
    await t.flush();
    expect(t.calls.review).toEqual([]);
  });

  it("Escape in the review view goes back and refocuses the task field; elsewhere it does nothing", async () => {
    const t = await ready();
    t.doc.dispatch("keydown", { key: "Escape" });
    expect(t.calls.clear).toBe(1);
    t.type("Metin");
    t.el("task-review-btn").click();
    await t.flush();
    t.doc.dispatch("keydown", { key: "Escape" });
    await t.flush();
    expect(t.visibleView()).toEqual(["ready"]);
    expect(t.doc.activeElement?.id).toBe("task-draft-input");
  });

  it("Escape is ignored while an answer is being prepared", async () => {
    const t = await ready();
    t.type("Metin");
    t.el("task-review-btn").click();
    await t.flush();
    t.behavior.sendGate = new Promise<void>(() => undefined);
    t.el("task-send-btn").click();
    await t.flush();
    t.doc.dispatch("keydown", { key: "Escape" });
    await t.flush();
    expect(t.visibleView()).toEqual(["review"]);
  });

  it("moves focus to the new view's heading on every transition", async () => {
    const t = setup();
    await t.flush();
    await t.setAi({ state: "unavailable", category: "hermes_start_failed" });
    expect(t.doc.activeElement?.id).toBe("unavailable-title");
    t.behavior.retryState = { state: "starting", stage: "gateway" };
    t.el("ai-retry-btn").click();
    await t.flush();
    await t.setAi({ state: "ready" });
    expect(t.doc.activeElement?.id).toBe("task-draft-input");
  });

  it("every interactive control is a real button or the one textarea, in a sensible DOM order", () => {
    const controlIds = [...html.matchAll(/<(button|textarea)\b[^>]*\bid="([^"]+)"/g)].map((m) => m[2]);
    expect(controlIds).toEqual([
      "task-draft-input",
      "task-review-btn",
      "task-review-back-btn",
      "task-send-btn",
      "task-clear-response-btn",
      "ai-retry-btn",
      "ai-copy-diagnostics-btn",
    ]);
    expect(html).not.toMatch(/tabindex="[1-9]/);
    expect(html).not.toMatch(/onclick=|onkeydown=|javascript:/i);
  });
});

describe("renderer - no forbidden UI and no persistence", () => {
  it("contains exactly one text control (the task textarea): no input, select, checkbox, file, password or URL field", () => {
    expect(html.match(/<textarea\b/g)).toHaveLength(1);
    for (const forbidden of [/<input\b/i, /<select\b/i, /<option\b/i, /<form\b/i, /type="(password|file|url|checkbox|radio)"/i, /contenteditable/i]) {
      expect(html).not.toMatch(forbidden);
    }
  });

  it("shows no endpoint, key, provider, model, session, port, path or workspace-attachment UI in the page text", () => {
    const visible = html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<[^>]+>/g, " ")
      .toLowerCase();
    for (const forbidden of ["endpoint", "api key", "api anahtar", "provider", "session", "oturum", "127.0.0.1", "localhost", "8642", "8643", "token", "sağlayıcı", "model seç", "klasör", "dosya ekle", "git özeti"]) {
      expect(visible, `page text unexpectedly contains: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("has no chat history, session picker, model picker or attachment control ids", () => {
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1] as string);
    for (const id of ids) expect(id).not.toMatch(/history|session|picker|model|provider|endpoint|attach|workspace|git|folder|tool/i);
  });

  it("keeps the strict CSP and loads only its own local script and stylesheet", () => {
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("script-src 'self'");
    expect(html).toContain('<script src="renderer.js"></script>');
    expect(html).toContain('<link rel="stylesheet" href="renderer.css" />');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("uses no storage, network, cookie, eval or timer-string API", () => {
    for (const forbidden of [/localStorage|sessionStorage|indexedDB|document\.cookie/, /\bfetch\(|XMLHttpRequest|WebSocket|EventSource/, /\beval\(|new Function\(/, /setTimeout\(\s*["'`]/, /navigator\.clipboard/]) {
      expect(rendererSource).not.toMatch(forbidden);
    }
  });

  it("is a classic script: no top-level import or export", () => {
    expect(rendererSource).not.toMatch(/^import\s/m);
    expect(rendererSource).not.toMatch(/^export\s/m);
  });

  it("never handles a credential, endpoint or path: the only bridge calls are the seven fixed methods", () => {
    const calls = new Set([...rendererSource.matchAll(/api\.(localAi|hermes)\.(\w+)\(/g)].map((m) => `${m[1]}.${m[2]}`));
    expect(calls).toEqual(
      new Set([
        "localAi.getLocalAiState",
        "localAi.retryLocalAiStartup",
        "localAi.copyLocalAiDiagnostics",
        "hermes.reviewTaskDraft",
        "hermes.sendReviewedTask",
        "hermes.clearTaskSubmission",
      ]),
    );
  });

  it("does not persist a draft or answer across a reload: a fresh page starts empty and clears the main process", async () => {
    const first = await ready();
    first.type("Yeniden yüklenince kaybolmalı");
    first.el("task-review-btn").click();
    await first.flush();
    first.el("task-send-btn").click();
    await first.flush();
    expect(first.el("task-response-text").textContent).not.toBe("");
    const second = setup({ initial: { state: "ready" } });
    await second.flush();
    expect(second.el("task-draft-input").value).toBe("");
    expect(second.el("task-response-text").textContent).toBe("");
    expect(second.el("task-response-section").hidden).toBe(true);
    expect(second.calls.clear).toBeGreaterThanOrEqual(1);
  });
});
