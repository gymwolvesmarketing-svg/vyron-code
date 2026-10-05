/**
 * The real agent browser window - VYRON_CODE_APPROVED_TOOLS (browser actions). Main process only.
 *
 * A separate, VISIBLE Electron window (titled so the user always knows the AI is using it), never the app's own window:
 *   - hardened web preferences (no Node, sandboxed, context isolation, no preload), so a web page can reach nothing of the app;
 *   - its own persistent session partition: the user can log in to a site by hand once and the AI then works in that
 *     session, but nothing is shared with the app window or the user's real Chrome;
 *   - every permission request (camera, microphone, geolocation, notifications...) and every download is refused;
 *   - every request, redirects and sub-resources included, is checked: only http(s)/ws(s) plus inline data:/blob:/about:blank
 *     are allowed, and a host that is (or resolves to) a loopback / private-network address is cancelled, so a page can
 *     never reach Hermes, OmniRoute or the user's LAN;
 *   - new-window requests open in the same window instead of spawning more windows.
 * The driver (electron/browserTool.ts) is the only caller and only ever passes validated values.
 */
import { BrowserWindow, session } from "electron";
import { HARDENED_WEB_PREFERENCES } from "./security-policy";
import { isBlockedBrowserHost, isPrivateAddress } from "./toolPolicy";
import type { BrowserPage } from "./browserTool";

const PARTITION = "persist:vyron-agent-browser";
const WINDOW_TITLE = "Vyron Tarayıcı — yapay zeka bu pencereyi kullanıyor";
const LOAD_TIMEOUT_MS = 25_000;
const SCRIPT_TIMEOUT_MS = 10_000;
const VERDICT_TTL_MS = 5 * 60_000;

const verdicts = new Map<string, { blocked: boolean; at: number }>();
let configured = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(work: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(reason)), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** True when a request must be cancelled: wrong scheme, a private host name, or a name that resolves to a private address. */
async function isBlockedRequest(rawUrl: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return true;
  }
  const protocol = url.protocol;
  if (protocol === "data:" || protocol === "blob:" || protocol === "about:") return false;
  if (protocol !== "http:" && protocol !== "https:" && protocol !== "ws:" && protocol !== "wss:") return true;
  const host = url.hostname;
  if (isBlockedBrowserHost(host)) return true;
  // IP literals were fully judged above; a name is judged by what it resolves to (cached for a few minutes).
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.charAt(0) === "[") return false;
  const cached = verdicts.get(host);
  if (cached && Date.now() - cached.at < VERDICT_TTL_MS) return cached.blocked;
  let blocked = false;
  try {
    const resolved = await session.fromPartition(PARTITION).resolveHost(host);
    blocked = resolved.endpoints.some((endpoint) => isPrivateAddress(endpoint.address));
  } catch {
    blocked = false; // an unresolvable name simply fails to load by itself
  }
  verdicts.set(host, { blocked, at: Date.now() });
  return blocked;
}

function configureSession(): void {
  if (configured) return;
  configured = true;
  const ses = session.fromPartition(PARTITION);
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on("will-download", (event) => event.preventDefault());
  ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    isBlockedRequest(details.url).then(
      (blocked) => callback({ cancel: blocked }),
      () => callback({ cancel: true }),
    );
  });
}

export function createElectronBrowserPage(): BrowserPage {
  configureSession();
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    title: WINDOW_TITLE,
    autoHideMenuBar: true,
    webPreferences: { ...HARDENED_WEB_PREFERENCES, partition: PARTITION },
  });
  const contents = win.webContents;
  contents.on("page-title-updated", (event) => event.preventDefault());
  contents.on("will-navigate", (event, target) => {
    if (!/^https?:/i.test(target)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !win.isDestroyed()) void win.loadURL(url).catch(() => undefined);
    return { action: "deny" };
  });

  return {
    isClosed: () => win.isDestroyed(),
    async load(url) {
      try {
        await withTimeout(win.loadURL(url), LOAD_TIMEOUT_MS, "zaman aşımı");
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        // A superseded navigation reports ERR_ABORTED although a page did load.
        if (/ERR_ABORTED/.test(message) && contents.getURL().length > 0) return;
        throw new Error(message.replace(/^.*?ERR_/, "ERR_").slice(0, 80) || "yüklenemedi");
      }
    },
    async run(script) {
      return withTimeout(contents.executeJavaScript(script, true), SCRIPT_TIMEOUT_MS, "sayfa betiği zaman aşımına uğradı");
    },
    url: () => (win.isDestroyed() ? "" : contents.getURL()),
    async settle() {
      await sleep(700);
      const deadline = Date.now() + 15_000;
      while (!win.isDestroyed() && contents.isLoading() && Date.now() < deadline) await sleep(200);
      await sleep(300);
    },
    close() {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
