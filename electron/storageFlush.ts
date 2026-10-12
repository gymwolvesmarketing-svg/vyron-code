/**
 * Keeps the page's localStorage on disk. The workspace (projects, tasks, conversations) lives there; Chromium commits it after a
 * delay and rate-limits the commits, so an edit made shortly before the app closes (a deleted project) could be lost and come
 * back on the next start. The flush runs every few seconds and on demand (window close, before-quit). It never quits or
 * restarts anything. Dependency-injected so it can be tested without Electron.
 */
export interface FlushableSession {
  flushStorageData(): void;
}

export const STORAGE_FLUSH_INTERVAL_MS = 3_000;

export function createStorageFlusher(getSession: () => FlushableSession | null | undefined): { flush(): void; start(): () => void } {
  const flush = (): void => {
    try {
      getSession()?.flushStorageData();
    } catch {
      // The session may not exist yet (or is shutting down); the next call tries again.
    }
  };
  return {
    flush,
    start(): () => void {
      const timer = setInterval(flush, STORAGE_FLUSH_INTERVAL_MS);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
