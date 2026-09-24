import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ready, setup, errorsOf, html, rendererSource, modelSource, type Harness } from "./workspaceHarness";

// Workspace product tests: the real renderer.html + workspace-model + renderer.ts running in jsdom
// against a fake `window.vyronDesktop` bridge.

let current: Harness | null = null;
async function start(options: Parameters<typeof ready>[0] = {}): Promise<Harness> {
  current = await ready(options);
  return current;
}
afterEach(() => {
  if (current) {
    expect(errorsOf(current), "no uncaught renderer error during the test").toEqual([]);
    current.close();
    current = null;
  }
});

function item(h: Harness, label: string): HTMLElement {
  const found = Array.from(h.doc.querySelectorAll<HTMLElement>("#menu-layer .menu-item, #menu-layer .picker-row, #menu-layer .btn")).find((n) =>
    (n.textContent ?? "").trim().startsWith(label),
  );
  if (!found) throw new Error("menu item not found: " + label + " in [" + h.menuLabels().join(" | ") + "]");
  return found;
}

function active(h: Harness): string {
  const node = h.doc.activeElement as HTMLElement | null;
  return node ? node.id || node.className : "";
}

async function sendTask(h: Harness, text: string): Promise<void> {
  h.type(text);
  h.click(h.el("send-btn"));
  await h.flush();
}

describe("default new-task workspace shell", () => {
  it("shows the workspace (not the startup overlay) once the local AI is ready, on the new-task page", async () => {
    const h = await start();
    expect(h.visibleViews()).toEqual(["new-task"]);
    expect(h.el("startup-overlay").hidden).toBe(true);
    expect(h.el("page-title").textContent).toBe("Yeni görev");
    expect(h.el("ai-status-text").textContent).toBe("Yerel AI hazır");
    expect(h.el("ai-status").className).toContain("ai-status-ready");
    expect(h.doc.activeElement?.id).toBe("task-input");
  });

  it("has the permanent left navigation with the Projeler / Managers tabs and the four main entries", async () => {
    const h = await start();
    expect(h.el("sidebar").getAttribute("aria-label")).toBe("Uygulama gezintisi");
    expect(h.el("tab-projects").textContent).toBe("Projeler");
    expect(h.el("tab-managers").textContent).toBe("Managers");
    expect(h.el("tab-projects").getAttribute("aria-selected")).toBe("true");
    const labels = Array.from(h.doc.querySelectorAll(".nav-item .nav-label")).map((n) => n.textContent);
    expect(labels).toEqual(["Yeni Görev", "Yetenekler", "Bağlayıcılar", "Web sitesi yönetimi"]);
    expect(h.el("nav-new-task").getAttribute("aria-current")).toBe("page");
    expect(h.doc.querySelector(".sb-section-title")?.textContent).toBe("Proje Listesi");
  });

  it("shows the seeded projects, nested tasks, empty-project text, Daha Fazla and the account footer", async () => {
    const h = await start();
    const names = Array.from(h.doc.querySelectorAll("#project-list .project-name")).map((n) => n.textContent);
    expect(names).toEqual(["new-project", "AETHERIS", "HANGIKARGOO"]);
    const aetheris = Array.from(h.doc.querySelectorAll<HTMLElement>(".project-group")).find((g) => g.textContent?.includes("AETHERIS"))!;
    const visibleTasks = Array.from(aetheris.querySelectorAll(".task-item")).map((n) => n.textContent);
    expect(visibleTasks).toEqual(["Arayüz geliştirme", "Cihaz bağlantısı", "Kayıt sonrası giriş testi", "Mimari güncelleme"]);
    expect(aetheris.querySelector(".task-more")?.textContent).toBe("Daha Fazla");
    const hangi = Array.from(h.doc.querySelectorAll<HTMLElement>(".project-group")).find((g) => g.textContent?.includes("HANGIKARGOO"))!;
    expect(hangi.querySelector(".task-empty")?.textContent).toBe("Henüz görev yok");
    expect(h.doc.querySelectorAll("#project-list .project-add")).toHaveLength(3);
    expect(h.el("account-btn").getAttribute("aria-haspopup")).toBe("menu");
    expect(h.el("settings-btn").getAttribute("aria-label")).toBe("Ayarlar");
  });

  it("shows the welcome hero, the mode and project selectors, the large composer and its toolbar", async () => {
    const h = await start();
    expect(h.el("hero-title").textContent).toBe("Vyron ile üret");
    expect(h.el("mode-label").textContent).toBe("Yerel");
    expect(h.el("project-label").textContent).toBe("Proje seç veya oluştur");
    expect(h.el<HTMLTextAreaElement>("task-input").placeholder).toBe("Vyron'un ne üzerinde çalışmasını istersin?");
    expect(h.el("plus-btn").getAttribute("aria-label")).toBe("Ekle");
    expect(h.el("skills-btn").textContent?.trim()).toBe("Yetenekler");
    expect(h.el("connectors-btn").textContent?.trim()).toBe("Bağlayıcılar");
    expect(h.el("plan-label").textContent).toBe("Standart");
    expect(h.el("send-btn").getAttribute("aria-label")).toBe("Gönder");
    expect(h.el("view-new-task").dataset.mode).toBe("empty");
  });

  it("shows the nine quick-start chips, in order", async () => {
    const h = await start();
    const labels = Array.from(h.doc.querySelectorAll("#quick-starts .quick-btn")).map((n) => n.textContent);
    expect(labels).toEqual([
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
  });

  it("renders every icon as an inline svg (no remote image or font)", async () => {
    const h = await start();
    expect(h.doc.querySelectorAll("svg.ico").length).toBeGreaterThan(30);
    expect(h.doc.querySelectorAll("img").length).toBe(0);
  });
});

describe("startup overlay and local AI states", () => {
  it("shows Vyron Code hazırlanıyor with a stage message while starting, then hides it when ready", async () => {
    const h = await start({ ai: { state: "starting", stage: "gateway" } });
    expect(h.el("startup-overlay").hidden).toBe(false);
    expect(h.el("startup-title").textContent).toBe("Vyron Code hazırlanıyor");
    expect(h.el("startup-message").textContent).toBe("Yerel AI motoru başlatılıyor…");
    expect(h.el("ai-status-text").textContent).toBe("Yerel AI başlatılıyor");
    h.behavior.aiState = { state: "ready" };
    h.win.dispatchEvent(new h.win.Event("resize"));
    await new Promise((resolve) => setTimeout(resolve, 700));
    await h.flush();
    expect(h.el("startup-overlay").hidden).toBe(true);
    expect(h.el("ai-status-text").textContent).toBe("Yerel AI hazır");
  });

  it("maps every startup stage to its own fixed message", async () => {
    const messages: Record<string, string> = {
      checking: "Yerel AI bağlantısı kontrol ediliyor…",
      gateway: "Yerel AI motoru başlatılıyor…",
      proxy: "Güvenli bağlantı hazırlanıyor…",
      verifying: "Güvenli bağlantı doğrulanıyor…",
    };
    for (const stage of Object.keys(messages) as Array<"checking" | "gateway" | "proxy" | "verifying">) {
      const h = setup({ ai: { state: "starting", stage } });
      await h.flush();
      expect(h.el("startup-message").textContent).toBe(messages[stage]);
      h.close();
    }
  });

  it("keeps the composer visible but the send button disabled while the AI is not ready, with a fixed hint", async () => {
    const h = await start({ ai: { state: "starting", stage: "checking" } });
    h.type("Hazır olunca gönder");
    expect(h.el<HTMLButtonElement>("send-btn").disabled).toBe(true);
    expect(h.el("composer-error").textContent).toBe("Yerel AI hazır olunca gönderebilirsin.");
  });

  const categories: Array<["hermes_start_failed" | "secure_connection_unverified" | "model_unresponsive" | "unavailable", string]> = [
    ["hermes_start_failed", "Hermes başlatılamadı"],
    ["secure_connection_unverified", "Güvenli bağlantı doğrulanamadı"],
    ["model_unresponsive", "Yerel model yanıt vermiyor"],
    ["unavailable", "Yerel AI kullanılamıyor"],
  ];

  it.each(categories)("shows the safe banner for failure category %s, with retry and diagnostics, and no technical detail", async (category, message) => {
    const h = await start({ ai: { state: "unavailable", category } });
    expect(h.el("ai-banner").hidden).toBe(false);
    expect(h.el("ai-banner-text").textContent).toBe("Yerel AI şu anda hazır değil. " + message + ".");
    expect(h.el("ai-status-text").textContent).toBe("Yerel AI kullanılamıyor");
    expect(h.el("ai-retry-btn").textContent).toBe("Tekrar dene");
    expect(h.el("ai-copy-diagnostics-btn").textContent).toBe("Tanılama bilgilerini kopyala");
    expect(h.el("ai-banner-text").textContent).not.toMatch(/\d{4,5}|http|127\.|localhost|proxy|gateway|key|token/i);
  });

  it("retry makes exactly one explicit request and shows the startup overlay again; it never retries by itself", async () => {
    const h = await start({ ai: { state: "unavailable", category: "hermes_start_failed" } });
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(h.calls.retry).toBe(0);
    h.click(h.el("ai-retry-btn"));
    await h.flush();
    expect(h.calls.retry).toBe(1);
    expect(h.el("startup-overlay").hidden).toBe(false);
  });

  it("copy shows only a fixed confirmation (never diagnostics text), and a fixed message on failure or rejection", async () => {
    const h = await start({ ai: { state: "unavailable", category: "unavailable" } });
    h.click(h.el("ai-copy-diagnostics-btn"));
    await h.flush();
    expect(h.el("ai-copy-status").textContent).toBe("Tanılama bilgileri kopyalandı.");
    h.behavior.copyResult = { copied: false };
    h.click(h.el("ai-copy-diagnostics-btn"));
    await h.flush();
    expect(h.el("ai-copy-status").textContent).toBe("Tanılama bilgileri kopyalanamadı.");
    h.behavior.copyResult = "throw";
    h.click(h.el("ai-copy-diagnostics-btn"));
    await h.flush();
    expect(h.el("ai-copy-status").textContent).toBe("Tanılama bilgileri kopyalanamadı.");
  });

  it("a missing desktop bridge shows the generic unavailable state and harmless buttons", async () => {
    const h = await start({ bridge: false });
    expect(h.el("ai-banner").hidden).toBe(false);
    expect(h.el("ai-banner-text").textContent).toContain("Yerel AI kullanılamıyor");
    h.click(h.el("ai-retry-btn"));
    h.click(h.el("ai-copy-diagnostics-btn"));
    await h.flush();
    expect(h.calls.retry + h.calls.copy).toBe(0);
  });

  it("the settings page mirrors the AI status and offers the same retry/copy actions", async () => {
    const h = await start({ ai: { state: "unavailable", category: "model_unresponsive" } });
    h.click(h.el("settings-btn"));
    expect(h.visibleViews()).toEqual(["settings"]);
    expect(h.el("settings-ai-status").textContent).toContain("Yerel model yanıt vermiyor");
    expect(h.el<HTMLButtonElement>("settings-retry-btn").disabled).toBe(false);
    h.click(h.el("settings-copy-btn"));
    await h.flush();
    expect(h.calls.copy).toBe(1);
  });
});

describe("navigation between workspace views", () => {
  it.each([
    ["nav-skills", "skills", "Yetenekler"],
    ["nav-connectors", "connectors", "Bağlayıcılar"],
    ["nav-sites", "sites", "Web sitesi yönetimi"],
    ["settings-btn", "settings", "Ayarlar"],
  ])("%s opens the %s view with its own title", async (buttonId, view, title) => {
    const h = await start();
    h.click(h.el(buttonId));
    expect(h.visibleViews()).toEqual([view]);
    expect(h.el("page-title").textContent).toBe(title);
    if (buttonId.startsWith("nav-")) expect(h.el(buttonId).getAttribute("aria-current")).toBe("page");
    expect(h.el("nav-new-task").getAttribute("aria-current")).toBeNull();
  });

  it("returns to a fresh new-task page from Yeni Görev", async () => {
    const h = await start();
    h.click(h.el("nav-skills"));
    h.click(h.el("nav-new-task"));
    expect(h.visibleViews()).toEqual(["new-task"]);
    expect(h.el("page-title").textContent).toBe("Yeni görev");
    expect(h.doc.activeElement?.id).toBe("task-input");
  });

  it("switches the sidebar between Projeler and Managers", async () => {
    const h = await start();
    h.click(h.el("tab-managers"));
    expect(h.el("panel-managers").hidden).toBe(false);
    expect(h.el("panel-projects").hidden).toBe(true);
    expect(h.el("tab-managers").getAttribute("aria-selected")).toBe("true");
    const managers = Array.from(h.doc.querySelectorAll("#manager-list .manager-name")).map((n) => n.textContent);
    expect(managers).toEqual(["Genel", "Vyron Helper", "Multi-Model Planner", "Reviewer"]);
    h.click(h.el("tab-projects"));
    expect(h.el("panel-projects").hidden).toBe(false);
  });

  it("collapses the sidebar to a compact rail and back, remembering the choice", async () => {
    const h = await start();
    h.click(h.el("sidebar-toggle-btn"));
    expect(h.el("app").dataset.sidebar).toBe("collapsed");
    expect(h.el("sidebar-toggle-btn").getAttribute("aria-pressed")).toBe("true");
    expect(JSON.parse(h.storageText() ?? "{}").sidebarCollapsed).toBe(true);
    h.click(h.el("sidebar-toggle-btn"));
    expect(h.el("app").dataset.sidebar).toBe("expanded");
  });

  it("the sidebar search filters projects and tasks, and Escape closes and clears it", async () => {
    const h = await start();
    h.click(h.el("sidebar-search-btn"));
    expect(h.el("sidebar-search").hidden).toBe(false);
    expect(h.doc.activeElement?.id).toBe("sidebar-search-input");
    const input = h.el<HTMLInputElement>("sidebar-search-input");
    input.value = "mimari";
    input.dispatchEvent(new h.win.Event("input", { bubbles: true }));
    expect(Array.from(h.doc.querySelectorAll("#project-list .task-item")).map((n) => n.textContent)).toEqual(["Mimari güncelleme"]);
    input.value = "yokboyle";
    input.dispatchEvent(new h.win.Event("input", { bubbles: true }));
    expect(h.el("project-search-empty").hidden).toBe(false);
    h.key(input, "Escape");
    expect(h.el("sidebar-search").hidden).toBe(true);
    expect(h.doc.querySelectorAll("#project-list .project-group").length).toBe(3);
  });

  it("Ctrl+K opens the sidebar search", async () => {
    const h = await start();
    const event = h.key(h.doc.body, "k", { ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(h.el("sidebar-search").hidden).toBe(false);
  });
});

describe("projects and tasks", () => {
  it("creates a project from the sidebar, makes it active, and shows it in the selector", async () => {
    const h = await start();
    h.click(h.el("add-project-btn"));
    expect(h.el("add-project-btn").getAttribute("aria-expanded")).toBe("true");
    const input = h.doc.querySelector<HTMLInputElement>("#menu-layer input")!;
    expect(h.doc.activeElement).toBe(input);
    input.value = "  Yeni  Proje ";
    h.doc.querySelector("#menu-layer form")!.dispatchEvent(new h.win.Event("submit", { bubbles: true, cancelable: true }));
    expect(h.openMenus()).toHaveLength(0);
    const names = Array.from(h.doc.querySelectorAll("#project-list .project-name")).map((n) => n.textContent);
    expect(names).toContain("Yeni Proje");
    expect(h.el("project-label").textContent).toBe("Yeni Proje");
    expect(JSON.parse(h.storageText() ?? "{}").projects.map((p: { name: string }) => p.name)).toContain("Yeni Proje");
  });

  it("rejects an empty project name and keeps the form open with an error", async () => {
    const h = await start();
    h.click(h.el("add-project-btn"));
    const form = h.doc.querySelector("#menu-layer form")!;
    form.dispatchEvent(new h.win.Event("submit", { bubbles: true, cancelable: true }));
    expect(h.openMenus()).toHaveLength(1);
    expect(h.doc.querySelector("#menu-layer .form-error")?.textContent).toBe("Geçerli bir ad yaz.");
  });

  it("does not create a duplicate project with the same name", async () => {
    const h = await start();
    h.click(h.el("add-project-btn"));
    h.doc.querySelector<HTMLInputElement>("#menu-layer input")!.value = "aetheris";
    h.doc.querySelector("#menu-layer form")!.dispatchEvent(new h.win.Event("submit", { bubbles: true, cancelable: true }));
    expect(h.doc.querySelectorAll("#project-list .project-name")).toHaveLength(3);
    expect(h.el("project-label").textContent).toBe("AETHERIS");
  });

  it("the per-project + starts a new task in that project and synchronizes the selector", async () => {
    const h = await start();
    const add = h.doc.querySelector<HTMLElement>('.project-add[aria-label="AETHERIS projesinde yeni görev"]')!;
    h.click(add);
    expect(h.el("project-label").textContent).toBe("AETHERIS");
    expect(h.visibleViews()).toEqual(["new-task"]);
    expect(h.el("view-new-task").dataset.mode).toBe("empty");
    expect(h.doc.activeElement?.id).toBe("task-input");
  });

  it("sending a task creates a task entry under the selected project and marks it active", async () => {
    const h = await start();
    h.click(h.doc.querySelector<HTMLElement>('.project-add[aria-label="HANGIKARGOO projesinde yeni görev"]'));
    await sendTask(h, "Kargo fiyatlarını karşılaştır");
    const hangi = Array.from(h.doc.querySelectorAll<HTMLElement>(".project-group")).find((g) => g.textContent?.includes("HANGIKARGOO"))!;
    expect(hangi.querySelector(".task-empty")).toBeNull();
    const task = hangi.querySelector<HTMLElement>(".task-item")!;
    expect(task.textContent).toBe("Kargo fiyatlarını karşılaştır");
    expect(task.getAttribute("aria-current")).toBe("true");
    expect(hangi.closest(".project-group")?.querySelector(".project-row")?.classList.contains("is-active")).toBe(true);
  });

  it("opens an existing task from the list, showing its heading and the composer for follow-ups", async () => {
    const h = await start();
    h.click(h.doc.querySelector<HTMLElement>('.task-item[data-task-id="seed-task-2"]'));
    expect(h.el("view-new-task").dataset.mode).toBe("conversation");
    expect(h.el("conversation-heading").textContent).toBe("Yeni görev / AETHERIS / Arayüz geliştirme");
    expect(h.doc.querySelector("#turns .turn-note")?.textContent).toContain("bu oturumda kayıtlı yanıt yok");
    expect(h.el("project-label").textContent).toBe("AETHERIS");
    expect(h.doc.querySelector('.task-item[data-task-id="seed-task-2"]')?.getAttribute("aria-current")).toBe("true");
  });

  it("Daha Fazla reveals the remaining tasks and toggles back", async () => {
    const h = await start();
    const more = () => h.doc.querySelector<HTMLElement>(".project-group .task-more")!;
    h.click(more());
    const names = Array.from(h.doc.querySelectorAll("#project-list .task-item")).map((n) => n.textContent);
    expect(names).toContain("Dokümantasyon taslağı");
    expect(more().textContent).toBe("Daha az göster");
    h.click(more());
    expect(Array.from(h.doc.querySelectorAll("#project-list .task-item")).map((n) => n.textContent)).not.toContain("Dokümantasyon taslağı");
  });

  it("collapsing and expanding a project group works from its row", async () => {
    const h = await start();
    const row = h.doc.querySelector<HTMLElement>(".project-group .project-main")!;
    h.click(row);
    const group = h.doc.querySelector<HTMLElement>(".project-group")!;
    expect(group.dataset.expanded).toBe("false");
    expect(group.querySelector(".task-list")).toBeNull();
    h.click(h.doc.querySelector<HTMLElement>(".project-group .project-main"));
    expect(h.doc.querySelector<HTMLElement>(".project-group")!.dataset.expanded).toBe("true");
  });

  it("the project selector lists projects, Projesiz and Yeni proje oluştur, and selecting one syncs the sidebar", async () => {
    const h = await start();
    h.click(h.el("project-btn"));
    expect(h.menuLabels()).toEqual(["Projesiz", "new-project", "AETHERIS", "HANGIKARGOO", "Yeni proje oluştur"]);
    expect(item(h, "Projesiz").getAttribute("aria-checked")).toBe("true");
    h.click(item(h, "HANGIKARGOO"));
    expect(h.el("project-label").textContent).toBe("HANGIKARGOO");
    expect(h.doc.querySelector(".project-row.is-active")?.textContent).toContain("HANGIKARGOO");
    expect(h.openMenus()).toHaveLength(0);
    expect(active(h)).toBe("project-btn");
  });

  it("the project selector can create a project inline", async () => {
    const h = await start();
    h.click(h.el("project-btn"));
    h.click(item(h, "Yeni proje oluştur"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const input = h.doc.querySelector<HTMLInputElement>("#menu-layer input")!;
    input.value = "Selector Projesi";
    h.doc.querySelector("#menu-layer form")!.dispatchEvent(new h.win.Event("submit", { bubbles: true, cancelable: true }));
    expect(h.el("project-label").textContent).toBe("Selector Projesi");
  });

  it("switching the selector to another project while a task is open returns to a new-task page for that project", async () => {
    const h = await start();
    h.click(h.doc.querySelector<HTMLElement>('.task-item[data-task-id="seed-task-2"]'));
    h.click(h.el("project-btn"));
    h.click(item(h, "new-project"));
    expect(h.el("view-new-task").dataset.mode).toBe("empty");
  });

  it("persists projects and task titles across a reload, but never task text or answers", async () => {
    const h = await start();
    h.click(h.el("project-btn"));
    h.click(item(h, "AETHERIS"));
    await sendTask(h, "GIZLI_GOREV_METNI_12345");
    const stored = h.storageText()!;
    expect(stored).toContain("GIZLI_GOREV_METNI_12345".slice(0, 20)); // the task TITLE is derived from the first line
    expect(stored).not.toContain("Yanıt metni");
    const second = await ready({ storage: stored });
    const aetheris = Array.from(second.doc.querySelectorAll<HTMLElement>(".project-group")).find((g) => g.textContent?.includes("AETHERIS"))!;
    expect(aetheris.querySelector(".task-item")?.textContent).toBe("GIZLI_GOREV_METNI_12345");
    expect(second.el("task-input").getAttribute("value")).toBeNull();
    expect((second.el<HTMLTextAreaElement>("task-input")).value).toBe("");
    second.close();
  });

  it("falls back to the seeded workspace when the stored state is corrupt", async () => {
    const h = await start({ storage: "{not json" });
    expect(h.doc.querySelectorAll("#project-list .project-name")).toHaveLength(3);
  });
});

describe("composer typing, empty state and direct send", () => {
  it("keeps send disabled for empty and whitespace-only drafts and enables it for text", async () => {
    const h = await start();
    const send = h.el<HTMLButtonElement>("send-btn");
    expect(send.disabled).toBe(true);
    expect(h.el("composer").dataset.state).toBe("disabled");
    h.type("   \n\t ");
    expect(send.disabled).toBe(true);
    h.type("Bir görev");
    expect(send.disabled).toBe(false);
    expect(h.el("composer").dataset.state).toBe("ready");
  });

  it("shows a fixed error for a draft over 4000 characters and for control characters", async () => {
    const h = await start();
    h.type("a".repeat(4001));
    expect(h.el<HTMLButtonElement>("send-btn").disabled).toBe(true);
    expect(h.el("composer-error").textContent).toBe("Metin çok uzun. En fazla 4000 karakter gönderilebilir.");
    h.type("merhaba" + String.fromCharCode(0) + "dünya");
    expect(h.el("composer-error").textContent).toBe("Metin desteklenmeyen karakterler içeriyor.");
    h.type("a".repeat(4000));
    expect(h.el<HTMLButtonElement>("send-btn").disabled).toBe(false);
    expect(h.el("composer-error").hidden).toBe(true);
  });

  it("the send button sends the task directly: one call, no review step, and the workspace stays put", async () => {
    const h = await start();
    await sendTask(h, "Merhaba dünya");
    expect(h.calls.send).toEqual([{ draft: "Merhaba dünya" }]);
    expect(h.visibleViews()).toEqual(["new-task"]);
    expect(h.el("view-new-task").dataset.mode).toBe("conversation");
    expect(h.doc.body.textContent).not.toMatch(/Taslağı incele|Göndermeden önce incele|İncelenen task|Hermes'e gönderilecek metin/);
  });

  it("Ctrl+Enter sends, Cmd+Enter (metaKey) sends, and plain Enter does not send", async () => {
    const h = await start();
    h.type("Klavye ile");
    const plain = h.key(h.el("task-input"), "Enter");
    expect(plain.defaultPrevented).toBe(false);
    expect(h.calls.send).toHaveLength(0);
    const shift = h.key(h.el("task-input"), "Enter", { shiftKey: true });
    expect(shift.defaultPrevented).toBe(false);
    const ctrl = h.key(h.el("task-input"), "Enter", { ctrlKey: true });
    expect(ctrl.defaultPrevented).toBe(true);
    await h.flush();
    expect(h.calls.send).toEqual([{ draft: "Klavye ile" }]);

    h.click(h.el("new-task-btn"));
    h.type("Mac ile");
    h.key(h.el("task-input"), "Enter", { metaKey: true });
    await h.flush();
    expect(h.calls.send).toEqual([{ draft: "Klavye ile" }, { draft: "Mac ile" }]);
  });

  it("Enter inserts a newline instead of sending: a multi-line draft is sent whole", async () => {
    const h = await start();
    h.type("satır bir\nsatır iki\n\tsatır üç");
    expect(h.key(h.el("task-input"), "Enter").defaultPrevented).toBe(false);
    h.click(h.el("send-btn"));
    await h.flush();
    expect(h.calls.send[0]?.draft).toBe("satır bir\nsatır iki\n\tsatır üç");
  });

  it("Ctrl+Enter does nothing for an empty draft", async () => {
    const h = await start();
    h.key(h.el("task-input"), "Enter", { ctrlKey: true });
    await h.flush();
    expect(h.calls.send).toHaveLength(0);
  });

  it("does not send while the local AI is not ready", async () => {
    const h = await start({ ai: { state: "unavailable", category: "unavailable" } });
    h.type("Gönderilmemeli");
    h.key(h.el("task-input"), "Enter", { ctrlKey: true });
    h.click(h.el("send-btn"));
    await h.flush();
    expect(h.calls.send).toHaveLength(0);
    expect(h.el<HTMLTextAreaElement>("task-input").value).toBe("Gönderilmemeli");
  });

  it("prevents a duplicate send while one is in flight, and shows Çalışıyor… meanwhile", async () => {
    const h = await start();
    let release!: () => void;
    h.behavior.sendGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await sendTask(h, "İlk görev");
    expect(h.el("composer").dataset.state).toBe("sending");
    expect(h.el("send-btn").getAttribute("aria-label")).toBe("Gönderiliyor");
    expect(h.doc.querySelector("#turns .working")?.textContent).toBe("Çalışıyor…");
    h.type("İkinci görev");
    expect(h.el<HTMLButtonElement>("send-btn").disabled).toBe(true);
    h.key(h.el("task-input"), "Enter", { ctrlKey: true });
    h.click(h.el("send-btn"));
    await h.flush();
    expect(h.calls.send).toHaveLength(1);
    release();
    await h.flush();
    expect(h.el("composer").dataset.state).toBe("ready");
    expect(h.doc.querySelector("#turns .working")).toBeNull();
  });

  it("clears the draft after sending", async () => {
    const h = await start();
    await sendTask(h, "Temizlenmeli");
    expect(h.el<HTMLTextAreaElement>("task-input").value).toBe("");
    expect(h.el<HTMLButtonElement>("send-btn").disabled).toBe(true);
  });

  it("the selected preferences reach the model as a short context block above the user's own text", async () => {
    const h = await start();
    h.click(h.el("plan-btn"));
    h.click(item(h, "Plan"));
    await sendTask(h, "Bir özet yaz");
    const draft = h.calls.send[0]!.draft;
    expect(draft.endsWith("\n\nBir özet yaz")).toBe(true);
    expect(draft).toContain("Önce kısa bir plan çıkar");
  });

  it("without any selection, exactly the user's text is sent (nothing added)", async () => {
    const h = await start();
    await sendTask(h, "Sadece bu");
    expect(h.calls.send[0]).toEqual({ draft: "Sadece bu" });
  });

  it("blocks a send whose composed text would exceed the limit because of the selections", async () => {
    const h = await start();
    h.click(h.el("plan-btn"));
    h.click(item(h, "Derin plan"));
    h.type("a".repeat(3970));
    expect(h.el<HTMLButtonElement>("send-btn").disabled).toBe(true);
    expect(h.el("composer-error").textContent).toContain("Metin çok uzun");
  });
});

describe("result workspace", () => {
  it("shows the submitted task, the Yanıt block and the two actions in the same workspace", async () => {
    const h = await start();
    await sendTask(h, "Bir soru");
    expect(h.doc.querySelector("#turns .user-block .user-text")?.textContent).toBe("Bir soru");
    const answer = h.doc.querySelector("#turns .assistant-block")!;
    expect(answer.getAttribute("aria-label")).toBe("Yanıt");
    expect(answer.textContent).toContain("Yanıt metni");
    expect(h.el("new-task-btn").textContent).toBe("Yeni görev");
    expect(h.el("clear-response-btn").textContent).toBe("Yanıtı temizle");
    expect(h.el("clear-response-btn").hidden).toBe(false);
    expect(h.el("conversation-heading").textContent).toBe("Yeni görev / Projesiz / Bir soru");
  });

  it("renders paragraphs, lists and code blocks as inert text, and never creates markup from an answer", async () => {
    const h = await start();
    h.behavior.sendResult = {
      state: "completed",
      text: 'Giriş <img src=x onerror="alert(1)">\n\n- bir\n- iki\n\n1. bir\n2. iki\n\n```js\nconst a = "<b>x</b>";\n```\nSon <script>alert(2)</script>',
      truncated: false,
    };
    await sendTask(h, "Biçim");
    const block = h.doc.querySelector("#turns .assistant-block")!;
    expect(block.querySelectorAll("ul > li")).toHaveLength(2);
    expect(block.querySelectorAll("ol > li")).toHaveLength(2);
    expect(block.querySelector("pre code")?.textContent).toBe('const a = "<b>x</b>";');
    expect(block.querySelector("img, script, b")).toBeNull();
    expect(block.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(block.textContent).toContain("<script>alert(2)</script>");
  });

  it("shows the truncation note only when the answer was truncated", async () => {
    const h = await start();
    h.behavior.sendResult = { state: "completed", text: "kısaltılmış", truncated: true };
    await sendTask(h, "x");
    expect(h.doc.querySelector("#turns .truncated-note")?.textContent).toBe("Yanıt kısaltıldı.");
  });

  it("Yeni görev returns to the empty new-task composer and keeps the previous task in the sidebar", async () => {
    const h = await start();
    await sendTask(h, "Birinci görev");
    h.click(h.el("new-task-btn"));
    expect(h.el("view-new-task").dataset.mode).toBe("empty");
    expect(h.doc.querySelectorAll("#turns .turn")).toHaveLength(0);
    expect(Array.from(h.doc.querySelectorAll("#project-list .task-item")).map((n) => n.textContent)).toContain("Birinci görev");
    expect(h.doc.activeElement?.id).toBe("task-input");
  });

  it("Yanıtı temizle removes the answer, calls the main-process clear, and keeps the composer usable", async () => {
    const h = await start();
    await sendTask(h, "Silinecek yanıt");
    const before = h.calls.clear;
    h.click(h.el("clear-response-btn"));
    await h.flush();
    expect(h.calls.clear).toBeGreaterThan(before);
    expect(h.doc.querySelector("#turns .assistant-block")).toBeNull();
    expect(h.doc.querySelector("#turns .turn-note")?.textContent).toBe("Yanıt temizlendi.");
    expect(h.el("clear-response-btn").hidden).toBe(true);
    expect(h.doc.activeElement?.id).toBe("task-input");
  });

  it("a follow-up in the same task appends a second turn", async () => {
    const h = await start();
    await sendTask(h, "İlk");
    await sendTask(h, "Devam");
    expect(h.doc.querySelectorAll("#turns .turn")).toHaveLength(2);
    expect(h.calls.send.map((c) => c.draft)).toEqual(["İlk", "Devam"]);
    expect(Array.from(h.doc.querySelectorAll("#project-list .task-item")).filter((n) => n.textContent === "İlk")).toHaveLength(1);
  });

  it("a failed send shows one fixed message with Tekrar dene, and the retry re-sends the same text", async () => {
    const h = await start();
    h.behavior.sendResult = { state: "safe_failure", text: "raw provider error body", truncated: false };
    await sendTask(h, "Başarısız olacak");
    const error = h.doc.querySelector("#turns .turn-error")!;
    expect(error.textContent).toContain("Yanıt alınamadı. Lütfen tekrar deneyin.");
    expect(h.doc.body.textContent).not.toContain("raw provider error body");
    h.behavior.sendResult = { state: "completed", text: "Bu sefer oldu", truncated: false };
    h.click(error.querySelector<HTMLElement>("button"));
    await h.flush();
    expect(h.calls.send.map((c) => c.draft)).toEqual(["Başarısız olacak", "Başarısız olacak"]);
    expect(h.doc.querySelector("#turns .assistant-block")?.textContent).toContain("Bu sefer oldu");
    expect(h.doc.querySelector("#turns .turn-error")).toBeNull();
  });

  it("a rejected send is handled as a failure with retry (no unhandled error)", async () => {
    const h = await start();
    h.behavior.sendThrows = true;
    await sendTask(h, "Reddedilecek");
    expect(h.doc.querySelector("#turns .turn-error")).not.toBeNull();
    expect(h.el<HTMLTextAreaElement>("task-input").value).toBe("");
  });

  it("an unauthorized send result reports that the local AI is not ready", async () => {
    const h = await start();
    h.behavior.sendResult = { state: "unauthorized", text: null, truncated: false };
    await sendTask(h, "Yetkisiz");
    expect(h.doc.querySelector("#turns .turn-error")?.textContent).toContain("Yerel AI şu anda hazır değil.");
  });
});

describe("quick starts and work mode", () => {
  it("a quick-start chip fills the composer, selects the placeholder, focuses it and does not send", async () => {
    const h = await start();
    h.click(h.doc.querySelector<HTMLElement>('[data-quick-id="build-app"]'));
    const input = h.el<HTMLTextAreaElement>("task-input");
    expect(input.value).toContain("Şu uygulamayı oluşturmak istiyorum: [uygulama fikrini yaz].");
    expect(input.value.slice(input.selectionStart, input.selectionEnd)).toBe("[uygulama fikrini yaz]");
    expect(h.doc.activeElement).toBe(input);
    await h.flush();
    expect(h.calls.send).toHaveLength(0);
    expect(h.el<HTMLButtonElement>("send-btn").disabled).toBe(false);
  });

  it("every quick start populates a non-empty draft", async () => {
    const h = await start();
    for (const chip of Array.from(h.doc.querySelectorAll<HTMLElement>("#quick-starts .quick-btn"))) {
      h.type("");
      h.click(chip);
      expect(h.el<HTMLTextAreaElement>("task-input").value.length, chip.textContent ?? "").toBeGreaterThan(20);
    }
  });

  it("the work mode selector lists the modes, marks the current one and applies a selection", async () => {
    const h = await start();
    h.click(h.el("mode-btn"));
    expect(h.menuLabels()).toEqual(["Yerel" + "Yerel AI ile çalış.", "Yerel · Kısa yanıt" + "Kısa ve doğrudan yanıtlar."]);
    expect(h.doc.querySelector("#menu-layer .menu-item")?.getAttribute("aria-checked")).toBe("true");
    h.click(item(h, "Yerel · Kısa yanıt"));
    expect(h.el("mode-label").textContent).toBe("Yerel · Kısa yanıt");
    expect(h.doc.querySelector("#chips")?.textContent).toContain("Yerel · Kısa yanıt");
    await sendTask(h, "Kısa cevap");
    expect(h.calls.send[0]!.draft).toContain("Kısa ve doğrudan yanıtla.");
  });
});

describe("+ menu, SubAgent, Plan and Terminal", () => {
  it("opens the + menu with the four entries and submenu arrows", async () => {
    const h = await start();
    h.click(h.el("plus-btn"));
    expect(h.el("plus-btn").getAttribute("aria-expanded")).toBe("true");
    expect(h.menuLabels()).toEqual(["Resim veya dosya ekle", "SubAgent", "Plan", "Terminal"]);
    const subs = Array.from(h.doc.querySelectorAll("#menu-layer .menu-item")).filter((n) => n.getAttribute("aria-haspopup") === "menu");
    expect(subs).toHaveLength(3);
  });

  it("SubAgent submenu lists the managers, and choosing one shows a removable chip and updates the sidebar", async () => {
    const h = await start();
    h.click(h.el("plus-btn"));
    h.click(item(h, "SubAgent"));
    expect(h.openMenus()).toHaveLength(2);
    expect(h.menuLabels().slice(4)).toEqual(["SubAgent kullanma", "Genel" + "Varsayılan", "Vyron Helper" + "Yardımcı", "Multi-Model Planner" + "Planlama", "Reviewer" + "İnceleme"]);
    h.click(item(h, "Reviewer"));
    expect(h.openMenus()).toHaveLength(0);
    const chip = h.doc.querySelector("#chips .chip")!;
    expect(chip.textContent).toContain("SubAgent");
    expect(chip.textContent).toContain("Reviewer");
    h.click(h.el("tab-managers"));
    expect(h.doc.querySelector('.manager-main[data-manager-id="reviewer"]')?.getAttribute("aria-pressed")).toBe("true");
    await sendTask(h, "İncele");
    expect(h.calls.send[0]!.draft).toContain("Rol: Reviewer.");
    h.click(h.doc.querySelector<HTMLElement>('#chips .chip-remove[aria-label="Reviewer seçimini kaldır"]') ?? h.doc.querySelector<HTMLElement>("#chips .chip-remove"));
    expect(h.doc.querySelector("#chips")?.textContent).toBe("");
  });

  it("the submenu opens on ArrowRight, closes on ArrowLeft and returns focus to its parent item", async () => {
    const h = await start();
    h.click(h.el("plus-btn"));
    const sub = item(h, "SubAgent");
    sub.focus();
    h.key(sub, "ArrowRight");
    expect(h.openMenus()).toHaveLength(2);
    expect(h.doc.activeElement?.textContent).toContain("SubAgent kullanma");
    h.key(h.doc.activeElement!, "ArrowLeft");
    expect(h.openMenus()).toHaveLength(1);
    expect(h.doc.activeElement).toBe(sub);
  });

  it("Plan submenu selects a mode, shows it in the compact control and as a chip", async () => {
    const h = await start();
    h.click(h.el("plus-btn"));
    h.click(item(h, "Plan"));
    expect(h.menuLabels().slice(4).map((l) => l.replace(/[.].*$/, ""))).toEqual(["Standart" + "Doğrudan yanıtla", "Plan" + "Önce kısa bir plan çıkar", "Derin plan" + "Adımları ve riskleri ayrıntılı planla"].map((l) => l.replace(/[.].*$/, "")));
    h.click(item(h, "Derin plan"));
    expect(h.el("plan-label").textContent).toBe("Derin plan");
    expect(h.doc.querySelector("#chips")?.textContent).toContain("Derin plan");
  });

  it("the compact plan control on the right offers the same modes", async () => {
    const h = await start();
    h.click(h.el("plan-btn"));
    expect(h.menuLabels().map((l) => l.slice(0, 5))).toEqual(["Stand", "Plan" + "Ön", "Derin"].map((l) => l.slice(0, 5)));
    h.click(item(h, "Plan"));
    expect(h.el("plan-label").textContent).toBe("Plan");
  });

  it("Terminal submenu offers Terminal kapalı and Komut önerisi iste, and the choice becomes a chip and a prompt hint", async () => {
    const h = await start();
    h.click(h.el("plus-btn"));
    h.click(item(h, "Terminal"));
    expect(h.menuLabels().slice(4).map((l) => l.slice(0, 15))).toEqual(["Terminal kapalı", "Komut önerisi i"]);
    h.click(item(h, "Komut önerisi iste"));
    expect(h.doc.querySelector("#chips")?.textContent).toContain("komut önerisi");
    await sendTask(h, "Bir betik yaz");
    expect(h.calls.send[0]!.draft).toContain("hiçbir komut çalıştırma");
  });
});

describe("attachments", () => {
  function choose(h: Harness, files: Array<{ name: string; size: number }>): void {
    const input = h.el<HTMLInputElement>("file-input");
    Object.defineProperty(input, "files", { value: files, configurable: true });
    input.dispatchEvent(new h.win.Event("change", { bubbles: true }));
  }

  it("Resim veya dosya ekle opens the real file selection (the hidden file input)", async () => {
    const h = await start();
    let opened = 0;
    h.el("file-input").addEventListener("click", () => {
      opened += 1;
    });
    h.click(h.el("plus-btn"));
    h.click(item(h, "Resim veya dosya ekle"));
    expect(opened).toBe(1);
    expect(h.el<HTMLInputElement>("file-input").multiple).toBe(true);
  });

  it("selected files appear as chips with name and size, with the honest text-only note, and can be removed", async () => {
    const h = await start();
    choose(h, [
      { name: "ekran.png", size: 2048 },
      { name: "rapor.pdf", size: 3 * 1024 * 1024 },
    ]);
    const chips = Array.from(h.doc.querySelectorAll("#chips .chip")).map((n) => n.textContent);
    expect(chips[0]).toContain("ekran.png");
    expect(chips[0]).toContain("2.0 KB");
    expect(chips[1]).toContain("rapor.pdf");
    expect(chips[1]).toContain("3.0 MB");
    expect(h.doc.querySelector("#chips .chip-note")?.textContent).toBe("Ekler bu sürümde göreve gönderilmez; yalnızca görev metni iletilir.");
    h.click(h.doc.querySelector<HTMLElement>('#chips .chip-remove[aria-label="ekran.png ekini kaldır"]'));
    expect(Array.from(h.doc.querySelectorAll("#chips .chip")).map((n) => n.textContent)).toHaveLength(1);
    h.click(h.doc.querySelector<HTMLElement>('#chips .chip-remove[aria-label="rapor.pdf ekini kaldır"]'));
    expect(h.doc.querySelector("#chips")?.textContent).toBe("");
  });

  it("ignores a duplicate file, limits to ten attachments, and clears attachments after sending", async () => {
    const h = await start();
    choose(h, [{ name: "a.txt", size: 1 }, { name: "a.txt", size: 1 }]);
    expect(h.doc.querySelectorAll("#chips .chip")).toHaveLength(1);
    choose(h, Array.from({ length: 15 }, (_v, i) => ({ name: "f" + String(i) + ".txt", size: i + 5 })));
    expect(h.doc.querySelectorAll("#chips .chip")).toHaveLength(10);
    await sendTask(h, "Ekli görev");
    expect(h.doc.querySelector("#chips")?.textContent).toBe("");
    expect(h.calls.send[0]!.draft).toBe("Ekli görev");
  });
});

describe("skills", () => {
  it("the picker has a search field, the Kullanıcı group, six skill rows with tags, and the Yetenek Ara entry", async () => {
    const h = await start();
    h.click(h.el("skills-btn"));
    const panel = h.doc.querySelector("#menu-layer .panel")!;
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(h.doc.activeElement).toBe(panel.querySelector("input"));
    expect(panel.querySelector(".menu-heading")?.textContent).toBe("Kullanıcı");
    const rows = Array.from(panel.querySelectorAll(".picker-row")).map((n) => n.querySelector(".picker-name")?.textContent);
    expect(rows).toEqual(["Confirmed Data Analysis", "Create Image", "Design Then Build", "Find Skills", "Frontend Design", "Skill Creator"]);
    expect(panel.querySelectorAll(".picker-row .tag")).toHaveLength(6);
    expect(panel.querySelector(".panel-foot")?.textContent).toContain("Yetenek Ara");
    expect((panel.querySelector("input") as HTMLInputElement).placeholder).toBe("Beceri ara");
  });

  it("search filters the list, shows an empty message and clears back", async () => {
    const h = await start();
    h.click(h.el("skills-btn"));
    const search = h.doc.querySelector<HTMLInputElement>("#menu-layer .panel input")!;
    search.value = "image";
    search.dispatchEvent(new h.win.Event("input", { bubbles: true }));
    expect(Array.from(h.doc.querySelectorAll("#menu-layer .picker-name")).map((n) => n.textContent)).toEqual(["Create Image"]);
    search.value = "zzz";
    search.dispatchEvent(new h.win.Event("input", { bubbles: true }));
    expect(h.doc.querySelector("#menu-layer .panel-empty")?.textContent).toBe("Sonuç bulunamadı.");
    search.value = "";
    search.dispatchEvent(new h.win.Event("input", { bubbles: true }));
    expect(h.doc.querySelectorAll("#menu-layer .picker-row")).toHaveLength(6);
  });

  it("supports multiple selection, shows chips in the composer, and removing a chip deselects the skill", async () => {
    const h = await start();
    h.click(h.el("skills-btn"));
    h.click(item(h, "Frontend Design"));
    h.click(item(h, "Create Image"));
    expect(h.doc.querySelectorAll("#menu-layer .picker-row[aria-pressed='true']")).toHaveLength(2);
    expect(h.openMenus()).toHaveLength(1);
    h.key(h.doc.activeElement!, "Escape");
    const chips = Array.from(h.doc.querySelectorAll("#chips .chip")).map((n) => n.textContent);
    expect(chips[0]).toContain("Create Image");
    expect(chips[1]).toContain("Frontend Design");
    expect(h.el("skills-btn").classList.contains("has-selection")).toBe(true);
    h.click(h.doc.querySelector<HTMLElement>('#chips .chip-remove[aria-label="Create Image yeteneğini kaldır"]'));
    expect(h.doc.querySelectorAll("#chips .chip")).toHaveLength(1);
    h.click(h.el("skills-btn"));
    expect(h.doc.querySelector('#menu-layer [data-skill-id="create-image"]')?.getAttribute("aria-pressed")).toBe("false");
  });

  it("selected skills reach the prompt and are persisted", async () => {
    const h = await start();
    h.click(h.el("skills-btn"));
    h.click(item(h, "Design Then Build"));
    h.outsideClick();
    await sendTask(h, "Bir site");
    expect(h.calls.send[0]!.draft).toContain("Kullanılacak yetenekler: Design Then Build.");
    expect(JSON.parse(h.storageText()!).selectedSkillIds).toEqual(["design-then-build"]);
    const second = await ready({ storage: h.storageText() });
    expect(second.doc.querySelector("#chips")?.textContent).toContain("Design Then Build");
    second.close();
  });

  it("Yetenek Ara opens the Yetenekler page with the search focused", async () => {
    const h = await start();
    h.click(h.el("skills-btn"));
    h.click(item(h, "Yetenek Ara"));
    expect(h.visibleViews()).toEqual(["skills"]);
    expect(h.doc.activeElement?.id).toBe("skills-search");
    expect(h.openMenus()).toHaveLength(0);
  });

  it("the Yetenekler page lists the skills, filters, toggles use and mirrors the composer selection", async () => {
    const h = await start();
    h.click(h.el("nav-skills"));
    expect(h.doc.querySelectorAll("#skills-page-list .row")).toHaveLength(6);
    expect(h.el("skills-count").textContent).toBe("Seçili yetenek yok");
    const use = h.doc.querySelector<HTMLElement>('#skills-page-list [data-skill-id="find-skills"] button')!;
    expect(use.textContent).toBe("Kullan");
    h.click(use);
    expect(h.doc.querySelector('#skills-page-list [data-skill-id="find-skills"] button')?.textContent).toBe("Kullanılıyor");
    expect(h.el("skills-count").textContent).toBe("1 yetenek seçili");
    const search = h.el<HTMLInputElement>("skills-search");
    search.value = "olmayanbir";
    search.dispatchEvent(new h.win.Event("input", { bubbles: true }));
    expect(h.el("skills-page-empty").hidden).toBe(false);
    h.click(h.el("nav-new-task"));
    expect(h.doc.querySelector("#chips")?.textContent).toContain("Find Skills");
  });
});

describe("connectors", () => {
  it("the picker lists the seven services with Bağlan actions, search, Bağlayıcı Ekle and Bağlayıcıları Yönet", async () => {
    const h = await start();
    h.click(h.el("connectors-btn"));
    const panel = h.doc.querySelector("#menu-layer .panel")!;
    const names = Array.from(panel.querySelectorAll(".picker-name")).map((n) => n.textContent);
    expect(names).toEqual(["GitHub", "Supabase", "Vercel", "Stripe", "Slack", "Gmail", "Notion"]);
    const actions = Array.from(panel.querySelectorAll(".picker-action")).map((n) => n.textContent);
    expect(actions).toEqual(Array(7).fill("Bağlan"));
    expect((panel.querySelector("input") as HTMLInputElement).placeholder).toBe("Bağlayıcıları ara");
    expect(panel.querySelector(".panel-foot")?.textContent).toContain("Bağlayıcı Ekle");
    expect(panel.querySelector(".panel-foot")?.textContent).toContain("Bağlayıcıları Yönet");
  });

  it("search filters services", async () => {
    const h = await start();
    h.click(h.el("connectors-btn"));
    const search = h.doc.querySelector<HTMLInputElement>("#menu-layer .panel input")!;
    search.value = "git";
    search.dispatchEvent(new h.win.Event("input", { bubbles: true }));
    expect(Array.from(h.doc.querySelectorAll("#menu-layer .picker-name")).map((n) => n.textContent)).toEqual(["GitHub"]);
    search.value = "yokservis";
    search.dispatchEvent(new h.win.Event("input", { bubbles: true }));
    expect(h.doc.querySelector("#menu-layer .panel-empty")?.textContent).toBe("Sonuç bulunamadı.");
  });

  it("connection states move disconnected → pending → connected, then a connected service can be selected for tasks", async () => {
    const h = await start();
    h.click(h.el("connectors-btn"));
    const rowOf = () => h.doc.querySelector<HTMLElement>('#menu-layer [data-connector-id="slack"]')!;
    h.click(rowOf().querySelector<HTMLElement>(".picker-action"));
    expect(rowOf().querySelector(".picker-action")?.textContent).toBe("Onayla");
    expect(JSON.parse(h.storageText()!).connectors.find((c: { id: string }) => c.id === "slack").status).toBe("pending");
    h.click(rowOf().querySelector<HTMLElement>(".picker-action"));
    expect(rowOf().querySelector(".picker-action")).toBeNull();
    expect(rowOf().textContent).toContain("Bağlı");
    expect(rowOf().querySelector(".picker-row")?.getAttribute("aria-pressed")).toBe("false");
    h.click(rowOf().querySelector<HTMLElement>(".picker-row"));
    expect(rowOf().querySelector(".picker-row")?.getAttribute("aria-pressed")).toBe("true");
    h.outsideClick();
    expect(h.doc.querySelector("#chips")?.textContent).toContain("Slack");
    await sendTask(h, "Kanalı özetle");
    expect(h.calls.send[0]!.draft).toContain("Bağlam olarak seçilen bağlayıcılar: Slack.");
  });

  it("keeps keyboard focus on the same connector row after a state change", async () => {
    const h = await start();
    h.click(h.el("connectors-btn"));
    const action = h.doc.querySelector<HTMLElement>('#menu-layer [data-connector-id="vercel"] .picker-action')!;
    action.focus();
    h.click(action);
    expect(h.doc.activeElement?.closest("[data-connector-id]")?.getAttribute("data-connector-id")).toBe("vercel");
  });

  it("Bağlayıcı Ekle opens the Bağlayıcılar page with the add form focused; Bağlayıcıları Yönet opens the page", async () => {
    const h = await start();
    h.click(h.el("connectors-btn"));
    h.click(item(h, "Bağlayıcı Ekle"));
    expect(h.visibleViews()).toEqual(["connectors"]);
    expect(h.el("connector-add-form").hidden).toBe(false);
    expect(h.doc.activeElement?.id).toBe("connector-add-name");
    h.click(h.el("nav-new-task"));
    h.click(h.el("connectors-btn"));
    h.click(item(h, "Bağlayıcıları Yönet"));
    expect(h.visibleViews()).toEqual(["connectors"]);
    expect(h.doc.activeElement?.id).toBe("connectors-search");
  });

  it("the Bağlayıcılar page manages state, adds and removes a custom connector, and persists it", async () => {
    const h = await start();
    h.click(h.el("nav-connectors"));
    expect(h.doc.querySelectorAll("#connectors-page-list .row")).toHaveLength(7);
    const github = () => h.doc.querySelector<HTMLElement>('#connectors-page-list [data-connector-id="github"]')!;
    h.click(Array.from(github().querySelectorAll<HTMLElement>("button")).find((b) => b.textContent === "Bağlan")!);
    expect(github().querySelector(".badge")?.textContent).toBe("Yetkilendirme bekliyor");
    expect(github().querySelector(".pending-note")?.textContent).toContain("hesap yetkilendirmesi");
    h.click(Array.from(github().querySelectorAll<HTMLElement>("button")).find((b) => b.textContent === "Bağlantıyı onayla")!);
    expect(github().querySelector(".badge")?.textContent).toBe("Bağlı");
    h.click(Array.from(github().querySelectorAll<HTMLElement>("button")).find((b) => b.textContent === "Bağlantıyı kes")!);
    expect(github().querySelector(".badge")).toBeNull();

    h.click(h.el("connector-add-toggle"));
    h.el<HTMLInputElement>("connector-add-name").value = "Linear";
    h.el<HTMLInputElement>("connector-add-desc").value = "Görev takibi";
    h.el("connector-add-form").dispatchEvent(new h.win.Event("submit", { bubbles: true, cancelable: true }));
    expect(h.doc.querySelectorAll("#connectors-page-list .row")).toHaveLength(8);
    expect(h.el("connector-add-form").hidden).toBe(true);
    const second = await ready({ storage: h.storageText() });
    expect(second.doc.querySelector("#connectors-page-list")).not.toBeNull();
    second.click(second.el("nav-connectors"));
    expect(second.doc.querySelectorAll("#connectors-page-list .row")).toHaveLength(8);
    second.close();
    h.click(h.doc.querySelector<HTMLElement>('#connectors-page-list [aria-label="Linear bağlayıcısını kaldır"]'));
    expect(h.doc.querySelectorAll("#connectors-page-list .row")).toHaveLength(7);
  });

  it("disconnecting a connector removes it from the composer selection", async () => {
    const h = await start();
    h.click(h.el("nav-connectors"));
    const notion = () => h.doc.querySelector<HTMLElement>('#connectors-page-list [data-connector-id="notion"]')!;
    const press = (label: string) => h.click(Array.from(notion().querySelectorAll<HTMLElement>("button")).find((b) => b.textContent === label)!);
    press("Bağlan");
    press("Bağlantıyı onayla");
    press("Görevlerde kullan");
    h.click(h.el("nav-new-task"));
    expect(h.doc.querySelector("#chips")?.textContent).toContain("Notion");
    h.click(h.el("nav-connectors"));
    press("Bağlantıyı kes");
    h.click(h.el("nav-new-task"));
    expect(h.doc.querySelector("#chips")?.textContent).toBe("");
  });
});

describe("managers", () => {
  it("selecting a manager in the sidebar opens its detail, and making it the default shows it in the composer", async () => {
    const h = await start();
    h.click(h.el("tab-managers"));
    h.click(h.doc.querySelector<HTMLElement>('.manager-main[data-manager-id="vyron-helper"]'));
    expect(h.visibleViews()).toEqual(["manager"]);
    expect(h.el("page-title").textContent).toBe("Vyron Helper");
    expect(h.el("manager-detail").textContent).toContain("Vyron Code kullanımı");
    h.click(Array.from(h.doc.querySelectorAll<HTMLElement>("#manager-detail button")).find((b) => b.textContent === "Görevlerde varsayılan yap")!);
    expect(h.doc.querySelector('.manager-main[data-manager-id="vyron-helper"]')?.getAttribute("aria-pressed")).toBe("true");
    h.click(h.el("nav-new-task"));
    expect(h.doc.querySelector("#chips")?.textContent).toContain("Vyron Helper");
    h.click(h.el("plus-btn"));
    h.click(item(h, "SubAgent"));
    expect(item(h, "Vyron Helper").getAttribute("aria-checked")).toBe("true");
  });

  it("Bu manager ile görev başlat selects it and opens a new task", async () => {
    const h = await start();
    h.click(h.el("tab-managers"));
    h.click(h.doc.querySelector<HTMLElement>('.manager-main[data-manager-id="reviewer"]'));
    h.click(Array.from(h.doc.querySelectorAll<HTMLElement>("#manager-detail button")).find((b) => b.textContent === "Bu manager ile görev başlat")!);
    expect(h.visibleViews()).toEqual(["new-task"]);
    expect(h.doc.querySelector("#chips")?.textContent).toContain("Reviewer");
  });

  it("adds a custom manager, which appears in the sidebar and the SubAgent submenu, and can be deleted", async () => {
    const h = await start();
    h.click(h.el("tab-managers"));
    h.click(h.el("add-manager-btn"));
    const inputs = h.doc.querySelectorAll<HTMLInputElement>("#menu-layer input");
    inputs[0]!.value = "Yayıncı";
    inputs[1]!.value = "İçerik yayın planı hazırlar.";
    h.doc.querySelector("#menu-layer form")!.dispatchEvent(new h.win.Event("submit", { bubbles: true, cancelable: true }));
    expect(h.el("page-title").textContent).toBe("Yayıncı");
    expect(Array.from(h.doc.querySelectorAll("#manager-list .manager-name")).map((n) => n.textContent)).toContain("Yayıncı");
    h.click(h.el("nav-new-task"));
    h.click(h.el("plus-btn"));
    h.click(item(h, "SubAgent"));
    expect(h.menuLabels().join("|")).toContain("Yayıncı");
    h.outsideClick();
    h.click(h.doc.querySelector<HTMLElement>('.manager-main[data-manager-id^="manager-"]'));
    h.click(Array.from(h.doc.querySelectorAll<HTMLElement>("#manager-detail button")).find((b) => b.textContent === "Sil")!);
    expect(Array.from(h.doc.querySelectorAll("#manager-list .manager-name")).map((n) => n.textContent)).not.toContain("Yayıncı");
  });

  it("seeded managers cannot be deleted", async () => {
    const h = await start();
    h.click(h.el("tab-managers"));
    h.click(h.doc.querySelector<HTMLElement>('.manager-main[data-manager-id="genel"]'));
    expect(Array.from(h.doc.querySelectorAll<HTMLElement>("#manager-detail button")).some((b) => b.textContent === "Sil")).toBe(false);
  });
});

describe("web site management, settings and account", () => {
  it("the Web sitesi yönetimi page lists the verified Gymwolves site and can add, start a task for, and remove a site", async () => {
    const h = await start();
    h.click(h.el("nav-sites"));
    expect(h.doc.querySelector("#sites-list .row-desc")?.textContent).toBe("https://gymwolves.com.tr");
    h.el<HTMLInputElement>("site-add-name").value = "Örnek";
    h.el<HTMLInputElement>("site-add-address").value = "ornek.com";
    h.el("site-add-form").dispatchEvent(new h.win.Event("submit", { bubbles: true, cancelable: true }));
    expect(Array.from(h.doc.querySelectorAll("#sites-list .row-desc")).map((n) => n.textContent)).toEqual(["https://gymwolves.com.tr", "https://ornek.com"]);
    h.click(Array.from(h.doc.querySelectorAll<HTMLElement>("#sites-list .row")[1]!.querySelectorAll<HTMLElement>("button")).find((b) => b.textContent === "Görev başlat")!);
    expect(h.visibleViews()).toEqual(["new-task"]);
    expect(h.el<HTMLTextAreaElement>("task-input").value).toBe("Örnek (https://ornek.com) sitesi için: ");
    h.click(h.el("nav-sites"));
    h.click(h.doc.querySelector<HTMLElement>('#sites-list [aria-label="Örnek sitesini kaldır"]'));
    expect(h.doc.querySelectorAll("#sites-list .row")).toHaveLength(1);
  });

  it("rejects an invalid site address with a fixed message", async () => {
    const h = await start();
    h.click(h.el("nav-sites"));
    h.el<HTMLInputElement>("site-add-address").value = "javascript:alert(1)";
    h.el("site-add-form").dispatchEvent(new h.win.Event("submit", { bubbles: true, cancelable: true }));
    expect(h.el("site-add-error").hidden).toBe(false);
    expect(h.el("site-add-error").textContent).toBe("Geçerli bir web adresi yaz (örn. ornek.com).");
    expect(h.doc.querySelectorAll("#sites-list .row")).toHaveLength(1);
  });

  it("the account button opens the account menu with Ayarlar, Yerel AI durumu and the reset entry", async () => {
    const h = await start();
    h.click(h.el("account-btn"));
    expect(h.menuLabels().map((l) => l.replace(/Yerel AI hazır$/, ""))).toEqual(["Ayarlar", "Yerel AI durumu", "Çalışma alanını sıfırla"]);
    h.click(item(h, "Ayarlar"));
    expect(h.visibleViews()).toEqual(["settings"]);
  });

  it("the app menu offers Yeni görev, Yeni proje oluştur and collapse/expand of all projects", async () => {
    const h = await start();
    h.click(h.el("app-menu-btn"));
    expect(h.menuLabels()).toEqual(["Yeni görev", "Yeni proje oluştur", "Tüm projeleri daralt", "Tüm projeleri genişlet"]);
    h.click(item(h, "Tüm projeleri daralt"));
    expect(Array.from(h.doc.querySelectorAll<HTMLElement>(".project-group")).every((g) => g.dataset.expanded === "false")).toBe(true);
    h.click(h.el("app-menu-btn"));
    h.click(item(h, "Tüm projeleri genişlet"));
    expect(Array.from(h.doc.querySelectorAll<HTMLElement>(".project-group")).every((g) => g.dataset.expanded === "true")).toBe(true);
  });

  it("resetting the workspace needs an explicit confirmation and restores the seeded workspace", async () => {
    const h = await start();
    h.click(h.el("add-project-btn"));
    h.doc.querySelector<HTMLInputElement>("#menu-layer input")!.value = "Geçici";
    h.doc.querySelector("#menu-layer form")!.dispatchEvent(new h.win.Event("submit", { bubbles: true, cancelable: true }));
    expect(h.doc.querySelectorAll("#project-list .project-name")).toHaveLength(4);
    h.click(h.el("settings-btn"));
    expect(h.el("settings-reset-confirm").hidden).toBe(true);
    h.click(h.el("settings-reset-btn"));
    expect(h.el("settings-reset-confirm").hidden).toBe(false);
    h.click(h.el("settings-reset-cancel"));
    expect(h.doc.querySelectorAll("#project-list .project-name")).toHaveLength(4);
    h.click(h.el("settings-reset-btn"));
    h.click(h.el("settings-reset-confirm"));
    expect(h.doc.querySelectorAll("#project-list .project-name")).toHaveLength(3);
    expect(h.visibleViews()).toEqual(["new-task"]);
  });

  it("the compact-sidebar setting is wired to the sidebar", async () => {
    const h = await start();
    h.click(h.el("settings-btn"));
    const box = h.el<HTMLInputElement>("settings-compact");
    box.checked = true;
    box.dispatchEvent(new h.win.Event("change", { bubbles: true }));
    expect(h.el("app").dataset.sidebar).toBe("collapsed");
  });
});

describe("menus: outside click, Escape, focus, keyboard and exclusivity", () => {
  it("clicking outside closes an open menu without stealing focus", async () => {
    const h = await start();
    h.click(h.el("plus-btn"));
    expect(h.openMenus()).toHaveLength(1);
    h.outsideClick();
    expect(h.openMenus()).toHaveLength(0);
    expect(h.el("plus-btn").getAttribute("aria-expanded")).toBe("false");
  });

  it("Escape closes the menu and returns focus to its trigger", async () => {
    const h = await start();
    h.click(h.el("mode-btn"));
    expect(h.doc.activeElement?.className).toContain("menu-item");
    h.key(h.doc.activeElement!, "Escape");
    expect(h.openMenus()).toHaveLength(0);
    expect(h.doc.activeElement).toBe(h.el("mode-btn"));
  });

  it("Escape from a submenu closes only the submenu and refocuses its parent item; a second Escape closes the menu", async () => {
    const h = await start();
    h.click(h.el("plus-btn"));
    h.click(item(h, "Plan"));
    expect(h.openMenus()).toHaveLength(2);
    h.key(h.doc.activeElement ?? h.doc.body, "Escape");
    expect(h.openMenus().length).toBe(1);
    h.key(h.doc.activeElement!, "Escape");
    expect(h.openMenus()).toHaveLength(0);
    expect(h.doc.activeElement).toBe(h.el("plus-btn"));
  });

  it("opening one sibling menu closes the others, and clicking the trigger again toggles it shut", async () => {
    const h = await start();
    h.click(h.el("plus-btn"));
    h.click(h.el("skills-btn"));
    expect(h.openMenus()).toHaveLength(1);
    expect(h.el("plus-btn").getAttribute("aria-expanded")).toBe("false");
    expect(h.el("skills-btn").getAttribute("aria-expanded")).toBe("true");
    h.click(h.el("connectors-btn"));
    expect(h.openMenus()).toHaveLength(1);
    expect(h.el("skills-btn").getAttribute("aria-expanded")).toBe("false");
    h.click(h.el("connectors-btn"));
    expect(h.openMenus()).toHaveLength(0);
  });

  it("arrow keys move focus through menu items; Home and End jump to the ends", async () => {
    const h = await start();
    h.click(h.el("plus-btn"));
    const items = Array.from(h.doc.querySelectorAll<HTMLElement>("#menu-layer .menu-item"));
    expect(h.doc.activeElement).toBe(items[0]);
    h.key(h.doc.activeElement!, "ArrowDown");
    expect(h.doc.activeElement).toBe(items[1]);
    h.key(h.doc.activeElement!, "ArrowDown");
    h.key(h.doc.activeElement!, "ArrowDown");
    h.key(h.doc.activeElement!, "ArrowDown");
    expect(h.doc.activeElement).toBe(items[3]);
    h.key(h.doc.activeElement!, "ArrowUp");
    expect(h.doc.activeElement).toBe(items[2]);
    h.key(h.doc.activeElement!, "Home");
    expect(h.doc.activeElement).toBe(items[0]);
    h.key(h.doc.activeElement!, "End");
    expect(h.doc.activeElement).toBe(items[3]);
  });

  it("in a picker, ArrowDown goes from search into the list and ArrowUp returns to the search", async () => {
    const h = await start();
    h.click(h.el("skills-btn"));
    const search = h.doc.querySelector<HTMLInputElement>("#menu-layer .panel input")!;
    expect(h.doc.activeElement).toBe(search);
    h.key(search, "ArrowDown");
    expect(h.doc.activeElement?.className).toContain("picker-row");
    h.key(h.doc.activeElement!, "ArrowUp");
    expect(h.doc.activeElement).toBe(search);
    h.key(search, "Escape");
    expect(h.openMenus()).toHaveLength(0);
    expect(h.doc.activeElement).toBe(h.el("skills-btn"));
  });

  it("menu items have correct roles, and radio items carry aria-checked", async () => {
    const h = await start();
    h.click(h.el("mode-btn"));
    expect(h.doc.querySelector("#menu-layer .menu")?.getAttribute("role")).toBe("menu");
    for (const node of Array.from(h.doc.querySelectorAll("#menu-layer .menu-item"))) {
      expect(node.getAttribute("role")).toBe("menuitemradio");
      expect(["true", "false"]).toContain(node.getAttribute("aria-checked"));
    }
    h.outsideClick();
    h.click(h.el("plus-btn"));
    for (const node of Array.from(h.doc.querySelectorAll("#menu-layer .menu-item"))) expect(node.getAttribute("role")).toBe("menuitem");
  });

  it("Tab closes an open menu", async () => {
    const h = await start();
    h.click(h.el("plus-btn"));
    h.key(h.doc.activeElement!, "Tab");
    expect(h.openMenus()).toHaveLength(0);
  });

  it("navigating to another view closes any open menu", async () => {
    const h = await start();
    h.click(h.el("plus-btn"));
    h.click(h.el("nav-skills"));
    expect(h.openMenus()).toHaveLength(0);
  });

  it("menus are positioned inside the viewport (collision handling clamps to the window)", async () => {
    const h = await start();
    Object.defineProperty(h.win, "innerWidth", { value: 400, configurable: true });
    Object.defineProperty(h.win, "innerHeight", { value: 300, configurable: true });
    h.el("plus-btn").getBoundingClientRect = () => ({ left: 390, right: 420, top: 290, bottom: 320, width: 30, height: 30, x: 390, y: 290, toJSON() {} }) as DOMRect;
    h.click(h.el("plus-btn"));
    const menu = h.doc.querySelector<HTMLElement>("#menu-layer .menu")!;
    Object.defineProperty(menu, "offsetWidth", { value: 220, configurable: true });
    const left = parseInt(menu.style.left, 10);
    const top = parseInt(menu.style.top, 10);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left).toBeLessThanOrEqual(400);
    expect(top).toBeGreaterThanOrEqual(8);
  });
});

describe("removed review flow and static page contract", () => {
  const forbidden = ["Taslağı incele", "Göndermeden önce incele", "Hermes'e gönderilecek metin", "İncelenen task'ı gönder", "review_ready", "reviewTaskDraft", "sendReviewedTask", "task-review", "Geri dön"];

  it("no review screen, string, handler or bridge method remains in the page, the model or the renderer", () => {
    for (const text of [html, rendererSource, modelSource]) {
      for (const word of forbidden) expect(text, "must not contain: " + word).not.toContain(word);
    }
  });

  it("the old review markup ids and the security checklist are gone", () => {
    for (const id of ["task-review-btn", "task-review-back-btn", "task-send-btn", "task-review-text", "view-review", "task-draft-hint"]) {
      expect(html).not.toContain('id="' + id + '"');
    }
  });

  it("the page has exactly one multi-line task field and only the expected other inputs", () => {
    expect(html.match(/<textarea\b/g)).toHaveLength(1);
    const inputs = [...html.matchAll(/<input\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
    expect(inputs).toEqual([
      "sidebar-search-input",
      "file-input",
      "skills-search",
      "connectors-search",
      "connector-add-name",
      "connector-add-desc",
      "site-add-name",
      "site-add-address",
      "settings-compact",
    ]);
    expect(html).not.toMatch(/type="password"|contenteditable|<select\b/i);
  });

  it("shows no endpoint, key, provider, port or path in the page text", () => {
    const visible = html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<[^>]+>/g, " ")
      .toLowerCase();
    for (const word of ["endpoint", "api key", "api anahtar", "127.0.0.1", "localhost", "8642", "8643", "token"]) expect(visible).not.toContain(word);
  });

  it("keeps the strict CSP and loads only its own local scripts and stylesheet", () => {
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("script-src 'self'");
    expect(html).toContain("style-src 'self'");
    expect(html).toContain('<script src="workspace-model.js"></script>');
    expect(html).toContain('<script src="renderer.js"></script>');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\sstyle="/);
  });

  it("the renderer never uses innerHTML, network, eval, clipboard or a string timer", () => {
    const code = rendererSource.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const pattern of [/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser/, /\bfetch\(|XMLHttpRequest|WebSocket|EventSource/, /\beval\(|new Function\(/, /setTimeout\(\s*["'`]/, /navigator\.clipboard/, /sessionStorage|indexedDB|document\.cookie/]) {
      expect(code).not.toMatch(pattern);
    }
  });

  it("the renderer talks to the main process through exactly the six fixed bridge methods", () => {
    const calls = new Set([...rendererSource.matchAll(/api\.(localAi|hermes)\.(\w+)\(/g)].map((m) => `${m[1]}.${m[2]}`));
    expect(calls).toEqual(
      new Set(["localAi.getLocalAiState", "localAi.retryLocalAiStartup", "localAi.copyLocalAiDiagnostics", "hermes.sendTask", "hermes.clearTaskSubmission"]),
    );
  });

  it("both page scripts are classic scripts (no top-level import or export)", () => {
    for (const text of [rendererSource, modelSource]) {
      expect(text).not.toMatch(/^import\s/m);
      expect(text).not.toMatch(/^export\s/m);
    }
  });

  it("the sidebar, composer and menus have visible focus styling and reduced-motion support", () => {
    const css = fs.readFileSync(path.join(__dirname, "..", "electron", "renderer.css"), "utf8");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("prefers-reduced-motion");
    expect(css).not.toMatch(/https?:\/\/|@import|url\(/);
  });
});

describe("responsive layout rules", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "electron", "renderer.css"), "utf8");

  it("collapses the sidebar into a compact rail on narrow windows and shrinks the hero on short ones", () => {
    expect(css).toMatch(/@media \(max-width: 860px\)[\s\S]*--sidebar-w: 56px/);
    expect(css).toMatch(/@media \(max-width: 720px\)/);
    expect(css).toMatch(/@media \(max-height: 640px\)/);
  });

  it("main content cannot overflow horizontally and the page body does not scroll", () => {
    expect(css).toMatch(/body\s*\{[^}]*overflow:\s*hidden/);
    expect(css).toMatch(/\.main\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.composer-wrap\s*\{[^}]*max-width:\s*820px/);
    expect(css).toMatch(/\.sb-scroll\s*\{[^}]*overflow-y:\s*auto/);
  });

  it("menus are fixed-position and capped to the viewport width", () => {
    expect(css).toMatch(/\.menu, \.panel\s*\{[^}]*position:\s*fixed/);
    expect(css).toMatch(/max-width:\s*min\(360px, calc\(100vw - 16px\)\)/);
  });
});
