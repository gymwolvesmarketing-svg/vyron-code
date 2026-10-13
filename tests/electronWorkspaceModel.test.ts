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
    expect(state.managers.map((m: any) => m.name)).toEqual(["Genel", "CTO", "Vyron Helper", "Coder", "Multi-Model Planner", "Konsey", "Derin Araştırma", "Reviewer"]);
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
    expect(model.draftProblem("x".repeat(100001))).toBe("too_long");
    expect(model.draftProblem("a" + String.fromCharCode(7))).toBe("invalid");
    expect(model.draftProblem("a\n\tb\r\nc")).toBe("ok");
    expect(model.draftProblem("x".repeat(100000))).toBe("ok");
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

describe("Coder handoff does not repeat the audit", () => {
  it("composeHandoff tells the Coder the plan already comes from a real audit, and not to redo it", () => {
    const state = model as any;
    const text = state.composeHandoff("1. Adım\n2. Adım");
    expect(text).toContain("zaten projenin taranması ve mevcut kodun incelenmesiyle hazırlandı");
    expect(text).toContain("Yeniden baştan bir kod denetimi ya da durum raporu çıkarma");
    expect(text).toContain("Plan:");
    expect(text).toContain("1. Adım");
  });
});

describe("model choice per slot", () => {
  it("starts with the three Vyron combos and offers exactly the fixed options", () => {
    const state = model.defaultState();
    expect(state.models).toEqual({ assistant: "vyron-assistant", code: "vyron-code", research: "vyron-research", tools: "vyron-code" });
    expect((model as any).MODEL_OPTIONS.map((o: any) => o.id)).toEqual(["", "vyron-assistant", "vyron-code", "vyron-research"]);
    expect((model as any).MODEL_SLOTS.map((s: any) => s.id)).toEqual(["assistant", "code", "research", "tools"]);
  });

  it("keeps a valid saved choice and falls back to the default for anything else", () => {
    const raw = { ...model.defaultState(), models: { assistant: "", code: "gpt-4o", research: "vyron-code", extra: "x" } };
    expect(model.sanitizeState(JSON.parse(JSON.stringify(raw))).models).toEqual({ assistant: "", code: "vyron-code", research: "vyron-code", tools: "vyron-code" });
    const old = JSON.parse(JSON.stringify(model.defaultState()));
    delete old.models;
    expect(model.sanitizeState(old).models).toEqual(model.defaultState().models);
  });
});

describe("built-in managers survive older saves", () => {
  it("adds the Coder manager to a saved list that predates it, keeping custom managers", () => {
    const old = JSON.parse(JSON.stringify(model.defaultState()));
    old.managers = old.managers.filter((m: any) => m.id !== "coder");
    old.managers.push({ id: "m-ozel", name: "Özel", description: "x", tag: "Özel", custom: true, agent: "tester" });
    const loaded = model.sanitizeState(old);
    expect(loaded.managers.map((m: any) => m.name)).toEqual(["Genel", "CTO", "Vyron Helper", "Coder", "Multi-Model Planner", "Konsey", "Derin Araştırma", "Reviewer", "Özel"]);
    expect(loaded.managers.find((m: any) => m.id === "coder").agent).toBe("coder");
  });
});

describe("editing projects and tasks (pure model)", () => {
  const m = model as any;

  it("renames a project (not to an existing name) and a task", () => {
    const state = m.defaultState();
    expect(m.renameProject(state, "hangikargoo", "Kargo")).toBe(true);
    expect(state.projects.find((p: any) => p.id === "hangikargoo").name).toBe("Kargo");
    expect(m.renameProject(state, "hangikargoo", "  aetheris ")).toBe(false);
    expect(m.renameProject(state, "yok", "X")).toBe(false);
    expect(m.renameProject(state, "hangikargoo", "   ")).toBe(false);
    const task = state.tasks[0];
    expect(m.renameTask(state, task.id, "  Yeni ad ")).toBe(true);
    expect(task.title).toBe("Yeni ad");
    expect(m.renameTask(state, task.id, "")).toBe(false);
  });

  it("removes a project with its tasks and resets what pointed at it", () => {
    const state = m.defaultState();
    state.activeProjectId = "aetheris";
    const some = state.tasks.find((t: any) => t.projectId === "aetheris");
    state.activeTaskId = some.id;
    const removed = m.removeProject(state, "aetheris");
    expect(removed.length).toBeGreaterThan(3);
    expect(state.projects.map((p: any) => p.id)).toEqual(["new-project", "hangikargoo"]);
    expect(state.tasks.some((t: any) => t.projectId === "aetheris")).toBe(false);
    expect(state.activeProjectId).toBeNull();
    expect(state.activeTaskId).toBeNull();
    expect(m.removeProject(state, "aetheris")).toEqual([]);
  });

  it("removes and moves a single task", () => {
    const state = m.defaultState();
    const task = state.tasks.find((t: any) => t.projectId === "aetheris");
    expect(m.moveTask(state, task.id, "hangikargoo")).toBe(true);
    expect(task.projectId).toBe("hangikargoo");
    expect(m.moveTask(state, task.id, null)).toBe(true);
    expect(task.projectId).toBeNull();
    expect(m.moveTask(state, task.id, "yok")).toBe(false);
    state.activeTaskId = task.id;
    expect(m.removeTask(state, task.id)).toBe(true);
    expect(state.activeTaskId).toBeNull();
    expect(m.removeTask(state, task.id)).toBe(false);
  });

  it("reorders projects by step and by drag (before another, or to the end)", () => {
    const state = m.defaultState();
    const order = () => state.projects.map((p: any) => p.id);
    expect(m.moveProject(state, "new-project", -1)).toBe(false);
    expect(m.moveProject(state, "new-project", 1)).toBe(true);
    expect(order()).toEqual(["aetheris", "new-project", "hangikargoo"]);
    expect(m.moveProject(state, "hangikargoo", 1)).toBe(false);
    expect(m.moveProjectBefore(state, "hangikargoo", "aetheris")).toBe(true);
    expect(order()).toEqual(["hangikargoo", "aetheris", "new-project"]);
    expect(m.moveProjectBefore(state, "hangikargoo", null)).toBe(true);
    expect(order()).toEqual(["aetheris", "new-project", "hangikargoo"]);
    expect(m.moveProjectBefore(state, "aetheris", "aetheris")).toBe(false);
    expect(m.moveProjectBefore(state, "aetheris", "yok")).toBe(false);
    expect(order()).toEqual(["aetheris", "new-project", "hangikargoo"]);
  });

  it("remembers the Manager of a task, and forgets a Manager that no longer exists", () => {
    const state = m.defaultState();
    const task = m.createTask(state, null, "Bir iş", "coder");
    expect(task.managerId).toBe("coder");
    expect(m.tasksOfManager(state, "coder").map((t: any) => t.id)).toEqual([task.id]);
    const loaded = m.sanitizeState(JSON.parse(JSON.stringify(state)));
    expect(loaded.tasks.find((t: any) => t.id === task.id).managerId).toBe("coder");
    const stale = JSON.parse(JSON.stringify(state));
    stale.tasks.find((t: any) => t.id === task.id).managerId = "silinmis-manager";
    expect(m.sanitizeState(stale).tasks.find((t: any) => t.id === task.id).managerId).toBeNull();
    const custom = m.createManager(state, "Özel", "x");
    const owned = m.createTask(state, null, "Özel iş", custom.id);
    m.removeManager(state, custom.id);
    expect(owned.managerId).toBeNull();
    const old = JSON.parse(JSON.stringify(m.defaultState()));
    for (const t of old.tasks) delete t.managerId;
    expect(m.sanitizeState(old).tasks.every((t: any) => t.managerId === null)).toBe(true);
  });
});

describe("skills with instructions and starter chips (pure model)", () => {
  const m = model as any;

  it("built-in skills carry instructions and starters carry default skills", () => {
    for (const skill of m.SKILLS) {
      expect(skill.instructions.length, skill.id).toBeGreaterThan(20);
      expect(skill.custom).toBe(false);
    }
    const state = m.defaultState();
    expect(m.quickStartSkillIds(state, "data-analysis")).toEqual(["confirmed-data-analysis"]);
    expect(m.quickStartSkillIds(state, "build-app")).toEqual(["design-then-build", "frontend-design"]);
    expect(m.quickStartSkillIds(state, "make-video")).toEqual([]);
    expect(m.allQuickStarts(state)).toHaveLength(9);
  });

  it("creates and removes custom skills; names are unique across built-in and custom", () => {
    const state = m.defaultState();
    expect(m.createSkill(state, "  Kod İncele ", "Açıklama", "  Talimat  ")!.instructions).toBe("Talimat");
    expect(m.createSkill(state, "kod incele", "x", "y")).toBeNull();
    expect(m.createSkill(state, "create image", "x", "y")).toBeNull();
    expect(m.createSkill(state, "", "x", "y")).toBeNull();
    expect(m.createSkill(state, "Boş talimat", "x", "   ")).toBeNull();
    expect(m.createSkill(state, "Çok uzun", "x", "a".repeat(m.MAX_SKILL_INSTRUCTIONS + 1))).toBeNull();
    const skill = state.customSkills[0];
    state.selectedSkillIds = [skill.id];
    m.toggleQuickStartSkill(state, "make-video", skill.id);
    expect(m.quickStartSkillIds(state, "make-video")).toEqual([skill.id]);
    expect(m.removeSkill(state, skill.id)).toBe(true);
    expect(state.selectedSkillIds).toEqual([]);
    expect(m.quickStartSkillIds(state, "make-video")).toEqual([]);
    expect(m.removeSkill(state, "create-image")).toBe(false);
  });

  it("limits the number of custom skills and starters", () => {
    const state = m.defaultState();
    for (let i = 0; i < 40; i += 1) m.createSkill(state, "Yetenek " + String(i), "x", "y");
    expect(state.customSkills).toHaveLength(30);
    for (let i = 0; i < 40; i += 1) m.createQuickStart(state, "Başlangıç " + String(i), "metin");
    expect(state.customQuickStarts).toHaveLength(20);
  });

  it("starters: create, refuse duplicates, attach skills, remove", () => {
    const state = m.defaultState();
    const quick = m.createQuickStart(state, "Haftalık rapor", "Raporu hazırla");
    expect(quick.custom).toBe(true);
    expect(m.createQuickStart(state, "haftalık RAPOR", "x")).toBeNull();
    expect(m.createQuickStart(state, "Fikri keşfet", "x")).toBeNull();
    expect(m.createQuickStart(state, "Boş", "  ")).toBeNull();
    expect(m.toggleQuickStartSkill(state, quick.id, "create-image")).toBe(true);
    expect(m.toggleQuickStartSkill(state, quick.id, "yok")).toBe(false);
    expect(m.toggleQuickStartSkill(state, "yok", "create-image")).toBe(false);
    expect(m.quickStartSkillIds(state, quick.id)).toEqual(["create-image"]);
    expect(m.toggleQuickStartSkill(state, quick.id, "create-image")).toBe(true);
    expect(m.quickStartSkillIds(state, quick.id)).toEqual([]);
    expect(m.removeQuickStart(state, "build-app")).toBe(false);
    expect(m.removeQuickStart(state, quick.id)).toBe(true);
  });

  it("persistence: keeps valid custom items and drops hostile or stale ones", () => {
    const state = m.defaultState();
    const skill = m.createSkill(state, "Kalıcı", "d", "Talimat");
    const quick = m.createQuickStart(state, "Kalıcı başlangıç", "metin");
    m.toggleQuickStartSkill(state, quick.id, skill.id);
    const loaded = m.sanitizeState(JSON.parse(JSON.stringify(state)));
    expect(loaded.customSkills.map((s: any) => s.name)).toEqual(["Kalıcı"]);
    expect(loaded.customQuickStarts.map((q: any) => q.label)).toEqual(["Kalıcı başlangıç"]);
    expect(m.quickStartSkillIds(loaded, quick.id)).toEqual([skill.id]);
    const hostile = JSON.parse(JSON.stringify(state));
    hostile.customSkills.push({ id: "create-image", name: "Kopya", instructions: "x" }, { id: "s2", name: "", instructions: "x" }, { id: "s3", name: "İyi", instructions: "" }, 5, null);
    hostile.customQuickStarts.push({ id: "build-app", label: "Kopya", draft: "x" }, { id: "q2", label: "Boş", draft: "" });
    hostile.quickStartSkills["make-video"] = ["yok", "create-image", "create-image", 5];
    hostile.selectedSkillIds = ["yok", skill.id];
    const clean = m.sanitizeState(hostile);
    expect(clean.customSkills.map((s: any) => s.name)).toEqual(["Kalıcı"]);
    expect(clean.customQuickStarts.map((q: any) => q.label)).toEqual(["Kalıcı başlangıç"]);
    expect(m.quickStartSkillIds(clean, "make-video")).toEqual(["create-image"]);
    expect(clean.selectedSkillIds).toEqual([skill.id]);
  });

  it("composePrompt adds the instruction lines after the skill names", () => {
    const text = m.composePrompt({
      draft: "Görev",
      workMode: "local",
      planMode: "standard",
      terminalMode: "off",
      managerName: null,
      skillNames: ["A"],
      skillInstructions: ["Yetenek talimatı (A): şunu yap"],
      connectorNames: [],
    });
    expect(text).toBe(["Kullanılacak yetenekler: A.", "Yetenek talimatı (A): şunu yap", "", "Görev"].join(String.fromCharCode(10)));
  });
});

describe("CTO Manager text helpers", () => {
  const m = model as any;
  it("extractBrief returns the text between the markers, tolerates a missing closing marker and rejects empty briefs", () => {
    expect(m.extractBrief("a [[PROJE-ÖZETİ]] Amaç X [[/PROJE-ÖZETİ]] b")).toBe("Amaç X");
    expect(m.extractBrief("a [[PROJE-ÖZETİ]] Amaç Y")).toBe("Amaç Y");
    expect(m.extractBrief("[[PROJE-ÖZETİ]]   [[/PROJE-ÖZETİ]]")).toBeNull();
    expect(m.extractBrief("işaret yok")).toBeNull();
  });
  it("the Konsey task and the evaluation stay within the draft limit and carry the content", () => {
    const long = "x".repeat(m.MAX_DRAFT_LENGTH + 500);
    expect(m.composeCouncilTask(long).length).toBeLessThanOrEqual(m.MAX_DRAFT_LENGTH);
    expect(m.composeEvaluation(long).length).toBeLessThanOrEqual(m.MAX_DRAFT_LENGTH);
    expect(m.composeCouncilTask("Hedef")).toContain("Hedef");
    expect(m.isEvaluationPrompt(m.composeEvaluation("karar"))).toBe(true);
    expect(m.isEvaluationPrompt("karar")).toBe(false);
  });
  it("composePrompt adds the CTO rules only for the CTO and forbids self-approval", () => {
    const base = { draft: "Merhaba", workMode: "local", planMode: "standard", terminalMode: "off", skillNames: [], skillInstructions: [], connectorNames: [] };
    const cto = m.composePrompt({ ...base, managerName: "CTO" });
    expect(cto).toContain("Rol: CTO.");
    expect(cto).toContain("onayı olmadan");
    expect(m.composePrompt({ ...base, managerName: "Genel" })).not.toContain("CTO");
  });
});

describe("CTO progress stages", () => {
  const m = model as any;
  const t = (over: any) => ({ prompt: "p", agent: null, labels: ["SubAgent: CTO"], status: "done", text: "x", ...over });
  const states = (turns: any[]) => (m.ctoStages(turns) as any[]).map((s) => s.id + ":" + s.state);
  it("is null without any CTO turn", () => {
    expect(m.ctoStages([])).toBeNull();
    expect(m.ctoStages([t({ labels: ["SubAgent: Genel"] })])).toBeNull();
  });
  it("walks brief -> Konsey -> evaluation -> approval -> Coder -> Reviewer", () => {
    const brief = t({ text: "[[PROJE-ÖZETİ]]Hedef[[/PROJE-ÖZETİ]]" });
    expect(states([t({ text: "soru?" })])[0]).toBe("brief:waiting");
    expect(states([t({ status: "running", text: null })])[0]).toBe("brief:running");
    expect(states([brief])).toEqual(["brief:done", "council:pending", "evaluation:pending", "approval:pending", "coder:pending", "review:pending", "report:pending"]);
    const council = t({ agent: "council", labels: ["SubAgent: Konsey"], status: "running", text: null });
    expect(states([brief, council])[1]).toBe("council:running");
    const doneCouncil = { ...council, status: "done", text: "karar" };
    const evalTurn = t({ prompt: m.composeEvaluation("karar") });
    expect(states([brief, doneCouncil, evalTurn])).toEqual(["brief:done", "council:done", "evaluation:done", "approval:waiting", "coder:pending", "review:pending", "report:pending"]);
    const coder = t({ labels: ["SubAgent: Coder"], status: "running", text: null });
    expect(states([brief, doneCouncil, evalTurn, coder])).toEqual(["brief:done", "council:done", "evaluation:done", "approval:done", "coder:running", "review:pending", "report:pending"]);
    const review = t({ labels: ["SubAgent: Reviewer"] });
    expect(states([brief, doneCouncil, evalTurn, { ...coder, status: "done", text: "bitti" }, review]).slice(4)).toEqual(["coder:done", "review:done", "report:pending"]);
  });
  it("a failed Konsey shows as an error and nothing after it moves", () => {
    const brief = t({ text: "[[PROJE-ÖZETİ]]Hedef[[/PROJE-ÖZETİ]]" });
    const council = t({ agent: "council", labels: ["SubAgent: Konsey"], status: "error", text: null });
    expect(states([brief, council])).toEqual(["brief:done", "council:error", "evaluation:pending", "approval:pending", "coder:pending", "review:pending", "report:pending"]);
  });
});

describe("CTO communication protocol", () => {
  const m = model as any;
  const base = { draft: "Merhaba", workMode: "local", planMode: "standard", terminalMode: "off", skillNames: [], skillInstructions: [], connectorNames: [] };
  it("the CTO rules ask for a status report with one clear recommendation and numbered choices, and for the user's word before anything consequential", () => {
    const rules = m.composePrompt({ ...base, managerName: "CTO" });
    for (const part of ["'Durum'", "'Yapılanlar'", "'Önerim'", "'Seçenekler'", "'Senden beklediğim'", "devam edelim mi?' diye sorma", "commit, push, kurulum", "dur, raporla ve yön iste"]) {
      expect(rules, part).toContain(part);
    }
    expect(m.composePrompt({ ...base, managerName: "Genel" })).not.toContain("Seçenekler");
  });
  it("extractOptions reads the numbered list under the Seçenekler heading (any markdown style), at most 5, and stops at the next section", () => {
    const text = "Durum: iyi.\n\n**Seçenekler:**\n1. **Git deposu kur** (önerim)\n2) Önce P1 bağımlılıklarını seç\n3. Bekle\n\nSenden beklediğim: bir numara.\n4. bu madde listenin dışında";
    expect(m.extractOptions(text)).toEqual(["Git deposu kur (önerim)", "Önce P1 bağımlılıklarını seç", "Bekle"]);
    expect(m.extractOptions("## Seçenekler\n1. a\n2. b\n3. c\n4. d\n5. e\n6. f")).toHaveLength(5);
    expect(m.extractOptions("Seçenekler yok burada")).toEqual([]);
    expect(m.extractOptions("Seçenekler\nbir şey yaz")).toEqual([]);
    expect(m.extractOptions("1. a\n2. b")).toEqual([]);
  });
});

describe("displayText", () => {
  it("turns the CTO's machine markers into plain headings and leaves every other text untouched", () => {
    const m = model as any;
    expect(m.displayText("a [[PROJE-ÖZETİ]]Hedef[[/PROJE-ÖZETİ]] b")).toBe("a — Proje özeti —Hedef— Özet sonu — b");
    expect(m.displayText("[[GÖREV-LİSTESİ]]\n1. x\n[[/GÖREV-LİSTESİ]]")).toBe("— Görev listesi —\n1. x\n— Liste sonu —");
    expect(m.displayText("Düz metin [köşeli] ve ** işaretler")).toBe("Düz metin [köşeli] ve ** işaretler");
  });
});

describe("a task counts as finished only for the right attempt", () => {
  const m = model as any;
  const t = (over: any) => ({ prompt: "p", agent: null, labels: ["SubAgent: CTO"], status: "done", text: "x", ...over });
  const list = t({ text: "[[GÖREV-LİSTESİ]]\n1. 0001_source.sql yaz\n2. migration runner yaz\n[[/GÖREV-LİSTESİ]]" });
  const coder = (prompt: string, over: any = {}) => t({ prompt, labels: ["SubAgent: Coder"], ...over });
  const states = (turns: any[]) => m.ctoTaskPlan(turns).tasks.map((x: any) => x.state);
  it("isTaskAttempt needs the same number, the same total and the same title", () => {
    expect(m.isTaskAttempt("[Görev 1/2] a_b.sql\n\nSen Coder'sın", 1, 2, "a_b.sql")).toBe(true);
    expect(m.isTaskAttempt("[Görev 1/2] ab.sql", 1, 2, "a_b.sql")).toBe(false);
    expect(m.isTaskAttempt("[Görev 1/3] a_b.sql", 1, 2, "a_b.sql")).toBe(false);
    expect(m.isTaskAttempt("[Görev 2/2] a_b.sql", 1, 2, "a_b.sql")).toBe(false);
  });
  it("an earlier run with other (e.g. corrupted) titles does not make the task look finished", () => {
    const old = coder("[Görev 1/2] 0001source.sql yaz");
    expect(states([list, old])).toEqual(["pending", "pending"]);
    const right = coder("[Görev 1/2] 0001_source.sql yaz");
    expect(states([list, old, right])).toEqual(["done", "pending"]);
  });
  it("a task the Coder left half done is retried, not finished", () => {
    const half = coder("[Görev 1/2] 0001_source.sql yaz", { text: "Adım sınırına ulaşıldı; iş yarım kaldı. Yapılanlar aşağıda." });
    expect(states([list, half])).toEqual(["error", "pending"]);
    const retry = coder("[Görev 1/2] 0001_source.sql yaz", { text: "Tamamlandı." });
    expect(states([list, half, retry])).toEqual(["done", "pending"]);
  });
});

describe("names with underscores survive", () => {
  const m = model as any;
  it("task titles and choices keep underscores, dots and slashes (only **bold** and backticks are stripped)", () => {
    const list = "[[GÖREV-LİSTESİ]]\n1. 0002_raw_snapshot.sql: evidence_class, `source_id` alanları\n2. **Migration runner** schema_migrations tablosu\n3. raw/{source}/{yyyy}/{request_id}.json.gz anahtarı\n[[/GÖREV-LİSTESİ]]";
    expect(m.extractTasks(list)).toEqual([
      "0002_raw_snapshot.sql: evidence_class, source_id alanları",
      "Migration runner schema_migrations tablosu",
      "raw/{source}/{yyyy}/{request_id}.json.gz anahtarı",
    ]);
    expect(m.extractOptions("Seçenekler:\n1. **Önerim**: docker_compose up çalıştır\n2. `forbidden_terms.sh` bekçisini çalıştır")).toEqual([
      "Önerim: docker_compose up çalıştır",
      "forbidden_terms.sh bekçisini çalıştır",
    ]);
  });
});

describe("CTO phase driver (model)", () => {
  const m = model as any;
  const t = (over: any) => ({ prompt: "p", agent: null, labels: ["SubAgent: CTO"], status: "done", text: "x", ...over });
  const LIST = "[[GÖREV-LİSTESİ]]\n1. A\n2. B\n[[/GÖREV-LİSTESİ]]";
  it("the phase report prompt carries the results, the review and the next-phase instruction, within the draft limit", () => {
    const p = m.composePhaseReport(["A", "B"], ["A bitti", null], "Temiz");
    expect(m.isPhaseReportPrompt(p)).toBe(true);
    expect(m.chainPromptTitle(p)).toBe("CTO: faz raporu ve sıradaki faz");
    for (const part of ["1. A", "Sonuç: A bitti", "Sonuç: (sonuç yok)", "Reviewer'ın incelemesi:\nTemiz", "SIRADAKİ FAZ", "Sıradaki faza geç", "[[GÖREV-LİSTESİ]]"]) expect(p, part).toContain(part);
    const huge = m.composePhaseReport(Array(8).fill("x".repeat(300)), Array(8).fill("y".repeat(5000)), "z".repeat(9000));
    expect(huge.length).toBeLessThanOrEqual(m.MAX_DRAFT_LENGTH);
  });
  it("any finished CTO answer with a task list is the plan (the next phase's list too), and the report state follows the report turn", () => {
    const first = t({ prompt: m.composeTaskListRequest("karar"), text: LIST });
    const done = [1, 2].map((k) => t({ prompt: "[Görev " + k + "/2] " + ["A", "B"][k - 1], labels: ["SubAgent: Coder"] }));
    const review = t({ labels: ["SubAgent: Reviewer"] });
    const report = t({ prompt: m.composePhaseReport(["A", "B"], ["a", "b"], "ok"), text: "Seçenekler:\n1. Sıradaki faza geç: P2" });
    const planned = m.ctoTaskPlan([first, ...done, review, report]);
    expect(planned.report).toBe("done");
    expect(planned.review).toBe("done");
    // The CTO's next-phase answer has no special prompt: it is still recognised, and the old results do not count for it.
    const next = t({ prompt: "Seçenek 1: Sıradaki faza geç: P2", text: "[[GÖREV-LİSTESİ]]\n1. X\n2. Y\n[[/GÖREV-LİSTESİ]]" });
    const second = m.ctoTaskPlan([first, ...done, review, report, next]);
    expect(second.tasks.map((x: any) => x.title + ":" + x.state)).toEqual(["X:pending", "Y:pending"]);
    expect(second.review).toBe("none");
    expect(second.report).toBe("none");
  });
  it("a plan given directly by the CTO (no brief, no Konsey) drives the strip: skipped stages are 'done', the Coder, the Reviewer and the report follow the plan", () => {
    const states = (turns: any[]) => (m.ctoStages(turns) as any[]).map((s) => s.id + ":" + s.state);
    const plan = t({ prompt: "P1 listesi ver", text: "[[GÖREV-LİSTESİ]]\n1. A\n2. B\n[[/GÖREV-LİSTESİ]]" });
    expect(states([plan])).toEqual(["brief:done", "council:done", "evaluation:done", "approval:waiting", "coder:waiting", "review:pending", "report:pending"]);
    const first = t({ prompt: "[Görev 1/2] A", labels: ["SubAgent: Coder"], status: "running", text: null });
    expect(states([plan, first])).toEqual(["brief:done", "council:done", "evaluation:done", "approval:done", "coder:running", "review:pending", "report:pending"]);
    const all = [1, 2].map((k) => t({ prompt: "[Görev " + k + "/2] " + ["A", "B"][k - 1], labels: ["SubAgent: Coder"] }));
    const review = t({ labels: ["SubAgent: Reviewer"] });
    const report = t({ prompt: m.composePhaseReport(["A", "B"], ["a", "b"], "ok"), text: "Seçenekler:\n1. Sıradaki faza geç: P2" });
    expect(states([plan, ...all, review, report])).toEqual(["brief:done", "council:done", "evaluation:done", "approval:done", "coder:done", "review:done", "report:waiting"]);
  });
  it("the CTO rules make the CTO propose the next phase itself and answer an approved phase with its task list", () => {
    const rules = m.composePrompt({ draft: "x", workMode: "local", planMode: "standard", terminalMode: "off", managerName: "CTO", skillNames: [], skillInstructions: [], connectorNames: [] });
    expect(rules).toContain("bekleme, yol haritasındaki sıradaki fazı kendin öner");
    expect(rules).toContain("[[GÖREV-LİSTESİ]]");
  });
});

describe("chain prompt titles", () => {
  const m = model as any;
  it("gives every CTO chain prompt a short title and leaves user-typed prompts alone", () => {
    expect(m.chainPromptTitle(m.composeCouncilTask("Hedef"))).toBe("Konsey: proje özeti için karar veriyor");
    expect(m.chainPromptTitle(m.composeEvaluation("karar"))).toBe("CTO: Konsey kararını değerlendiriyor");
    expect(m.chainPromptTitle(m.composeTaskListRequest("karar"))).toBe("CTO: onaylanan kararı görev listesine bölüyor");
    expect(m.chainPromptTitle(m.composeTaskPrompt(2, ["A", "B"], "karar"))).toBe("[Görev 2/2] B");
    expect(m.chainPromptTitle(m.composeReviewPrompt(["A"], ["bitti"]))).toBe("Reviewer: Coder'ın sonuçlarını inceliyor");
    expect(m.chainPromptTitle("Kargo takip sitesi yapalım")).toBeNull();
    expect(m.chainPromptTitle("Aşağıdaki hatayı düzelt")).toBeNull();
  });
});

describe("CTO task plan", () => {
  const m = model as any;
  const t = (over: any) => ({ prompt: "p", agent: null, labels: ["SubAgent: CTO"], status: "done", text: "x", ...over });
  const LIST = "Önce:\n[[GÖREV-LİSTESİ]]\n1. **Veritabanı** şemasını kur\n2) API yaz\nnot bir görev değil\n3. Arayüzü yap\n[[/GÖREV-LİSTESİ]]\nSıra böyle.";
  it("extractTasks reads the numbered list between the markers, strips emphasis, caps the count", () => {
    expect(m.extractTasks(LIST)).toEqual(["Veritabanı şemasını kur", "API yaz", "Arayüzü yap"]);
    expect(m.extractTasks("liste yok")).toEqual([]);
    const many = "[[GÖREV-LİSTESİ]]\n" + Array.from({ length: 20 }, (_, i) => String(i + 1) + ". iş " + String(i)).join("\n") + "\n[[/GÖREV-LİSTESİ]]";
    expect(m.extractTasks(many)).toHaveLength(8);
  });
  it("composeTaskPrompt names the task, lists all, carries the decision and stays within the draft limit", () => {
    const text = m.composeTaskPrompt(2, ["A", "B", "C"], "KARAR");
    expect(text.startsWith("[Görev 2/3] B")).toBe(true);
    expect(text).toContain("YALNIZCA bu görevini");
    expect(text).toContain("3. C");
    expect(text).toContain("KARAR");
    expect(m.composeTaskPrompt(1, ["A"], "x".repeat(m.MAX_DRAFT_LENGTH * 2)).length).toBeLessThanOrEqual(m.MAX_DRAFT_LENGTH);
  });
  it("ctoTaskPlan follows each task by its prompt, and the stages show the Coder progress", () => {
    const brief = t({ text: "[[PROJE-ÖZETİ]]H[[/PROJE-ÖZETİ]]" });
    const council = t({ agent: "council", labels: ["SubAgent: Konsey"], text: "karar" });
    const evalTurn = t({ prompt: m.composeEvaluation("karar") });
    const listTurn = t({ prompt: m.composeTaskListRequest("karar"), text: LIST });
    const base = [brief, council, evalTurn, listTurn];
    expect(m.ctoTaskPlan([brief])).toBeNull();
    const plan0 = m.ctoTaskPlan(base);
    expect(plan0.tasks.map((x: any) => x.state)).toEqual(["pending", "pending", "pending"]);
    expect((m.ctoStages(base) as any[]).find((s) => s.id === "coder").detail).toBe("Görevler hazır, başlatmanı bekliyor");
    const first = t({ prompt: "[Görev 1/3] Veritabanı şemasını kur", labels: ["SubAgent: Coder"], status: "running", text: null });
    expect(m.ctoTaskPlan([...base, first]).tasks.map((x: any) => x.state)).toEqual(["running", "pending", "pending"]);
    expect((m.ctoStages([...base, first]) as any[]).find((s) => s.id === "coder").detail).toBe("Görev 1/3 çalışıyor");
    const firstDone = { ...first, status: "done", text: "yapıldı" };
    expect((m.ctoStages([...base, firstDone]) as any[]).find((s) => s.id === "coder").detail).toBe("1/3 bitti, sıradaki seni bekliyor");
    const all = [1, 2, 3].map((k) => t({ prompt: "[Görev " + k + "/3] " + ["Veritabanı şemasını kur", "API yaz", "Arayüzü yap"][k - 1], labels: ["SubAgent: Coder"] }));
    const plan = m.ctoTaskPlan([...base, ...all]);
    expect(plan.tasks.every((x: any) => x.state === "done")).toBe(true);
    expect(plan.review).toBe("none");
    expect(m.ctoTaskPlan([...base, ...all, t({ labels: ["SubAgent: Reviewer"] })]).review).toBe("done");
    const failed = t({ prompt: "[Görev 2/3] API yaz", labels: ["SubAgent: Coder"], status: "error", text: null });
    expect(m.ctoTaskPlan([...base, failed]).tasks[1].state).toBe("error");
  });
});
