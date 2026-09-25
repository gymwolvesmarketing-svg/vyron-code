import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { modelJs } from "./workspaceHarness";

// Pure model tests: the real workspace-model.ts, transpiled and run as a classic script.
interface Model {
  STORAGE_KEY: string;
  SKILLS: Array<{ id: string; name: string; category: string; tag: string }>;
  QUICK_STARTS: Array<{ id: string; label: string; draft: string }>;
  defaultState(): any;
  sanitizeState(raw: unknown): any;
  loadState(storage: any): any;
  saveState(storage: any, state: any): boolean;
  resetState(storage: any): any;
  matchesQuery(query: string, ...fields: string[]): boolean;
  createProject(state: any, name: string): any;
  createTask(state: any, projectId: string | null, title: string): any;
  visibleTasks(state: any, project: any): { visible: any[]; hidden: number };
  createManager(state: any, name: string, description: string): any;
  removeManager(state: any, id: string): boolean;
  createConnector(state: any, name: string, description: string): any;
  setConnectorStatus(state: any, id: string, status: string): void;
  removeConnector(state: any, id: string): boolean;
  normalizeSiteAddress(raw: string): string | null;
  createSite(state: any, name: string, address: string): any;
  titleFromPrompt(text: string): string;
  draftProblem(text: string): string;
  composePrompt(input: any): string;
  formatFileSize(bytes: number): string;
  parseResponse(text: string): any[];
  toggleId(list: string[], id: string): string[];
}

function load(): Model {
  const context = vm.createContext({ URL, Date, Math, JSON, Set, Array, Object });
  vm.runInContext(modelJs + "\nglobalThis.__model = VyronModel;", context);
  return (context as unknown as { __model: Model }).__model;
}

const model = load();

class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

describe("seed content", () => {
  it("seeds the required projects, managers, connectors, skills and quick starts", () => {
    const state = model.defaultState();
    expect(state.projects.map((p: any) => p.name)).toEqual(["new-project", "AETHERIS", "HANGIKARGOO"]);
    expect(state.managers.map((m: any) => m.name)).toEqual(["Genel", "Vyron Helper", "Multi-Model Planner", "Reviewer"]);
    expect(state.connectors.map((c: any) => c.name)).toEqual(["GitHub", "Supabase", "Vercel", "Stripe", "Slack", "Gmail", "Notion"]);
    expect(state.connectors.every((c: any) => c.status === "disconnected")).toBe(true);
    expect(model.SKILLS.map((s) => s.name)).toEqual(["Confirmed Data Analysis", "Create Image", "Design Then Build", "Find Skills", "Frontend Design", "Skill Creator"]);
    expect(model.SKILLS.every((s) => s.category === "Kullanıcı" && s.tag.length > 0)).toBe(true);
    expect(model.QUICK_STARTS.map((q) => q.label)).toEqual([
      "Fikri keşfet",
      "Uygulama oluştur",
      "Önce tasarla",
      "Sunum oluştur",
      "Veri analizi",
      "Doküman analizi",
      "Derin araştırma",
      "Görsel oluştur",
      "Video oluştur",
    ]);
    expect(state.sites.map((s: any) => s.address)).toEqual(["https://gymwolves.com.tr"]);
  });

  it("uses no branded third-party names in product content", () => {
    const text = JSON.stringify(model.defaultState()) + JSON.stringify(model.QUICK_STARTS) + JSON.stringify(model.SKILLS);
    expect(text.toLowerCase()).not.toContain("verdent");
  });
});

describe("persistence", () => {
  it("round-trips a saved state and never stores drafts, task text or answers (the schema has no such field)", () => {
    const storage = new MemoryStorage();
    const state = model.defaultState();
    model.createProject(state, "Deneme");
    model.createTask(state, null, "Bir başlık");
    expect(model.saveState(storage, state)).toBe(true);
    const loaded = model.loadState(storage);
    expect(loaded.projects.map((p: any) => p.name)).toContain("Deneme");
    expect(loaded.tasks[0].title).toBe("Bir başlık");
    const keys = new Set<string>();
    const walk = (value: any) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") {
        Object.keys(value).forEach((k) => keys.add(k));
        Object.values(value).forEach(walk);
      }
    };
    walk(JSON.parse(storage.getItem(model.STORAGE_KEY) as string));
    for (const forbidden of ["draft", "prompt", "text", "response", "answer", "attachments", "apiKey", "token", "endpoint"]) expect(keys.has(forbidden)).toBe(false);
  });

  it("falls back to the defaults for missing, corrupt, wrong-version or hostile stored data", () => {
    const fresh = model.defaultState();
    expect(model.loadState(null).projects).toHaveLength(fresh.projects.length);
    for (const bad of ["", "{", "null", "[]", '"x"', '{"version":99}', '{"version":1,"projects":"nope"}']) {
      const storage = new MemoryStorage();
      storage.setItem(model.STORAGE_KEY, bad);
      const loaded = model.loadState(storage);
      expect(loaded.projects.length).toBeGreaterThan(0);
      expect(loaded.managers.length).toBeGreaterThan(0);
    }
  });

  it("drops invalid entries and unknown references while keeping valid ones", () => {
    const raw = {
      version: 1,
      projects: [{ id: "p1", name: "İyi" }, { id: "", name: "kötü" }, 5, { id: "p2", name: "  " }],
      tasks: [{ id: "t1", projectId: "p1", title: "Görev" }, { id: "t2", projectId: "yok", title: "Yetim" }, { title: "id yok" }],
      activeProjectId: "yok",
      selectedManagerId: "yok",
      selectedSkillIds: ["find-skills", "olmayan", 7],
      selectedConnectorIds: ["github"],
      planMode: "hack",
      terminalMode: "suggest",
      workMode: "brief",
    };
    const state = model.sanitizeState(raw);
    expect(state.projects.map((p: any) => p.id)).toEqual(["p1"]);
    expect(state.tasks.map((t: any) => [t.id, t.projectId])).toEqual([["t1", "p1"], ["t2", null]]);
    expect(state.activeProjectId).toBeNull();
    expect(state.selectedManagerId).toBeNull();
    expect(state.selectedSkillIds).toEqual(["find-skills"]);
    expect(state.selectedConnectorIds).toEqual([]);
    expect(state.planMode).toBe("standard");
    expect(state.terminalMode).toBe("suggest");
    expect(state.workMode).toBe("brief");
  });

  it("does not keep a selected connector that is no longer connected", () => {
    const state = model.defaultState();
    model.setConnectorStatus(state, "github", "connected");
    state.selectedConnectorIds = ["github"];
    model.setConnectorStatus(state, "github", "disconnected");
    expect(state.selectedConnectorIds).toEqual([]);
  });

  it("survives a storage that throws", () => {
    const throwing = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
      removeItem() {
        throw new Error("blocked");
      },
    };
    expect(model.loadState(throwing).projects.length).toBe(3);
    expect(model.saveState(throwing, model.defaultState())).toBe(false);
    expect(model.resetState(throwing).projects.length).toBe(3);
    expect(model.saveState(null, model.defaultState())).toBe(false);
  });

  it("resetState removes the stored data", () => {
    const storage = new MemoryStorage();
    model.saveState(storage, model.defaultState());
    model.resetState(storage);
    expect(storage.getItem(model.STORAGE_KEY)).toBeNull();
  });
});

describe("projects, tasks, managers, connectors, sites", () => {
  it("creates projects with cleaned names, de-duplicating case-insensitively (Turkish aware)", () => {
    const state = model.defaultState();
    const a = model.createProject(state, "  Yeni   İş ");
    expect(a.name).toBe("Yeni İş");
    expect(model.createProject(state, "yeni iş").id).toBe(a.id);
    expect(model.createProject(state, "   ")).toBeNull();
    expect(model.createProject(state, "x".repeat(100)).name).toHaveLength(40);
  });

  it("creates tasks newest-first with a short single-line title", () => {
    const state = model.defaultState();
    const task = model.createTask(state, "aetheris", "\n\n  İlk satır  \nikinci satır");
    expect(task.title).toBe("İlk satır");
    expect(state.tasks[0].id).toBe(task.id);
    expect(model.titleFromPrompt("x".repeat(80))).toHaveLength(48);
    expect(model.titleFromPrompt("   ")).toBe("Yeni görev");
  });

  it("collapses long task lists to four with a hidden count", () => {
    const state = model.defaultState();
    const aetheris = state.projects.find((p: any) => p.id === "aetheris");
    expect(model.visibleTasks(state, aetheris)).toMatchObject({ hidden: 2 });
    expect(model.visibleTasks(state, aetheris).visible).toHaveLength(4);
    aetheris.showAll = true;
    expect(model.visibleTasks(state, aetheris)).toMatchObject({ hidden: 0 });
    expect(model.visibleTasks(state, aetheris).visible).toHaveLength(6);
  });

  it("caps stored tasks", () => {
    const state = model.defaultState();
    for (let i = 0; i < 400; i += 1) model.createTask(state, null, "t" + String(i));
    expect(state.tasks.length).toBe(300);
  });

  it("only custom managers and connectors can be removed", () => {
    const state = model.defaultState();
    expect(model.removeManager(state, "genel")).toBe(false);
    const manager = model.createManager(state, "Özel", "");
    expect(manager.custom).toBe(true);
    expect(model.removeManager(state, manager.id)).toBe(true);
    expect(model.removeConnector(state, "github")).toBe(false);
    const connector = model.createConnector(state, "Linear", "Takip");
    expect(model.removeConnector(state, connector.id)).toBe(true);
  });

  it("validates site addresses: http(s) with a dotted host only", () => {
    expect(model.normalizeSiteAddress("gymwolves.com.tr")).toBe("https://gymwolves.com.tr");
    expect(model.normalizeSiteAddress("http://ornek.com/yol")).toBe("http://ornek.com/yol");
    for (const bad of ["", "javascript:alert(1)", "file:///c:/x", "localhost", "a b.com", "https://user:pw@x.com", "ftp://x.com", "x".repeat(300) + ".com"]) {
      expect(model.normalizeSiteAddress(bad), bad).toBeNull();
    }
    const state = model.defaultState();
    expect(model.createSite(state, "", "ornek.com").name).toBe("ornek.com");
    expect(model.createSite(state, "tekrar", "https://ornek.com").address).toBe("https://ornek.com");
    expect(state.sites).toHaveLength(2);
  });
});

describe("search, drafts, prompts and answers", () => {
  it("matches queries case-insensitively with Turkish casing", () => {
    expect(model.matchesQuery("IŞIK", "ışık lambası")).toBe(true);
    expect(model.matchesQuery("İstanbul", "istanbul")).toBe(true);
    expect(model.matchesQuery("", "her şey")).toBe(true);
    expect(model.matchesQuery("yok", "a", "b")).toBe(false);
  });

  it("classifies drafts", () => {
    expect(model.draftProblem("")).toBe("empty");
    expect(model.draftProblem("  \n ")).toBe("empty");
    expect(model.draftProblem("x".repeat(4001))).toBe("too_long");
    expect(model.draftProblem("a" + String.fromCharCode(7))).toBe("invalid");
    expect(model.draftProblem("a\n\tb\r\nc")).toBe("ok");
    expect(model.draftProblem("x".repeat(4000))).toBe("ok");
  });

  it("composes the outgoing prompt: unchanged without selections, prefixed context otherwise", () => {
    const base = { draft: "Merhaba", workMode: "local", planMode: "standard", terminalMode: "off", managerName: null, skillNames: [], connectorNames: [] };
    expect(model.composePrompt(base)).toBe("Merhaba");
    const full = model.composePrompt({ ...base, workMode: "brief", planMode: "plan", terminalMode: "suggest", managerName: "Reviewer", skillNames: ["A", "B"], connectorNames: ["Slack"] });
    expect(full.endsWith("\n\nMerhaba")).toBe(true);
    expect(full).toContain("Rol: Reviewer.");
    expect(full).toContain("Kullanılacak yetenekler: A, B.");
    expect(full).toContain("Bağlam olarak seçilen bağlayıcılar: Slack.");
    expect(full).toContain("Kısa ve doğrudan yanıtla.");
    expect(full).toContain("Önce kısa bir plan çıkar");
    expect(full).toContain("hiçbir komut çalıştırma");
  });

  it("formats file sizes", () => {
    expect(model.formatFileSize(0)).toBe("0 B");
    expect(model.formatFileSize(2048)).toBe("2.0 KB");
    expect(model.formatFileSize(50 * 1024)).toBe("50 KB");
    expect(model.formatFileSize(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(model.formatFileSize(-1)).toBe("");
  });

  it("parses answers into paragraphs, lists and code blocks without interpreting markup", () => {
    const blocks = model.parseResponse("Giriş\nikinci satır\n\n- a\n- b\n\n1. bir\n2) iki\n\n```js\nx <b>\n```\n<b>son</b>");
    expect(blocks).toEqual([
      { kind: "paragraph", text: "Giriş\nikinci satır" },
      { kind: "list", ordered: false, items: ["a", "b"] },
      { kind: "list", ordered: true, items: ["bir", "iki"] },
      { kind: "code", text: "x <b>" },
      { kind: "paragraph", text: "<b>son</b>" },
    ]);
    expect(model.parseResponse("")).toEqual([]);
    expect(model.parseResponse("```\nkapanmamış")).toEqual([{ kind: "code", text: "kapanmamış" }]);
  });

  it("toggles ids", () => {
    expect(model.toggleId(["a"], "b")).toEqual(["a", "b"]);
    expect(model.toggleId(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("model choice per slot", () => {
  it("starts with the three Vyron combos and offers exactly the fixed options", () => {
    const state = model.defaultState();
    expect(state.models).toEqual({ assistant: "vyron-assistant", code: "vyron-code", research: "vyron-research" });
    expect((model as any).MODEL_OPTIONS.map((o: any) => o.id)).toEqual(["", "vyron-assistant", "vyron-code", "vyron-research"]);
    expect((model as any).MODEL_SLOTS.map((s: any) => s.id)).toEqual(["assistant", "code", "research"]);
  });

  it("keeps a valid saved choice and falls back to the default for anything else", () => {
    const raw = { ...model.defaultState(), models: { assistant: "", code: "gpt-4o", research: "vyron-code", extra: "x" } };
    expect(model.sanitizeState(JSON.parse(JSON.stringify(raw))).models).toEqual({ assistant: "", code: "vyron-code", research: "vyron-code" });
    const old = JSON.parse(JSON.stringify(model.defaultState()));
    delete old.models;
    expect(model.sanitizeState(old).models).toEqual(model.defaultState().models);
  });
});
