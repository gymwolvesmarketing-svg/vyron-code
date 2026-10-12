import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { JSDOM } from "jsdom";

// Shared jsdom harness for the workspace renderer tests. It loads the REAL electron/renderer.html and
// runs the REAL workspace-model.ts and renderer.ts (transpiled, as classic scripts, in one context,
// exactly as the page loads them) against a controllable fake of the `window.vyronDesktop` bridge.

const electronDir = path.join(__dirname, "..", "electron");
export const html = fs.readFileSync(path.join(electronDir, "renderer.html"), "utf8");
export const rendererSource = fs.readFileSync(path.join(electronDir, "renderer.ts"), "utf8");
export const modelSource = fs.readFileSync(path.join(electronDir, "workspace-model.ts"), "utf8");

function transpile(source: string): string {
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
}

export const modelJs = transpile(modelSource);
export const rendererJs = transpile(rendererSource);

export type FakeAiState =
  | { state: "starting"; stage: "checking" | "gateway" | "proxy" | "verifying" }
  | { state: "ready" }
  | { state: "unavailable"; category: "hermes_start_failed" | "secure_connection_unverified" | "model_unresponsive" | "unavailable" };

export interface FakeTaskResult {
  state: string;
  text: string | null;
  truncated: boolean;
}

export interface Harness {
  dom: JSDOM;
  win: Window & typeof globalThis;
  doc: Document;
  calls: { getState: number; retry: number; copy: number; send: Array<{ draft: string; agent?: string; models?: unknown }>; clear: number; devTools: number; memoryClears: number; picks: number; pickProjects: Array<string | null>; workspaceClears: number; permissionClears: number };
  behavior: {
    aiState: FakeAiState;
    retryState: FakeAiState;
    copyResult: { copied: boolean } | "throw";
    sendResult: FakeTaskResult;
    sendQueue: FakeTaskResult[];
    sendGate: Promise<void> | null;
    sendThrows: boolean;
    memoryClearResult: boolean;
    folderName: string | null;
    pickFolderName: string | null;
    alwaysCount: number;
  };
  el<T extends HTMLElement = HTMLElement>(id: string): T;
  flush(): Promise<void>;
  type(text: string): void;
  key(target: EventTarget, key: string, init?: KeyboardEventInit): KeyboardEvent;
  click(target: HTMLElement | null): void;
  outsideClick(): void;
  visibleViews(): string[];
  menuLabels(): string[];
  openMenus(): HTMLElement[];
  storageText(): string | null;
  turnsText(): string | null;
  close(): void;
}

export interface SetupOptions {
  bridge?: boolean;
  ai?: FakeAiState;
  storage?: string | null;
  turns?: string | null;
}

export function setup(options: SetupOptions = {}): Harness {
  const errors: unknown[] = [];
  const calls = { getState: 0, retry: 0, copy: 0, send: [] as Array<{ draft: string; agent?: string; models?: unknown }>, clear: 0, devTools: 0, memoryClears: 0, picks: 0, pickProjects: [] as Array<string | null>, workspaceClears: 0, permissionClears: 0 };
  const folders = new Map<string, string>();
  const behavior: Harness["behavior"] = {
    aiState: options.ai ?? { state: "ready" },
    retryState: { state: "starting", stage: "checking" },
    copyResult: { copied: true },
    sendResult: { state: "completed", text: "Yanıt metni", truncated: false },
    sendQueue: [],
    sendGate: null,
    sendThrows: false,
    memoryClearResult: true,
    folderName: null,
    pickFolderName: "ProjeKlasoru",
    alwaysCount: 0,
  };
  const dom = new JSDOM(html.replace(/<script src="[^"]+"><\/script>/g, ""), {
    url: "http://localhost/renderer.html",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    beforeParse(window) {
      if (options.storage) window.localStorage.setItem("vyron.workspace.v1", options.storage);
      if (options.turns) window.localStorage.setItem("vyron.turns.v1", options.turns);
      if (options.bridge !== false) {
        (window as unknown as Record<string, unknown>).vyronDesktop = {
          localAi: {
            getLocalAiState: async () => {
              calls.getState += 1;
              return behavior.aiState;
            },
            retryLocalAiStartup: async () => {
              calls.retry += 1;
              behavior.aiState = behavior.retryState;
              return behavior.retryState;
            },
            copyLocalAiDiagnostics: async () => {
              calls.copy += 1;
              if (behavior.copyResult === "throw") throw new Error("boom");
              return behavior.copyResult;
            },
          },
          app: {
            toggleDevTools: async () => {
              calls.devTools += 1;
            },
            clearAgentMemory: async () => {
              calls.memoryClears += 1;
              return behavior.memoryClearResult;
            },
          },
          tools: {
            // Mirrors the main process: each project remembers its own folder; no project = no folder.
            getWorkspace: async (projectId?: string) => {
              if (typeof projectId === "string") behavior.folderName = folders.get(projectId) ?? null;
              return { folderName: behavior.folderName, alwaysCount: behavior.alwaysCount };
            },
            pickWorkspace: async (projectId?: string) => {
              calls.picks += 1;
              calls.pickProjects.push(projectId ?? null);
              behavior.folderName = behavior.pickFolderName;
              if (typeof projectId === "string") folders.set(projectId, behavior.pickFolderName ?? "");
              return { folderName: behavior.folderName, alwaysCount: behavior.alwaysCount };
            },
            clearWorkspace: async (projectId?: string) => {
              if (typeof projectId === "string") {
                calls.workspaceClears += 1;
                folders.delete(projectId);
              }
              behavior.folderName = null;
              return { folderName: null, alwaysCount: behavior.alwaysCount };
            },
            clearPermissions: async () => {
              calls.permissionClears += 1;
              behavior.alwaysCount = 0;
              return { folderName: behavior.folderName, alwaysCount: 0 };
            },
          },
          hermes: {
            getTaskSubmissionState: async () => ({ state: "idle", text: null, truncated: false }),
            sendTask: async (request: { draft: string }) => {
              calls.send.push(request);
              if (behavior.sendGate) await behavior.sendGate;
              if (behavior.sendThrows) throw new Error("boom");
              return behavior.sendQueue.shift() ?? behavior.sendResult;
            },
            clearTaskSubmission: async () => {
              calls.clear += 1;
              return { state: "idle", text: null, truncated: false };
            },
          },
        };
      }
      window.addEventListener("error", (event) => errors.push(event.error ?? event.message));
    },
  });
  const context = dom.getInternalVMContext();
  new vm.Script(modelJs).runInContext(context);
  new vm.Script(rendererJs).runInContext(context);
  const win = dom.window as unknown as Window & typeof globalThis;
  const doc = win.document;

  const harness: Harness = {
    dom,
    win,
    doc,
    calls,
    behavior,
    el<T extends HTMLElement = HTMLElement>(id: string): T {
      const node = doc.getElementById(id);
      if (!node) throw new Error("missing element " + id);
      return node as T;
    },
    async flush() {
      for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    },
    type(text: string) {
      const input = harness.el<HTMLTextAreaElement>("task-input");
      input.value = text;
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
    },
    key(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
      const event = new win.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    },
    click(target: HTMLElement | null) {
      if (!target) throw new Error("click target missing");
      target.click();
    },
    outsideClick() {
      doc.body.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true }));
    },
    visibleViews() {
      return ["new-task", "skills", "connectors", "sites", "manager", "settings"].filter((name) => !harness.el("view-" + name).hidden);
    },
    menuLabels() {
      return Array.from(doc.querySelectorAll("#menu-layer .menu-item, #menu-layer .picker-row")).map((n) => (n.textContent ?? "").trim());
    },
    openMenus() {
      return Array.from(doc.querySelectorAll<HTMLElement>("#menu-layer > *"));
    },
    storageText() {
      return win.localStorage.getItem("vyron.workspace.v1");
    },
    turnsText() {
      return win.localStorage.getItem("vyron.turns.v1");
    },
    close() {
      dom.window.close();
    },
  };
  (harness as unknown as { errors: unknown[] }).errors = errors;
  return harness;
}

export async function ready(options: SetupOptions = {}): Promise<Harness> {
  const h = setup({ ...options, ai: options.ai ?? { state: "ready" } });
  await h.flush();
  return h;
}

export function errorsOf(h: Harness): unknown[] {
  return (h as unknown as { errors: unknown[] }).errors;
}
