import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({
  userData: "",
  root: null as string | null,
  responses: [] as number[],
  dialogs: [] as Array<{ title?: string; message?: string; detail?: string; buttons?: string[]; defaultId?: number; cancelId?: number }>,
  throwOnDialog: false,
  picked: 0,
  restored: [] as string[],
}));

vi.mock("electron", () => ({
  clipboard: { writeText: () => undefined },
  app: { getPath: () => state.userData },
  dialog: {
    showMessageBox: async (...args: unknown[]) => {
      const options = (args.length === 2 ? args[1] : args[0]) as (typeof state.dialogs)[number];
      state.dialogs.push(options);
      if (state.throwOnDialog) throw new Error("dialog failed");
      return { response: state.responses.shift() ?? 2 };
    },
  },
}));

vi.mock("../electron/workspace-grant", () => ({
  getCurrentCanonicalRoot: () => state.root,
  getCurrent: () => (state.root ? { state: "granted", displayName: path.basename(state.root) } : { state: "no_workspace", displayName: null }),
  pickDirectory: async () => {
    state.picked += 1;
    return { state: "granted" };
  },
  clearCurrent: () => {
    state.root = null;
  },
  restoreGrant: (stored: string) => {
    state.restored.push(stored);
    state.root = fs.existsSync(stored) ? stored : null;
    return { state: state.root ? "granted" : "no_workspace" };
  },
}));

import { PERMISSIONS_FILE, PROJECT_FOLDERS_FILE, createPermissionStore, createProductionToolRunner, createProjectFolderStore, isProjectId, workspaceKey } from "../electron/toolAdapters";
import type { ChatMessage } from "../electron/toolPolicy";

let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "vyron-adapters-"));
  state.userData = path.join(base, "userdata");
  fs.mkdirSync(path.join(base, "ws"));
  state.root = fs.realpathSync.native(path.join(base, "ws"));
  state.responses = [];
  state.dialogs = [];
  state.throwOnDialog = false;
  state.picked = 0;
  state.restored = [];
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function scripted(replies: string[]) {
  let i = 0;
  const seen: ChatMessage[][] = [];
  return {
    seen,
    ask: async (messages: readonly ChatMessage[]) => {
      seen.push(messages.slice());
      return i < replies.length ? (replies[i++] as string) : "SON";
    },
  };
}

const WRITE = '{"tool":"write_file","path":"a.txt","content":"merhaba"}';

describe("permission store", () => {
  it("saves, counts, clears and survives a restart; a corrupt file reads as empty", () => {
    const file = path.join(base, "p.json");
    const store = createPermissionStore(file);
    expect(store.count()).toBe(0);
    store.add("write|abc");
    store.add("run|abc|npm test");
    store.add("write|abc");
    expect(store.count()).toBe(2);
    expect(createPermissionStore(file).has("run|abc|npm test")).toBe(true);
    expect(createPermissionStore(file).has("run|abc|npm test && calc")).toBe(false);
    expect(store.clear()).toBe(2);
    expect(createPermissionStore(file).count()).toBe(0);
    fs.writeFileSync(file, "{not json");
    expect(createPermissionStore(file).count()).toBe(0);
    fs.writeFileSync(file, JSON.stringify({ version: 9, keys: ["x"] }));
    expect(createPermissionStore(file).count()).toBe(0);
    fs.writeFileSync(file, JSON.stringify({ version: 1, keys: ["ok", 5, null, "y".repeat(2000)] }));
    expect(createPermissionStore(file).count()).toBe(1);
  });

  it("scopes a workspace key to the folder and never contains the path", () => {
    const a = workspaceKey("C:\\Work\\Proje");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(workspaceKey("c:\\work\\proje")).toBe(a);
    expect(workspaceKey("C:\\Work\\Other")).not.toBe(a);
    expect(a.toLowerCase()).not.toContain("proje");
  });
});

describe("approval dialog and tool runner", () => {
  it("asks natively with exactly three buttons (Reddet is default), runs on 'Bir kez', and asks again next time", async () => {
    const runner = createProductionToolRunner(() => null);
    state.responses = [0, 0];
    const first = scripted([WRITE, "Bitti"]);
    const result = await runner.run("g", first.ask);
    expect(state.dialogs).toHaveLength(1);
    expect(state.dialogs[0]!.buttons).toEqual(["Bir kez izin ver", "Her zaman izin ver", "Reddet"]);
    expect(state.dialogs[0]!.defaultId).toBe(2);
    expect(state.dialogs[0]!.cancelId).toBe(2);
    expect(state.dialogs[0]!.message).toContain('"ws"');
    expect(state.dialogs[0]!.detail).toContain("Yeni dosya: a.txt");
    expect(JSON.stringify(state.dialogs)).not.toContain(base);
    expect(fs.readFileSync(path.join(state.root as string, "a.txt"), "utf8")).toBe("merhaba");
    expect(result.ok && result.text).toContain("✓ yazma a.txt");
    await runner.run("g", scripted([WRITE, "Bitti"]).ask);
    expect(state.dialogs).toHaveLength(2);
    expect(runner.getWorkspace().alwaysCount).toBe(0);
  });

  it("refuses on 'Reddet', on closing the dialog, and when the dialog fails; nothing is written", async () => {
    const runner = createProductionToolRunner(() => null);
    state.responses = [2];
    let result = await runner.run("g", scripted([WRITE, "Bitti"]).ask);
    expect(fs.existsSync(path.join(state.root as string, "a.txt"))).toBe(false);
    expect(result.ok && result.text).toContain("✗ reddedildi: yazma a.txt");
    state.responses = [99];
    await runner.run("g", scripted([WRITE, "Bitti"]).ask);
    expect(fs.existsSync(path.join(state.root as string, "a.txt"))).toBe(false);
    state.throwOnDialog = true;
    result = await runner.run("g", scripted([WRITE, "Bitti"]).ask);
    expect(fs.existsSync(path.join(state.root as string, "a.txt"))).toBe(false);
    expect(result.ok && result.text).toContain("✗ reddedildi");
  });

  it("'Her zaman izin ver' is remembered per folder for writes, and per exact text for commands, and can be reset", async () => {
    const runner = createProductionToolRunner(() => null);
    state.responses = [1];
    await runner.run("g", scripted([WRITE, "Bitti"]).ask);
    expect(runner.getWorkspace().alwaysCount).toBe(1);
    expect(fs.existsSync(path.join(base, "userdata", PERMISSIONS_FILE))).toBe(true);
    await runner.run("g", scripted(['{"tool":"write_file","path":"b.txt","content":"x"}', "Bitti"]).ask);
    expect(state.dialogs).toHaveLength(1);
    expect(fs.existsSync(path.join(state.root as string, "b.txt"))).toBe(true);

    state.responses = [1];
    await runner.run("g", scripted(['{"tool":"run_command","command":"echo bir"}', "Bitti"]).ask);
    expect(state.dialogs).toHaveLength(2);
    await runner.run("g", scripted(['{"tool":"run_command","command":"echo bir"}', "Bitti"]).ask);
    expect(state.dialogs).toHaveLength(2);
    state.responses = [2];
    await runner.run("g", scripted(['{"tool":"run_command","command":"echo iki"}', "Bitti"]).ask);
    expect(state.dialogs).toHaveLength(3);

    fs.mkdirSync(path.join(base, "ws2"));
    state.root = fs.realpathSync.native(path.join(base, "ws2"));
    state.responses = [2];
    await runner.run("g", scripted([WRITE, "Bitti"]).ask);
    expect(state.dialogs).toHaveLength(4);

    expect(runner.getWorkspace().alwaysCount).toBe(2);
    expect(runner.clearPermissions().alwaysCount).toBe(0);
    state.responses = [2];
    state.root = fs.realpathSync.native(path.join(base, "ws"));
    await runner.run("g", scripted([WRITE, "Bitti"]).ask);
    expect(state.dialogs).toHaveLength(5);
  });

  it("reads and lists without any dialog, and never asks for something the policy refuses", async () => {
    const runner = createProductionToolRunner(() => null);
    fs.writeFileSync(path.join(state.root as string, "oku.txt"), "içerik");
    const result = await runner.run("g", scripted(['{"tool":"read_file","path":"oku.txt"}', '{"tool":"read_file","path":".env"}', "Bitti"]).ask);
    expect(state.dialogs).toHaveLength(0);
    expect(result.ok && result.text).toContain("✓ okuma oku.txt");
    expect(result.ok && result.text).toContain("! başarısız: okuma .env");
  });

  it("with no folder chosen, tools do nothing and say so", async () => {
    state.root = null;
    const runner = createProductionToolRunner(() => null);
    const result = await runner.run("g", scripted([WRITE, "Bitti"]).ask);
    expect(state.dialogs).toHaveLength(0);
    expect(result.ok && result.text).toContain("çalışma klasörü seçili değil");
  });

  it("the workspace info exposes only the folder name and a count, and the folder can be picked and removed", async () => {
    const runner = createProductionToolRunner(() => ({}) as never);
    expect(Object.keys(runner.getWorkspace()).sort()).toEqual(["alwaysCount", "folderName"]);
    expect(runner.getWorkspace().folderName).toBe("ws");
    expect(JSON.stringify(runner.getWorkspace())).not.toContain(base);
    await runner.pickWorkspace();
    expect(state.picked).toBe(1);
    expect(runner.clearWorkspace().folderName).toBeNull();
  });
});

describe("project folders (each project remembers its own folder)", () => {
  it("accepts only plain slug ids", () => {
    for (const good of ["aetheris", "project-lxyz-1abc", "a1"]) expect(isProjectId(good)).toBe(true);
    for (const bad of ["", "A", "../x", "a b", "-a", 5, null, undefined, "x".repeat(81)]) expect(isProjectId(bad)).toBe(false);
  });

  it("stores, forgets and survives a restart; a corrupt or hostile file reads as empty", () => {
    const file = path.join(base, PROJECT_FOLDERS_FILE);
    const store = createProjectFolderStore(file);
    expect(store.get("aetheris")).toBeNull();
    store.set("aetheris", "C:\\dizin\\a");
    store.set("b", "C:\\dizin\\b");
    expect(createProjectFolderStore(file).get("aetheris")).toBe("C:\\dizin\\a");
    store.remove("aetheris");
    expect(createProjectFolderStore(file).get("aetheris")).toBeNull();
    expect(createProjectFolderStore(file).get("b")).toBe("C:\\dizin\\b");
    fs.writeFileSync(file, "{not json", "utf8");
    expect(createProjectFolderStore(file).get("b")).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: 1, roots: { "../evil": "C:\\x", ok: 5, fine: "C:\\y" } }), "utf8");
    const hostile = createProjectFolderStore(file);
    expect(hostile.get("../evil")).toBeNull();
    expect(hostile.get("ok")).toBeNull();
    expect(hostile.get("fine")).toBe("C:\\y");
  });

  it("opening a project restores its remembered folder, another project has none, removing forgets it", () => {
    const runner = createProductionToolRunner(() => null as never);
    const granted = state.root as string;
    const stored = createProjectFolderStore(path.join(state.userData, PROJECT_FOLDERS_FILE));
    stored.set("aetheris", granted);
    state.root = null;
    expect(runner.getWorkspace("aetheris").folderName).not.toBeNull();
    expect(state.restored).toEqual([granted]);
    expect(runner.getWorkspace("hangikargoo").folderName).toBeNull();
    expect(runner.getWorkspace("aetheris").folderName).not.toBeNull();
    // Not a project id (or none): the grant is left alone.
    expect(runner.getWorkspace("../x").folderName).not.toBeNull();
    expect(runner.getWorkspace().folderName).not.toBeNull();
    expect(runner.clearWorkspace("aetheris").folderName).toBeNull();
    expect(createProjectFolderStore(path.join(state.userData, PROJECT_FOLDERS_FILE)).get("aetheris")).toBeNull();
    expect(runner.getWorkspace("aetheris").folderName).toBeNull();
  });
});
