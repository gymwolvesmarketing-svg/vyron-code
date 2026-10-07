/**
 * Vyron Code workspace product model - VYRON_CODE_WORKSPACE_UI_UX_IMPLEMENTATION.
 *
 * Pure, DOM-free logic for the desktop workspace: local product data (projects, tasks, managers,
 * skills, connectors, websites, quick starts), the persisted-state schema with validation and
 * fallback, and the small pure helpers the renderer uses (search filtering, draft validation,
 * outgoing-prompt composition, task titles).
 *
 * This is a classic browser script loaded before renderer.js (it declares the global `VyronModel`
 * object plus the `Ws*` types) - it must NOT contain a top-level `import`/`export`. It touches no Electron, Node,
 * network or IPC API. Persistence goes through an injected `Storage`-like object and only ever
 * stores product metadata; a task's text and its answer are deliberately NOT persisted (they live
 * in renderer memory for the current session only, matching the app's ephemeral-task guarantee).
 */
type WsNavView = "new-task" | "skills" | "connectors" | "sites" | "settings" | "manager";

type WsSidebarTab = "projects" | "managers";

type WsPlanMode = "standard" | "plan" | "deep";

type WsTerminalMode = "off" | "suggest";
/** A model combo of the local router (OmniRoute), or "" for the Hermes default. Mirrors electron/modelRouting.ts. */
type WsModelId = "" | "vyron-assistant" | "vyron-code" | "vyron-research";
type WsModelSlot = "assistant" | "code" | "research" | "tools";
type WsModelChoice = Record<WsModelSlot, WsModelId>;

type WsWorkMode = "local" | "brief";

type WsConnectorStatus = "disconnected" | "pending" | "connected";

type WsDraftProblem = "ok" | "empty" | "too_long" | "invalid";

interface WsProject {
  id: string;
  name: string;
  expanded: boolean;
  showAll: boolean;
}

interface WsTask {
  id: string;
  projectId: string | null;
  title: string;
  createdAt: number;
  /** The Manager that ran (or was chosen for) this task; null = a direct task. */
  managerId: string | null;
}

interface WsManager {
  id: string;
  name: string;
  description: string;
  tag: string;
  custom: boolean;
  /** Ruflo role that runs this Manager's tasks; null = the task goes straight to the local AI. */
  agent: string | null;
}

interface WsSkill {
  id: string;
  name: string;
  category: string;
  tag: string;
  description: string;
  icon: string;
  /** What the model is told to do when the skill is selected. */
  instructions: string;
  custom: boolean;
}

interface WsConnector {
  id: string;
  name: string;
  description: string;
  status: WsConnectorStatus;
  custom: boolean;
  icon: string;
}

interface WsSite {
  id: string;
  name: string;
  address: string;
}

interface WsQuickStart {
  id: string;
  label: string;
  icon: string;
  draft: string;
  custom?: boolean;
  /** A built-in start that also selects this Manager when applied (the deep-research button). */
  managerId?: string;
}

interface WsWorkspaceState {
  version: number;
  sidebarTab: WsSidebarTab;
  sidebarCollapsed: boolean;
  view: WsNavView;
  projects: WsProject[];
  tasks: WsTask[];
  managers: WsManager[];
  connectors: WsConnector[];
  sites: WsSite[];
  activeProjectId: string | null;
  activeTaskId: string | null;
  selectedManagerId: string | null;
  selectedSkillIds: string[];
  selectedConnectorIds: string[];
  planMode: WsPlanMode;
  terminalMode: WsTerminalMode;
  workMode: WsWorkMode;
  models: WsModelChoice;
  /** Skills the user wrote (name, description, instructions). */
  customSkills: WsSkill[];
  /** Starter chips the user added under the built-in ones. */
  customQuickStarts: WsQuickStart[];
  /** Skills attached to each starter chip (built-in or custom), by chip id. */
  quickStartSkills: Record<string, string[]>;
}

interface WsStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface WsPromptInput {
  draft: string;
  workMode: WsWorkMode;
  planMode: WsPlanMode;
  terminalMode: WsTerminalMode;
  managerName: string | null;
  skillNames: string[];
  /** Instructions of the selected skills that have any (same order as the names). */
  skillInstructions?: string[];
  connectorNames: string[];
}

type WsResponseBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "code"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] };

const VyronModel = (() => {
  const STORAGE_KEY = "vyron.workspace.v1";
  const STATE_VERSION = 1;

  const MODEL_SLOTS: ReadonlyArray<{ id: WsModelSlot; label: string; description: string }> = [
    { id: "assistant", label: "Asistan", description: "Genel yanıtlar, planlama ve görev yönetimi" },
    { id: "code", label: "Kod", description: "Kod yazan, inceleyen ve test eden Managers" },
    { id: "research", label: "Araştırma", description: "Araştırmacı Managers" },
    { id: "tools", label: "Araçlı görevler", description: "Çalışma klasöründe dosya okuyup yazan görevler (araç protokolüne uyan bir grup seç)" },
  ];
  const MODEL_OPTIONS: ReadonlyArray<{ id: WsModelId; label: string }> = [
    { id: "", label: "Varsayılan (Hermes)" },
    { id: "vyron-assistant", label: "vyron-assistant (ChatGPT Web → Claude Web → Nemotron)" },
    { id: "vyron-code", label: "vyron-code (Claude Web → Nemotron → ChatGPT Web)" },
    { id: "vyron-research", label: "vyron-research (Perplexity → ChatGPT Web)" },
  ];
  /** Skills a built-in starter chip brings along by default (the user can change them). */
  function defaultQuickStartSkills(): Record<string, string[]> {
    return {
      "explore-idea": ["find-skills"],
      "build-app": ["design-then-build", "frontend-design"],
      "design-first": ["design-then-build", "frontend-design"],
      "data-analysis": ["confirmed-data-analysis"],
      "doc-analysis": ["confirmed-data-analysis"],
      "make-image": ["create-image"],
    };
  }

  const MAX_CUSTOM_SKILLS = 30;
  const MAX_CUSTOM_QUICK_STARTS = 20;
  const MAX_SKILL_INSTRUCTIONS = 2000;

  function allSkills(state: WsWorkspaceState): WsSkill[] {
    return SKILLS.concat(state.customSkills);
  }

  function allQuickStarts(state: WsWorkspaceState): WsQuickStart[] {
    return QUICK_STARTS.concat(state.customQuickStarts);
  }

  function quickStartSkillIds(state: WsWorkspaceState, quickId: string): string[] {
    const ids = state.quickStartSkills[quickId] ?? [];
    return ids.filter((id) => allSkills(state).some((s) => s.id === id));
  }

  function createSkill(state: WsWorkspaceState, rawName: string, rawDescription: string, rawInstructions: string): WsSkill | null {
    const name = cleanName(rawName, 40);
    const instructions = rawInstructions.trim();
    if (name === null || instructions.length === 0 || instructions.length > MAX_SKILL_INSTRUCTIONS) return null;
    if (state.customSkills.length >= MAX_CUSTOM_SKILLS) return null;
    if (allSkills(state).some((s) => normalizeQuery(s.name) === normalizeQuery(name))) return null;
    const skill: WsSkill = {
      id: newId("skill"),
      name,
      category: "Özel",
      tag: "Özel",
      description: cleanText(rawDescription, 140) ?? "Özel yetenek.",
      icon: "sparkles",
      instructions,
      custom: true,
    };
    state.customSkills.push(skill);
    return skill;
  }

  function removeSkill(state: WsWorkspaceState, id: string): boolean {
    if (!state.customSkills.some((s) => s.id === id)) return false;
    state.customSkills = state.customSkills.filter((s) => s.id !== id);
    state.selectedSkillIds = state.selectedSkillIds.filter((x) => x !== id);
    for (const key of Object.keys(state.quickStartSkills)) state.quickStartSkills[key] = (state.quickStartSkills[key] ?? []).filter((x) => x !== id);
    return true;
  }

  function createQuickStart(state: WsWorkspaceState, rawLabel: string, rawDraft: string): WsQuickStart | null {
    const label = cleanName(rawLabel, 30);
    const draft = rawDraft.trim();
    if (label === null || draft.length === 0 || draft.length > MAX_DRAFT_LENGTH) return null;
    if (state.customQuickStarts.length >= MAX_CUSTOM_QUICK_STARTS) return null;
    if (allQuickStarts(state).some((q) => normalizeQuery(q.label) === normalizeQuery(label))) return null;
    const quick: WsQuickStart = { id: newId("quick"), label, icon: "message", draft, custom: true };
    state.customQuickStarts.push(quick);
    return quick;
  }

  function removeQuickStart(state: WsWorkspaceState, id: string): boolean {
    if (!state.customQuickStarts.some((q) => q.id === id)) return false;
    state.customQuickStarts = state.customQuickStarts.filter((q) => q.id !== id);
    delete state.quickStartSkills[id];
    return true;
  }

  /** Attaches a skill to a starter chip, or detaches it when it is already attached. */
  function toggleQuickStartSkill(state: WsWorkspaceState, quickId: string, skillId: string): boolean {
    if (!allQuickStarts(state).some((q) => q.id === quickId) || !allSkills(state).some((s) => s.id === skillId)) return false;
    const current = state.quickStartSkills[quickId] ?? [];
    state.quickStartSkills[quickId] = current.indexOf(skillId) >= 0 ? current.filter((x) => x !== skillId) : current.concat(skillId);
    return true;
  }

  function sanitizeCustomSkills(raw: unknown): WsSkill[] {
    const out: WsSkill[] = [];
    if (!Array.isArray(raw)) return out;
    for (const item of raw) {
      if (out.length >= MAX_CUSTOM_SKILLS || !isRecord(item)) continue;
      const id = cleanText(item.id, 80);
      const name = cleanName(typeof item.name === "string" ? item.name : "", 40);
      const instructions = typeof item.instructions === "string" ? item.instructions.trim() : "";
      if (!id || name === null || instructions.length === 0 || instructions.length > MAX_SKILL_INSTRUCTIONS) continue;
      if (SKILLS.some((s) => s.id === id) || out.some((s) => s.id === id)) continue;
      out.push({ id, name, category: "Özel", tag: "Özel", description: cleanText(item.description, 140) ?? "Özel yetenek.", icon: "sparkles", instructions, custom: true });
    }
    return out;
  }

  function sanitizeCustomQuickStarts(raw: unknown): WsQuickStart[] {
    const out: WsQuickStart[] = [];
    if (!Array.isArray(raw)) return out;
    for (const item of raw) {
      if (out.length >= MAX_CUSTOM_QUICK_STARTS || !isRecord(item)) continue;
      const id = cleanText(item.id, 80);
      const label = cleanName(typeof item.label === "string" ? item.label : "", 30);
      const draft = typeof item.draft === "string" ? item.draft.trim() : "";
      if (!id || label === null || draft.length === 0 || draft.length > MAX_DRAFT_LENGTH) continue;
      if (QUICK_STARTS.some((q) => q.id === id) || out.some((q) => q.id === id)) continue;
      out.push({ id, label, icon: "message", draft, custom: true });
    }
    return out;
  }

  function sanitizeQuickStartSkills(raw: unknown, skills: WsSkill[], quickIds: string[]): Record<string, string[]> {
    const out = defaultQuickStartSkills();
    if (!isRecord(raw)) return out;
    for (const quickId of quickIds) {
      const list = raw[quickId];
      if (!Array.isArray(list)) continue;
      out[quickId] = list.filter((id, index): id is string => typeof id === "string" && skills.some((s) => s.id === id) && list.indexOf(id) === index).slice(0, 12);
    }
    return out;
  }

  function defaultModels(): WsModelChoice {
    return { assistant: "vyron-assistant", code: "vyron-code", research: "vyron-research", tools: "vyron-code" };
  }
  function sanitizeModels(raw: unknown): WsModelChoice {
    const out = defaultModels();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
    for (const slot of MODEL_SLOTS) {
      const value = (raw as Record<string, unknown>)[slot.id];
      const match = MODEL_OPTIONS.find((option) => option.id === value);
      if (match) out[slot.id] = match.id;
    }
    return out;
  }
  const MAX_DRAFT_LENGTH = 100000;
  const MAX_TASKS = 300;
  const COLLAPSED_TASK_COUNT = 4;



  /** WsTask metadata only. The prompt and answer are never part of this record. */








  // ------------------------------------------------------------------------------------------
  // Product content (Vyron Code's own seeds; every item is editable/removable where it makes sense)
  // ------------------------------------------------------------------------------------------

  const SKILLS: readonly WsSkill[] = [
    { id: "confirmed-data-analysis", name: "Confirmed Data Analysis", category: "Kullanıcı", tag: "Analiz", description: "Verileri doğrulayarak analiz eder ve bulguları özetler.", icon: "chart", instructions: "Veriyi analiz etmeden önce eksik ve aykırı değerleri ile varsayımları doğrula; bulguları sayılarla destekle, belirsiz olanı açıkça belirt.", custom: false },
    { id: "create-image", name: "Create Image", category: "Kullanıcı", tag: "Görsel", description: "Görsel fikirleri ve görsel üretim istemleri hazırlar.", icon: "image", instructions: "Görsel istemi yaz: konu, kompozisyon, stil, ışık, renk paleti ve kaçınılacaklar; kısa ve net tut.", custom: false },
    { id: "design-then-build", name: "Design Then Build", category: "Kullanıcı", tag: "Tasarım", description: "Önce tasarımı çıkarır, sonra uygulamayı adım adım kurar.", icon: "palette", instructions: "Önce ekranları, akışı ve bileşenleri tasarla ve özetle; tasarım netleşince adım adım uygula.", custom: false },
    { id: "find-skills", name: "Find Skills", category: "Kullanıcı", tag: "Keşif", description: "Göreve uygun yetenekleri bulur ve önerir.", icon: "search", instructions: "Görev için hangi yeteneklerin işe yarayacağını belirle ve her biri için nedenini bir cümleyle yaz.", custom: false },
    { id: "frontend-design", name: "Frontend Design", category: "Kullanıcı", tag: "Arayüz", description: "Arayüz yapısını, bileşenleri ve stil kararlarını planlar.", icon: "code", instructions: "Arayüzü bileşenlere ayır; erişilebilirlik, duyarlılık ve tutarlı stil kararlarını gerekçeleriyle yaz.", custom: false },
    { id: "skill-creator", name: "Skill Creator", category: "Kullanıcı", tag: "Yetenek", description: "Yeni bir yeteneğin tanımını ve adımlarını yazar.", icon: "sparkles", instructions: "Yeni bir yetenek tanımla: ad, ne zaman kullanılacağı, adımlar ve beklenen çıktı.", custom: false },
  ];

  const QUICK_STARTS: readonly WsQuickStart[] = [
    { id: "explore-idea", label: "Fikri keşfet", icon: "message", draft: "Şu fikri birlikte keşfedelim: [fikrini yaz]. Sorunu, hedef kitleyi ve denenebilecek ilk adımları çıkar." },
    { id: "build-app", label: "Uygulama oluştur", icon: "code", draft: "Şu uygulamayı oluşturmak istiyorum: [uygulama fikrini yaz]. Gereksinimleri, mimariyi ve adım adım bir uygulama planını hazırla." },
    { id: "design-first", label: "Önce tasarla", icon: "palette", draft: "[Ne tasarlanacağını yaz] için önce bir tasarım çıkar: ekranlar, akış ve arayüz kararları. Kodlamadan önce tasarımı netleştir." },
    { id: "make-deck", label: "Sunum oluştur", icon: "presentation", draft: "[Konu] hakkında bir sunum hazırla: slayt başlıkları, her slaytın ana mesajı ve konuşmacı notları." },
    { id: "data-analysis", label: "Veri analizi", icon: "chart", draft: "Şu veriyi analiz et: [veriyi veya soruyu yaz]. Öne çıkan bulguları, riskleri ve önerileri özetle." },
    { id: "doc-analysis", label: "Doküman analizi", icon: "document", draft: "Şu dokümanı analiz et: [metni yapıştır]. Ana noktaları, çelişkileri ve yapılacakları çıkar." },
    { id: "deep-research", label: "Derin araştırma", icon: "research", draft: "[Araştırılacak konuyu ve beklediğin çıktıyı yaz]", managerId: "derin-arastirma" },
    { id: "make-image", label: "Görsel oluştur", icon: "image", draft: "[Görselin konusu] için görsel üretim istemi yaz: kompozisyon, stil, ışık ve renk paleti." },
    { id: "make-video", label: "Video oluştur", icon: "video", draft: "[Videonun konusu] için video senaryosu hazırla: sahneler, süre, anlatım metni ve çekim önerileri." },
  ];

  const PLAN_MODES: ReadonlyArray<{ id: WsPlanMode; label: string; description: string; prefix: string }> = [
    { id: "standard", label: "Standart", description: "Doğrudan yanıtla.", prefix: "" },
    { id: "plan", label: "Plan", description: "Önce kısa bir plan çıkar.", prefix: "Önce kısa bir plan çıkar, sonra görevi yanıtla." },
    { id: "deep", label: "Derin plan", description: "Adımları ve riskleri ayrıntılı planla.", prefix: "Önce adımları, varsayımları ve riskleri içeren ayrıntılı bir plan çıkar, sonra görevi yanıtla." },
  ];

  const TERMINAL_MODES: ReadonlyArray<{ id: WsTerminalMode; label: string; description: string; prefix: string }> = [
    { id: "off", label: "Terminal kapalı", description: "Komut önerisi istenmez.", prefix: "" },
    { id: "suggest", label: "Komut önerisi iste", description: "Terminal komutlarını önerir; hiçbir şey çalıştırılmaz.", prefix: "Gerekirse terminal komutlarını yalnızca öner; hiçbir komut çalıştırma." },
  ];

  const WORK_MODES: ReadonlyArray<{ id: WsWorkMode; label: string; description: string; prefix: string }> = [
    { id: "local", label: "Yerel", description: "Yerel AI ile çalış.", prefix: "" },
    { id: "brief", label: "Yerel · Kısa yanıt", description: "Kısa ve doğrudan yanıtlar.", prefix: "Kısa ve doğrudan yanıtla." },
  ];

  /** Ruflo roles a Manager can use (must stay identical to RUFLO_AGENT_TYPES in electron/rufloBridge.ts). */
  const AGENT_ROLES: ReadonlyArray<{ id: string; label: string }> = [
    { id: "coder", label: "Kodlayıcı" },
    { id: "reviewer", label: "Gözden geçirici" },
    { id: "tester", label: "Test uzmanı" },
    { id: "planner", label: "Planlayıcı" },
    { id: "researcher", label: "Araştırmacı" },
    { id: "system-architect", label: "Sistem mimarı" },
    { id: "security-auditor", label: "Güvenlik denetçisi" },
    { id: "task-orchestrator", label: "Görev yöneticisi" },
    { id: "council", label: "Konsey (4 model tartışır)" },
    { id: "deep-research", label: "Derin araştırma (Gemini)" },
  ];

  function isAgentRole(value: unknown): value is string {
    return typeof value === "string" && AGENT_ROLES.some((role) => role.id === value);
  }

  function seedManagers(): WsManager[] {
    return [
      { id: "genel", name: "Genel", description: "Her tür görev için genel amaçlı yardımcı. Görevler doğrudan yerel AI'ya gider.", tag: "Varsayılan", custom: false, agent: null },
      { id: "vyron-helper", name: "Vyron Helper", description: "Vyron Code kullanımı ve iş akışları konusunda araştırıp yardım eder.", tag: "Yardımcı", custom: false, agent: "researcher" },
      { id: "coder", name: "Coder", description: "Kod yazar, düzenler ve hata ayıklar. Kod modeli grubunu kullanır.", tag: "Kod", custom: false, agent: "coder" },
      { id: "multi-model-planner", name: "Multi-Model Planner", description: "Büyük işleri en fazla üç bağımsız parçaya böler, ajanlarla paralel yürütür ve sonuçları birleştirir.", tag: "Paralel", custom: false, agent: "task-orchestrator" },
      { id: "konsey", name: "Konsey", description: "Mimari/karar sorularını 4 farklı modele bağımsız sorar, birbirlerinin görüşlerini tartıştırır ve tek bir ortak plana varır.", tag: "Konsey", custom: false, agent: "council" },
      { id: "derin-arastirma", name: "Derin Araştırma", description: "Sorunu Google Gemini Derin Araştırma ajanına verir; web'i tarayıp kaynaklı rapor yazar. Başlatmadan önce onayını ister (hızlı ya da Max); sorunun tamamı Gemini'ye gönderilir.", tag: "Araştırma", custom: false, agent: "deep-research" },
      { id: "reviewer", name: "Reviewer", description: "Çıktıları gözden geçirir ve iyileştirme önerir.", tag: "İnceleme", custom: false, agent: "reviewer" },
    ];
  }

  function seedAgentFor(id: string, custom: boolean): string | null {
    if (custom) return "coder";
    return seedManagers().find((m) => m.id === id)?.agent ?? null;
  }

  function seedConnectors(): WsConnector[] {
    const item = (id: string, name: string, description: string, icon: string): WsConnector => ({ id, name, description, status: "disconnected", custom: false, icon });
    return [
      item("github", "GitHub", "Depoları, sorunları ve çekme isteklerini bağlamına alır.", "github"),
      item("supabase", "Supabase", "Veritabanı ve kimlik doğrulama projelerine erişim.", "database"),
      item("vercel", "Vercel", "Dağıtımları ve proje durumunu izler.", "triangle"),
      item("stripe", "Stripe", "Ödeme ve abonelik verilerine erişim.", "card"),
      item("slack", "Slack", "Kanal ve mesaj bağlamı için bağlantı.", "hash"),
      item("gmail", "Gmail", "E-posta taslakları ve yazışma bağlamı.", "mail"),
      item("notion", "Notion", "Sayfalar ve veritabanlarıyla çalışma alanı bağlamı.", "note"),
    ];
  }

  function seedProjects(): { projects: WsProject[]; tasks: WsTask[] } {
    const projects: WsProject[] = [
      { id: "new-project", name: "new-project", expanded: true, showAll: false },
      { id: "aetheris", name: "AETHERIS", expanded: true, showAll: false },
      { id: "hangikargoo", name: "HANGIKARGOO", expanded: true, showAll: false },
    ];
    const titles: Array<[string, string]> = [
      ["new-project", "Fikri keşfet"],
      ["aetheris", "Arayüz geliştirme"],
      ["aetheris", "Cihaz bağlantısı"],
      ["aetheris", "Kayıt sonrası giriş testi"],
      ["aetheris", "Mimari güncelleme"],
      ["aetheris", "Performans denemesi"],
      ["aetheris", "Dokümantasyon taslağı"],
    ];
    const tasks: WsTask[] = titles.map(([projectId, title], index) => ({
      id: "seed-task-" + String(index + 1),
      projectId,
      title,
      createdAt: 1_700_000_000_000 - index * 60_000,
      managerId: null,
    }));
    return { projects, tasks };
  }

  function defaultState(): WsWorkspaceState {
    const seeded = seedProjects();
    return {
      version: STATE_VERSION,
      sidebarTab: "projects",
      sidebarCollapsed: false,
      view: "new-task",
      projects: seeded.projects,
      tasks: seeded.tasks,
      managers: seedManagers(),
      connectors: seedConnectors(),
      sites: [{ id: "site-gymwolves", name: "Gymwolves", address: "https://gymwolves.com.tr" }],
      activeProjectId: null,
      activeTaskId: null,
      selectedManagerId: null,
      selectedSkillIds: [],
      selectedConnectorIds: [],
      planMode: "standard",
      terminalMode: "off",
      workMode: "local",
      models: defaultModels(),
      customSkills: [],
      customQuickStarts: [],
      quickStartSkills: defaultQuickStartSkills(),
    };
  }

  // ------------------------------------------------------------------------------------------
  // Persistence: validated on load, any invalid piece falls back to its seed. Never throws.
  // ------------------------------------------------------------------------------------------

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function cleanText(value: unknown, max: number): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    return trimmed.slice(0, max);
  }

  function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return typeof value === "string" && (allowed as readonly string[]).indexOf(value) >= 0 ? (value as T) : fallback;
  }

  function cleanList<T>(value: unknown, mapItem: (item: unknown) => T | null, limit: number): T[] | null {
    if (!Array.isArray(value)) return null;
    const out: T[] = [];
    for (const item of value) {
      const mapped = mapItem(item);
      if (mapped !== null) out.push(mapped);
      if (out.length >= limit) break;
    }
    return out;
  }

  function sanitizeState(raw: unknown): WsWorkspaceState {
    const base = defaultState();
    if (!isRecord(raw) || raw.version !== STATE_VERSION) return base;

    const projects = cleanList<WsProject>(
      raw.projects,
      (item) => {
        if (!isRecord(item)) return null;
        const id = cleanText(item.id, 80);
        const name = cleanText(item.name, 60);
        if (!id || !name) return null;
        return { id, name, expanded: item.expanded !== false, showAll: item.showAll === true };
      },
      100,
    );
    const projectIds = new Set((projects ?? base.projects).map((p) => p.id));
    const tasks = cleanList<WsTask>(
      raw.tasks,
      (item) => {
        if (!isRecord(item)) return null;
        const id = cleanText(item.id, 80);
        const title = cleanText(item.title, 80);
        if (!id || !title) return null;
        const projectId = typeof item.projectId === "string" && projectIds.has(item.projectId) ? item.projectId : null;
        const createdAt = typeof item.createdAt === "number" && isFinite(item.createdAt) ? item.createdAt : 0;
        const managerId = typeof item.managerId === "string" && item.managerId.length > 0 && item.managerId.length <= 80 ? item.managerId : null;
        return { id, projectId, title, createdAt, managerId };
      },
      MAX_TASKS,
    );
    const managers = cleanList<WsManager>(
      raw.managers,
      (item) => {
        if (!isRecord(item)) return null;
        const id = cleanText(item.id, 80);
        const name = cleanText(item.name, 40);
        if (!id || !name) return null;
        const custom = item.custom === true;
        // Seeded managers always keep their built-in role; only custom managers carry a stored one.
        const agent = custom && "agent" in item && isAgentRole(item.agent) ? item.agent : seedAgentFor(id, custom);
        return { id, name, description: cleanText(item.description, 140) ?? "Özel manager.", tag: cleanText(item.tag, 20) ?? "Özel", custom, agent };
      },
      50,
    );
    const connectorStatuses: readonly WsConnectorStatus[] = ["disconnected", "pending", "connected"];
    const connectors = cleanList<WsConnector>(
      raw.connectors,
      (item) => {
        if (!isRecord(item)) return null;
        const id = cleanText(item.id, 80);
        const name = cleanText(item.name, 40);
        if (!id || !name) return null;
        return {
          id,
          name,
          description: cleanText(item.description, 140) ?? "Özel bağlayıcı.",
          status: pick(item.status, connectorStatuses, "disconnected"),
          custom: item.custom === true,
          icon: cleanText(item.icon, 20) ?? "plug",
        };
      },
      60,
    );
    const sites = cleanList<WsSite>(
      raw.sites,
      (item) => {
        if (!isRecord(item)) return null;
        const id = cleanText(item.id, 80);
        const name = cleanText(item.name, 60);
        const address = cleanText(item.address, 200);
        if (!id || !name || !address || normalizeSiteAddress(address) === null) return null;
        return { id, name, address };
      },
      30,
    );

    const state: WsWorkspaceState = {
      version: STATE_VERSION,
      sidebarTab: pick(raw.sidebarTab, ["projects", "managers"] as const, "projects"),
      sidebarCollapsed: raw.sidebarCollapsed === true,
      view: "new-task",
      projects: projects ?? base.projects,
      tasks: tasks ?? base.tasks,
      // Built-in managers always exist (a saved list from an older version gains the new ones); custom ones follow.
      managers: managers && managers.length > 0 ? seedManagers().map((seed) => managers.find((m) => m.id === seed.id) ?? seed).concat(managers.filter((m) => m.custom)) : base.managers,
      connectors: connectors ?? base.connectors,
      sites: sites ?? base.sites,
      activeProjectId: null,
      activeTaskId: null,
      selectedManagerId: null,
      selectedSkillIds: [],
      selectedConnectorIds: [],
      planMode: pick(raw.planMode, ["standard", "plan", "deep"] as const, "standard"),
      terminalMode: pick(raw.terminalMode, ["off", "suggest"] as const, "off"),
      workMode: pick(raw.workMode, ["local", "brief"] as const, "local"),
      models: sanitizeModels(raw.models),
      customSkills: sanitizeCustomSkills(raw.customSkills),
      customQuickStarts: [],
      quickStartSkills: {},
    };
    state.customQuickStarts = sanitizeCustomQuickStarts(raw.customQuickStarts);
    state.quickStartSkills = sanitizeQuickStartSkills(raw.quickStartSkills, allSkills(state), allQuickStarts(state).map((q) => q.id));
    for (const task of state.tasks) if (task.managerId !== null && !state.managers.some((m) => m.id === task.managerId)) task.managerId = null;
    if (typeof raw.activeProjectId === "string" && state.projects.some((p) => p.id === raw.activeProjectId)) state.activeProjectId = raw.activeProjectId;
    if (typeof raw.selectedManagerId === "string" && state.managers.some((m) => m.id === raw.selectedManagerId)) state.selectedManagerId = raw.selectedManagerId;
    if (Array.isArray(raw.selectedSkillIds)) {
      state.selectedSkillIds = raw.selectedSkillIds.filter((id): id is string => typeof id === "string" && allSkills(state).some((s) => s.id === id));
    }
    if (Array.isArray(raw.selectedConnectorIds)) {
      state.selectedConnectorIds = raw.selectedConnectorIds.filter(
        (id): id is string => typeof id === "string" && state.connectors.some((c) => c.id === id && c.status === "connected"),
      );
    }
    return state;
  }

  function loadState(storage: WsStorageLike | null): WsWorkspaceState {
    if (!storage) return defaultState();
    try {
      const text = storage.getItem(STORAGE_KEY);
      if (!text) return defaultState();
      return sanitizeState(JSON.parse(text));
    } catch {
      return defaultState();
    }
  }

  function saveState(storage: WsStorageLike | null, state: WsWorkspaceState): boolean {
    if (!storage) return false;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch {
      return false;
    }
  }

  function resetState(storage: WsStorageLike | null): WsWorkspaceState {
    try {
      if (storage) storage.removeItem(STORAGE_KEY);
    } catch {
      // A blocked/unavailable store must never break the workspace; the in-memory defaults still apply.
    }
    return defaultState();
  }

  // ------------------------------------------------------------------------------------------
  // Pure helpers
  // ------------------------------------------------------------------------------------------

  let idCounter = 0;
  function newId(prefix: string): string {
    idCounter += 1;
    return prefix + "-" + Date.now().toString(36) + "-" + idCounter.toString(36) + Math.floor(Math.random() * 1296).toString(36);
  }

  /** Turkish-aware, accent-tolerant folding: dotted/dotless i are treated as the same letter. */
  function fold(text: string): string {
    return text.toLocaleLowerCase("tr").replace(/ı/g, "i");
  }

  function normalizeQuery(text: string): string {
    return fold(text.trim());
  }

  function matchesQuery(query: string, ...fields: string[]): boolean {
    const needle = normalizeQuery(query);
    if (needle.length === 0) return true;
    return fields.some((field) => fold(field).indexOf(needle) >= 0);
  }

  function findProject(state: WsWorkspaceState, id: string | null): WsProject | null {
    if (id === null) return null;
    return state.projects.find((p) => p.id === id) ?? null;
  }

  function findTask(state: WsWorkspaceState, id: string | null): WsTask | null {
    if (id === null) return null;
    return state.tasks.find((t) => t.id === id) ?? null;
  }

  /** The tasks a Manager ran (newest first). */
  function tasksOfManager(state: WsWorkspaceState, managerId: string): WsTask[] {
    return state.tasks.filter((t) => t.managerId === managerId).sort((a, b) => b.createdAt - a.createdAt);
  }

  function renameProject(state: WsWorkspaceState, id: string, rawName: string): boolean {
    const project = state.projects.find((p) => p.id === id);
    const name = cleanName(rawName, 40);
    if (!project || name === null) return false;
    if (state.projects.some((p) => p.id !== id && normalizeQuery(p.name) === normalizeQuery(name))) return false;
    project.name = name;
    return true;
  }

  /** Removes a project together with its tasks; returns the ids of the removed tasks (empty when there was no such project). */
  function removeProject(state: WsWorkspaceState, id: string): string[] {
    if (!state.projects.some((p) => p.id === id)) return [];
    const removed = state.tasks.filter((t) => t.projectId === id).map((t) => t.id);
    state.projects = state.projects.filter((p) => p.id !== id);
    state.tasks = state.tasks.filter((t) => t.projectId !== id);
    if (state.activeProjectId === id) state.activeProjectId = null;
    if (state.activeTaskId !== null && removed.indexOf(state.activeTaskId) >= 0) state.activeTaskId = null;
    return removed;
  }

  /** Moves a project one place up (-1) or down (+1) in the list. */
  function moveProject(state: WsWorkspaceState, id: string, delta: -1 | 1): boolean {
    const from = state.projects.findIndex((p) => p.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= state.projects.length) return false;
    const [project] = state.projects.splice(from, 1);
    state.projects.splice(to, 0, project!);
    return true;
  }

  /** Drag and drop: puts a project right before another one (null = at the end). */
  function moveProjectBefore(state: WsWorkspaceState, id: string, beforeId: string | null): boolean {
    if (id === beforeId) return false;
    const from = state.projects.findIndex((p) => p.id === id);
    if (from < 0) return false;
    const [project] = state.projects.splice(from, 1);
    const at = beforeId === null ? state.projects.length : state.projects.findIndex((p) => p.id === beforeId);
    if (at < 0) {
      state.projects.splice(from, 0, project!);
      return false;
    }
    state.projects.splice(at, 0, project!);
    return true;
  }

  function renameTask(state: WsWorkspaceState, id: string, rawTitle: string): boolean {
    const task = state.tasks.find((t) => t.id === id);
    const title = cleanName(rawTitle, 80);
    if (!task || title === null) return false;
    task.title = title;
    return true;
  }

  function removeTask(state: WsWorkspaceState, id: string): boolean {
    if (!state.tasks.some((t) => t.id === id)) return false;
    state.tasks = state.tasks.filter((t) => t.id !== id);
    if (state.activeTaskId === id) state.activeTaskId = null;
    return true;
  }

  /** Moves a task to another project (null = no project). */
  function moveTask(state: WsWorkspaceState, id: string, projectId: string | null): boolean {
    const task = state.tasks.find((t) => t.id === id);
    if (!task || (projectId !== null && !state.projects.some((p) => p.id === projectId))) return false;
    task.projectId = projectId;
    return true;
  }

  function tasksOfProject(state: WsWorkspaceState, projectId: string | null): WsTask[] {
    return state.tasks.filter((t) => t.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt);
  }

  function visibleTasks(state: WsWorkspaceState, project: WsProject): { visible: WsTask[]; hidden: number } {
    const all = tasksOfProject(state, project.id);
    if (project.showAll || all.length <= COLLAPSED_TASK_COUNT) return { visible: all, hidden: 0 };
    return { visible: all.slice(0, COLLAPSED_TASK_COUNT), hidden: all.length - COLLAPSED_TASK_COUNT };
  }

  function cleanName(raw: string, max: number): string | null {
    const collapsed = raw.replace(/\s+/g, " ").trim();
    if (collapsed.length === 0) return null;
    return collapsed.slice(0, max);
  }

  function createProject(state: WsWorkspaceState, rawName: string): WsProject | null {
    const name = cleanName(rawName, 40);
    if (name === null) return null;
    const existing = state.projects.find((p) => normalizeQuery(p.name) === normalizeQuery(name));
    if (existing) return existing;
    const project: WsProject = { id: newId("project"), name, expanded: true, showAll: false };
    state.projects.push(project);
    return project;
  }

  function createTask(state: WsWorkspaceState, projectId: string | null, title: string, managerId: string | null = null): WsTask {
    const task: WsTask = { id: newId("task"), projectId, title: titleFromPrompt(title), createdAt: Date.now(), managerId };
    state.tasks.unshift(task);
    if (state.tasks.length > MAX_TASKS) state.tasks.length = MAX_TASKS;
    return task;
  }

  function createManager(state: WsWorkspaceState, rawName: string, rawDescription: string, rawAgent: string = "coder"): WsManager | null {
    const name = cleanName(rawName, 40);
    if (name === null) return null;
    const existing = state.managers.find((m) => normalizeQuery(m.name) === normalizeQuery(name));
    if (existing) return existing;
    const manager: WsManager = {
      id: newId("manager"),
      name,
      description: cleanName(rawDescription, 140) ?? "Özel manager.",
      tag: "Özel",
      custom: true,
      agent: isAgentRole(rawAgent) ? rawAgent : "coder",
    };
    state.managers.push(manager);
    return manager;
  }

  function removeManager(state: WsWorkspaceState, id: string): boolean {
    const manager = state.managers.find((m) => m.id === id);
    if (!manager || !manager.custom) return false;
    state.managers = state.managers.filter((m) => m.id !== id);
    for (const task of state.tasks) if (task.managerId === id) task.managerId = null;
    if (state.selectedManagerId === id) state.selectedManagerId = null;
    return true;
  }

  function createConnector(state: WsWorkspaceState, rawName: string, rawDescription: string): WsConnector | null {
    const name = cleanName(rawName, 40);
    if (name === null) return null;
    const existing = state.connectors.find((c) => normalizeQuery(c.name) === normalizeQuery(name));
    if (existing) return existing;
    const connector: WsConnector = {
      id: newId("connector"),
      name,
      description: cleanName(rawDescription, 140) ?? "Özel bağlayıcı.",
      status: "disconnected",
      custom: true,
      icon: "plug",
    };
    state.connectors.push(connector);
    return connector;
  }

  function removeConnector(state: WsWorkspaceState, id: string): boolean {
    const connector = state.connectors.find((c) => c.id === id);
    if (!connector || !connector.custom) return false;
    state.connectors = state.connectors.filter((c) => c.id !== id);
    state.selectedConnectorIds = state.selectedConnectorIds.filter((x) => x !== id);
    return true;
  }

  function setConnectorStatus(state: WsWorkspaceState, id: string, status: WsConnectorStatus): void {
    const connector = state.connectors.find((c) => c.id === id);
    if (!connector) return;
    connector.status = status;
    if (status !== "connected") state.selectedConnectorIds = state.selectedConnectorIds.filter((x) => x !== id);
  }

  function toggleId(list: string[], id: string): string[] {
    return list.indexOf(id) >= 0 ? list.filter((x) => x !== id) : list.concat(id);
  }

  /** Accepts only an http(s) address with a host; returns the display form or null. */
  function normalizeSiteAddress(raw: string): string | null {
    const text = raw.trim();
    if (text.length === 0 || text.length > 200 || /\s/.test(text)) return null;
    const withScheme = /^https?:\/\//i.test(text) ? text : "https://" + text;
    let url: URL;
    try {
      url = new URL(withScheme);
    } catch {
      return null;
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.hostname.indexOf(".") < 0 || url.username || url.password) return null;
    return url.protocol + "//" + url.host + (url.pathname === "/" ? "" : url.pathname);
  }

  function createSite(state: WsWorkspaceState, rawName: string, rawAddress: string): WsSite | null {
    const address = normalizeSiteAddress(rawAddress);
    if (address === null) return null;
    const name = cleanName(rawName, 40) ?? address.replace(/^https?:\/\//, "");
    const existing = state.sites.find((s) => s.address === address);
    if (existing) return existing;
    const site: WsSite = { id: newId("site"), name, address };
    state.sites.push(site);
    return site;
  }

  function removeSite(state: WsWorkspaceState, id: string): void {
    state.sites = state.sites.filter((s) => s.id !== id);
  }

  function titleFromPrompt(text: string): string {
    const firstLine = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "Yeni görev";
    return firstLine.length > 48 ? firstLine.slice(0, 47).trimEnd() + "…" : firstLine;
  }

  const HANDOFF_INTRO =
    "Aşağıdaki plan zaten projenin taranması ve mevcut kodun incelenmesiyle hazırlandı. Yeniden baştan bir kod denetimi ya da durum raporu çıkarma; " +
    "doğrudan planı sırayla uygulamaya başla, değiştireceğin dosyayı yazmadan hemen önce yalnızca o dosyayı oku. Her adımı bitirdikçe ne yaptığını kısaca belirt; belirsiz bir nokta olursa varsayımını yaz ve devam et.";

  /** The task text that hands a finished plan to the Coder; the plan is cut so the whole text stays within the draft limit. */
  function composeHandoff(plan: string): string {
    const head = HANDOFF_INTRO + "\n\nPlan:\n";
    const room = MAX_DRAFT_LENGTH - head.length;
    const body = plan.trim();
    return head + (body.length > room ? body.slice(0, room - 1) + "…" : body);
  }

  function draftProblem(text: string): WsDraftProblem {
    if (text.trim().length === 0) return "empty";
    if (text.length > MAX_DRAFT_LENGTH) return "too_long";
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      const isControl = code < 32 || code === 127;
      if (isControl && code !== 9 && code !== 10 && code !== 13) return "invalid";
    }
    return "ok";
  }


  /**
   * The exact text sent to the local AI: the user's own text, preceded by one short context block
   * that states the selected working preferences. Attachments are intentionally not part of it: the
   * task channel is text-only, and the composer says so next to the attachment list.
   */
  function composePrompt(input: WsPromptInput): string {
    const lines: string[] = [];
    const workMode = WORK_MODES.find((m) => m.id === input.workMode);
    const plan = PLAN_MODES.find((m) => m.id === input.planMode);
    const terminal = TERMINAL_MODES.find((m) => m.id === input.terminalMode);
    if (input.managerName) lines.push("Rol: " + input.managerName + ".");
    if (input.skillNames.length > 0) lines.push("Kullanılacak yetenekler: " + input.skillNames.join(", ") + ".");
    for (const instruction of input.skillInstructions ?? []) lines.push(instruction);
    if (input.connectorNames.length > 0) lines.push("Bağlam olarak seçilen bağlayıcılar: " + input.connectorNames.join(", ") + ".");
    if (workMode && workMode.prefix) lines.push(workMode.prefix);
    if (plan && plan.prefix) lines.push(plan.prefix);
    if (terminal && terminal.prefix) lines.push(terminal.prefix);
    if (lines.length === 0) return input.draft;
    return lines.join("\n") + "\n\n" + input.draft;
  }

  function formatFileSize(bytes: number): string {
    if (!isFinite(bytes) || bytes < 0) return "";
    if (bytes < 1024) return String(Math.round(bytes)) + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }


  /** Splits plain answer text into paragraphs, fenced code blocks and lists. Pure text, never markup. */
  function parseResponse(text: string): WsResponseBlock[] {
    const blocks: WsResponseBlock[] = [];
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    let paragraph: string[] = [];
    let list: { ordered: boolean; items: string[] } | null = null;
    const flushParagraph = () => {
      if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
      paragraph = [];
    };
    const flushList = () => {
      if (list) blocks.push({ kind: "list", ordered: list.ordered, items: list.items });
      list = null;
    };
    let index = 0;
    while (index < lines.length) {
      const line = lines[index] ?? "";
      if (line.trimStart().indexOf("```") === 0) {
        flushParagraph();
        flushList();
        const code: string[] = [];
        index += 1;
        while (index < lines.length && (lines[index] ?? "").trimStart().indexOf("```") !== 0) {
          code.push(lines[index] ?? "");
          index += 1;
        }
        index += 1;
        blocks.push({ kind: "code", text: code.join("\n") });
        continue;
      }
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (bullet || numbered) {
        flushParagraph();
        const ordered = numbered !== null && bullet === null;
        const itemText = (bullet ? bullet[1] : numbered ? numbered[1] : "") ?? "";
        if (list && list.ordered !== ordered) flushList();
        if (!list) list = { ordered, items: [] };
        list.items.push(itemText);
      } else if (line.trim().length === 0) {
        flushParagraph();
        flushList();
      } else {
        flushList();
        paragraph.push(line);
      }
      index += 1;
    }
    flushParagraph();
    flushList();
    return blocks;
  }

  return {
    STORAGE_KEY,
    STATE_VERSION,
    MAX_DRAFT_LENGTH,
    MAX_TASKS,
    COLLAPSED_TASK_COUNT,
    SKILLS,
    allSkills,
    allQuickStarts,
    quickStartSkillIds,
    createSkill,
    removeSkill,
    createQuickStart,
    removeQuickStart,
    toggleQuickStartSkill,
    MAX_SKILL_INSTRUCTIONS,
    QUICK_STARTS,
    PLAN_MODES,
    TERMINAL_MODES,
    WORK_MODES,
    MODEL_SLOTS,
    MODEL_OPTIONS,
    defaultState,
    sanitizeState,
    loadState,
    saveState,
    resetState,
    newId,
    normalizeQuery,
    matchesQuery,
    findProject,
    findTask,
    tasksOfProject,
    visibleTasks,
    cleanName,
    createProject,
    createTask,
    tasksOfManager,
    renameProject,
    removeProject,
    moveProject,
    moveProjectBefore,
    renameTask,
    removeTask,
    moveTask,
    AGENT_ROLES,
    createManager,
    removeManager,
    createConnector,
    removeConnector,
    setConnectorStatus,
    toggleId,
    normalizeSiteAddress,
    createSite,
    removeSite,
    titleFromPrompt,
    draftProblem,
    composeHandoff,
    composePrompt,
    formatFileSize,
    parseResponse,
  };
})();
