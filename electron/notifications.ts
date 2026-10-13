/**
 * Desktop notifications for the moments the user is needed: a task finished, a task stopped half way or failed, a permission is
 * waiting. Shown only while the app window is NOT in front (when it is, the user already sees it). The text is generic: a task's
 * content, file names or commands never leave the app window. The same kind is not repeated within a short cooldown.
 * Dependency-injected (no Electron here), so it is tested without a desktop.
 */
export interface NotifierDeps {
  /** True when the app window is visible, not minimized and focused. */
  isAppInFront(): boolean;
  show(title: string, body: string): void;
  now?(): number;
}

export type NotificationKind = "done" | "half" | "failed" | "approval";

export const NOTIFICATION_COOLDOWN_MS = 8_000;

const TEXT: Readonly<Record<NotificationKind, { title: string; body: string }>> = {
  done: { title: "Vyron Code — görev tamamlandı", body: "Yanıtı görmek için Vyron Code'a dön." },
  half: { title: "Vyron Code — görev yarım kaldı", body: "Kaldığı yerden sürdürmek için 'Devam et'e basabilirsin." },
  failed: { title: "Vyron Code — görev tamamlanamadı", body: "Bir hata oldu; ayrıntı için Vyron Code'a dön." },
  approval: { title: "Vyron Code — senden izin bekleniyor", body: "Bir dosya yazma ya da komut çalıştırma izni bekliyor." },
};

/** Which notification a finished send deserves: null when it was cancelled or is still going on. */
export function kindForResult(state: string, text: string | null): NotificationKind | null {
  if (state === "completed") return typeof text === "string" && text.indexOf("iş yarım kaldı") >= 0 ? "half" : "done";
  if (state === "safe_failure" || state === "unavailable" || state === "unauthorized") return "failed";
  return null;
}

export function createNotifier(deps: NotifierDeps): {
  taskFinished(state: string, text: string | null): void;
  approvalNeeded(): void;
} {
  const lastShown = new Map<NotificationKind, number>();
  const now = deps.now ?? (() => Date.now());

  function notify(kind: NotificationKind): void {
    try {
      if (deps.isAppInFront()) return;
      const at = now();
      const previous = lastShown.get(kind);
      if (previous !== undefined && at - previous < NOTIFICATION_COOLDOWN_MS) return;
      lastShown.set(kind, at);
      deps.show(TEXT[kind].title, TEXT[kind].body);
    } catch {
      // A notification that cannot be shown must never disturb the task.
    }
  }

  return {
    taskFinished(state, text) {
      const kind = kindForResult(state, text);
      if (kind !== null) notify(kind);
    },
    approvalNeeded() {
      notify("approval");
    },
  };
}
