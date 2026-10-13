import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { NOTIFICATION_COOLDOWN_MS, createNotifier, kindForResult } from "../electron/notifications";

function setup(inFront: boolean) {
  const shown: Array<{ title: string; body: string }> = [];
  const clock = { t: 1_000_000 };
  const state = { inFront };
  const notifier = createNotifier({ isAppInFront: () => state.inFront, show: (title, body) => shown.push({ title, body }), now: () => clock.t });
  return { notifier, shown, clock, state };
}

describe("kindForResult", () => {
  it("maps a finished send to the notification it deserves", () => {
    expect(kindForResult("completed", "Tamam.")).toBe("done");
    expect(kindForResult("completed", "Adım sınırına ulaşıldı; iş yarım kaldı.")).toBe("half");
    expect(kindForResult("completed", null)).toBe("done");
    for (const bad of ["safe_failure", "unavailable", "unauthorized"]) expect(kindForResult(bad, null)).toBe("failed");
    for (const quiet of ["sending", "cancelled", "idle"]) expect(kindForResult(quiet, null)).toBeNull();
  });
});

describe("createNotifier", () => {
  it("shows a notification only while the app is not in front", () => {
    const front = setup(true);
    front.notifier.taskFinished("completed", "x");
    front.notifier.approvalNeeded();
    expect(front.shown).toHaveLength(0);
    const away = setup(false);
    away.notifier.taskFinished("completed", "x");
    expect(away.shown).toHaveLength(1);
    expect(away.shown[0]!.title).toContain("görev tamamlandı");
  });

  it("never puts task content in the text: only fixed wording, whatever the answer says", () => {
    const { notifier, shown } = setup(false);
    notifier.taskFinished("completed", "SECRET-PLAN: C:\\Users\\onurk\\gizli.txt parola=123");
    notifier.approvalNeeded();
    for (const n of shown) {
      expect(n.title + n.body).not.toContain("SECRET");
      expect(n.title + n.body).not.toContain("gizli");
    }
    expect(shown.map((n) => n.title)).toEqual(["Vyron Code — görev tamamlandı", "Vyron Code — senden izin bekleniyor"]);
  });

  it("says 'half done' and 'failed' for those outcomes", () => {
    const { notifier, shown, clock } = setup(false);
    notifier.taskFinished("completed", "Model yanıt vermeyi bıraktı; iş yarım kaldı.");
    clock.t += NOTIFICATION_COOLDOWN_MS + 1;
    notifier.taskFinished("safe_failure", null);
    expect(shown.map((n) => n.title)).toEqual(["Vyron Code — görev yarım kaldı", "Vyron Code — görev tamamlanamadı"]);
  });

  it("does not repeat the same kind inside the cooldown, but different kinds and later repeats go through", () => {
    const { notifier, shown, clock } = setup(false);
    notifier.approvalNeeded();
    notifier.approvalNeeded();
    notifier.taskFinished("completed", "x");
    expect(shown).toHaveLength(2);
    clock.t += NOTIFICATION_COOLDOWN_MS + 1;
    notifier.approvalNeeded();
    expect(shown).toHaveLength(3);
  });

  it("a failing show() never throws into the task", () => {
    const notifier = createNotifier({ isAppInFront: () => false, show: () => { throw new Error("no toast"); } });
    expect(() => notifier.taskFinished("completed", "x")).not.toThrow();
    expect(() => notifier.approvalNeeded()).not.toThrow();
  });
});

describe("wiring", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.ts"), "utf8");
  const adapters = fs.readFileSync(path.join(__dirname, "..", "electron", "toolAdapters.ts"), "utf8");
  it("main notifies after a send and before a permission dialog, with the installed app's id", () => {
    expect(main).toContain("notifier.taskFinished(result.state, result.text)");
    expect(main).toContain("notifier.approvalNeeded()");
    expect(main).toContain('app.setAppUserModelId("com.vyron.code")');
    expect(fs.readFileSync(path.join(__dirname, "..", "electron-builder.yml"), "utf8")).toContain("appId: com.vyron.code");
    expect(adapters).toMatch(/onApprovalNeeded\?\.\(\);\s*const window = getWindow\(\);/);
  });
});
