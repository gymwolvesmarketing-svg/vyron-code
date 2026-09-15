import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock "electron"'s dialog so pickDirectory() can be tested without a real Electron runtime
// or a real native dialog. `vi.mock` factories are hoisted above ordinary top-level `const`s,
// so the mocked functions themselves must be created inside `vi.hoisted()`, which Vitest
// hoists together with the `vi.mock` calls that reference it — see
// https://vitest.dev/api/vi.html#vi-hoisted.
const { mockShowOpenDialog, mockResolveCanonicalRoot, mockCheckRootPolicy, mockApp } = vi.hoisted(() => ({
  mockShowOpenDialog: vi.fn(),
  mockResolveCanonicalRoot: vi.fn(),
  mockCheckRootPolicy: vi.fn(),
  // A plain mutable object (not a vi.fn()) — workspace-grant.ts reads `app.isPackaged` as a
  // property, never calls it. Defaults to `true` (packaged) so most tests below stay quiet;
  // the dedicated dev-diagnostic-logging test flips it to `false` and back.
  mockApp: { isPackaged: true },
}));
vi.mock("electron", () => ({ dialog: { showOpenDialog: mockShowOpenDialog }, app: mockApp }));

// Mock the existing shared validation module so each test controls the outcome
// deterministically, while still proving workspace-grant.ts calls the real, shared
// functions (not a parallel reimplementation) — see the "reuses the exact existing..." test.
vi.mock("../lib/canonicalPath", () => ({
  resolveCanonicalRoot: mockResolveCanonicalRoot,
  checkRootPolicy: mockCheckRootPolicy,
}));

import { pickDirectory, getCurrent, clearCurrent, getCurrentCanonicalRoot } from "../electron/workspace-grant";

// pickDirectory only forwards this to dialog.showOpenDialog(window, options) — it is never
// otherwise inspected or touched, so an empty object stands in for a real BrowserWindow.
const fakeWindow = {} as import("electron").BrowserWindow;

beforeEach(() => {
  mockShowOpenDialog.mockReset();
  mockResolveCanonicalRoot.mockReset();
  mockCheckRootPolicy.mockReset();
  mockApp.isPackaged = true;
  // Reset the module's in-memory grant between tests via the real, exported clearCurrent()
  // — the only intentional way to reset it, matching production behavior exactly (no direct
  // access to the module's private state).
  clearCurrent();
});

describe("pickDirectory — native picker, main-process-only, single directory only", () => {
  it("opens the dialog restricted to directory selection only", async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    await pickDirectory(fakeWindow);
    expect(mockShowOpenDialog).toHaveBeenCalledWith(fakeWindow, expect.objectContaining({ properties: ["openDirectory"] }));
  });

  it("never requests multiSelections", async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    await pickDirectory(fakeWindow);
    const options = mockShowOpenDialog.mock.calls[0]?.[1] as { properties: string[] };
    expect(options.properties).not.toContain("multiSelections");
  });

  it("treats user cancellation as a normal, non-error 'cancelled' result — no grant created", async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const result = await pickDirectory(fakeWindow);
    expect(result).toEqual({ state: "cancelled", workspaceId: null, displayName: null, readOnly: true });
    expect(getCurrent().state).toBe("no_workspace");
  });

  it("treats an empty filePaths array the same as cancellation", async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] });
    const result = await pickDirectory(fakeWindow);
    expect(result.state).toBe("cancelled");
    expect(getCurrent().state).toBe("no_workspace");
  });

  it("treats a native dialog failure as a safe 'unavailable' result, never a thrown error", async () => {
    mockShowOpenDialog.mockRejectedValue(new Error("native dialog backend unavailable"));
    const result = await pickDirectory(fakeWindow);
    expect(result.state).toBe("unavailable");
    expect(getCurrent().state).toBe("no_workspace");
  });

  it("logs only a safe error class name in development, and stays silent when packaged — VYRON_CODE_V02_D03_NATIVE_FOLDER_PICKER_REAL_RUNTIME_FIX_REPORT", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockShowOpenDialog.mockRejectedValue(new Error("failure mentioning C:\\Users\\dev\\sensitive-project"));

    mockApp.isPackaged = false;
    const devResult = await pickDirectory(fakeWindow);
    expect(devResult.state).toBe("unavailable");
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const loggedText = consoleErrorSpy.mock.calls[0]?.join(" ") ?? "";
    expect(loggedText).toContain("Error"); // the error's constructor name only
    expect(loggedText).not.toContain("sensitive-project"); // never the raw message/path

    consoleErrorSpy.mockClear();
    mockApp.isPackaged = true;
    const packagedResult = await pickDirectory(fakeWindow);
    expect(packagedResult.state).toBe("unavailable");
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("rejects a selection that fails canonical-root resolution, without creating a grant", async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["C:\\some\\path"] });
    mockResolveCanonicalRoot.mockReturnValue(null);
    const result = await pickDirectory(fakeWindow);
    expect(result).toEqual({ state: "denied", workspaceId: null, displayName: null, readOnly: true });
    expect(mockCheckRootPolicy).not.toHaveBeenCalled();
    expect(getCurrent().state).toBe("no_workspace");
  });

  it("rejects a selection that fails root-policy checks (e.g. a drive root), without creating a grant", async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["C:\\"] });
    mockResolveCanonicalRoot.mockReturnValue("C:\\");
    mockCheckRootPolicy.mockReturnValue({ allowed: false, reason: "drive_root" });
    const result = await pickDirectory(fakeWindow);
    expect(result.state).toBe("denied");
    expect(getCurrent().state).toBe("no_workspace");
  });

  it("creates a grant only once both canonical-root resolution and root-policy checks pass", async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["C:\\Users\\dev\\my-project"] });
    mockResolveCanonicalRoot.mockReturnValue("C:\\Users\\dev\\my-project");
    mockCheckRootPolicy.mockReturnValue({ allowed: true });
    const result = await pickDirectory(fakeWindow);
    expect(result.state).toBe("granted");
    expect(result.readOnly).toBe(true);
    expect(typeof result.workspaceId).toBe("string");
    expect(result.workspaceId).toHaveLength(36); // a UUID, opaque to the renderer
    expect(result.displayName).toBe("my-project");
  });

  it("reuses the exact existing resolveCanonicalRoot/checkRootPolicy functions — no parallel validation", async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["C:\\Users\\dev\\my-project"] });
    mockResolveCanonicalRoot.mockReturnValue("C:\\Users\\dev\\my-project");
    mockCheckRootPolicy.mockReturnValue({ allowed: true });
    await pickDirectory(fakeWindow);
    expect(mockResolveCanonicalRoot).toHaveBeenCalledWith("C:\\Users\\dev\\my-project");
    expect(mockCheckRootPolicy).toHaveBeenCalledWith("C:\\Users\\dev\\my-project");
  });

  it("a later successful pick replaces (not merges with) any prior grant", async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["C:\\Users\\dev\\project-a"] });
    mockResolveCanonicalRoot.mockReturnValue("C:\\Users\\dev\\project-a");
    mockCheckRootPolicy.mockReturnValue({ allowed: true });
    const first = await pickDirectory(fakeWindow);

    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["C:\\Users\\dev\\project-b"] });
    mockResolveCanonicalRoot.mockReturnValue("C:\\Users\\dev\\project-b");
    const second = await pickDirectory(fakeWindow);

    expect(second.displayName).toBe("project-b");
    expect(second.workspaceId).not.toBe(first.workspaceId);
    expect(getCurrent().displayName).toBe("project-b");
  });
});

describe("getCurrent / clearCurrent — safe grant state, process-memory-only, no persistence", () => {
  it("returns the safe no_workspace state before any grant exists", () => {
    expect(getCurrent()).toEqual({ state: "no_workspace", workspaceId: null, displayName: null, readOnly: true });
  });

  it("returns only opaque id, display name and readOnly:true after a grant — never the canonical/absolute path", async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["C:\\Users\\dev\\my-project"] });
    mockResolveCanonicalRoot.mockReturnValue("C:\\Users\\dev\\my-project");
    mockCheckRootPolicy.mockReturnValue({ allowed: true });
    await pickDirectory(fakeWindow);

    const current = getCurrent();
    expect(current).toEqual({ state: "granted", workspaceId: expect.any(String), displayName: "my-project", readOnly: true });
    expect(Object.keys(current).sort()).toEqual(["displayName", "readOnly", "state", "workspaceId"]);
    expect(JSON.stringify(current)).not.toContain("C:\\Users\\dev\\my-project");
  });

  it("clearCurrent removes the in-memory grant and returns the safe no-workspace state", async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["C:\\Users\\dev\\my-project"] });
    mockResolveCanonicalRoot.mockReturnValue("C:\\Users\\dev\\my-project");
    mockCheckRootPolicy.mockReturnValue({ allowed: true });
    await pickDirectory(fakeWindow);
    expect(getCurrent().state).toBe("granted");

    const cleared = clearCurrent();
    expect(cleared).toEqual({ state: "no_workspace", workspaceId: null, displayName: null, readOnly: true });
    expect(getCurrent().state).toBe("no_workspace");
  });

  it("clearCurrent on an already-empty grant is a safe no-op, not an error", () => {
    expect(() => clearCurrent()).not.toThrow();
    expect(clearCurrent().state).toBe("no_workspace");
  });

  it("readOnly is always true, for every state", async () => {
    expect(getCurrent().readOnly).toBe(true);
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["C:\\Users\\dev\\my-project"] });
    mockResolveCanonicalRoot.mockReturnValue("C:\\Users\\dev\\my-project");
    mockCheckRootPolicy.mockReturnValue({ allowed: true });
    expect((await pickDirectory(fakeWindow)).readOnly).toBe(true);
    expect(clearCurrent().readOnly).toBe(true);
  });
});

describe("getCurrentCanonicalRoot — main-process-internal accessor, never renderer-visible (Milestone A)", () => {
  it("returns null when no grant exists", () => {
    expect(getCurrentCanonicalRoot()).toBeNull();
  });

  it("returns the canonical root after a successful grant, freshly re-resolved", async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["C:\\Users\\dev\\my-project"] });
    mockResolveCanonicalRoot.mockReturnValue("C:\\Users\\dev\\my-project");
    mockCheckRootPolicy.mockReturnValue({ allowed: true });
    await pickDirectory(fakeWindow);

    mockResolveCanonicalRoot.mockClear();
    mockResolveCanonicalRoot.mockReturnValue("C:\\Users\\dev\\my-project");
    expect(getCurrentCanonicalRoot()).toBe("C:\\Users\\dev\\my-project");
    // Re-resolves fresh on every call — a TOCTOU defense, not a cached read.
    expect(mockResolveCanonicalRoot).toHaveBeenCalledWith("C:\\Users\\dev\\my-project");
  });

  it("returns null (denies access) if the root no longer resolves the same way — TOCTOU defense", async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["C:\\Users\\dev\\my-project"] });
    mockResolveCanonicalRoot.mockReturnValue("C:\\Users\\dev\\my-project");
    mockCheckRootPolicy.mockReturnValue({ allowed: true });
    await pickDirectory(fakeWindow);

    // The directory was deleted/moved/replaced since the grant was created.
    mockResolveCanonicalRoot.mockReturnValue(null);
    expect(getCurrentCanonicalRoot()).toBeNull();

    // Or it now resolves to a DIFFERENT path than originally granted (e.g. a symlink swap).
    mockResolveCanonicalRoot.mockReturnValue("C:\\Users\\dev\\a-different-project");
    expect(getCurrentCanonicalRoot()).toBeNull();
  });

  it("returns null again after clearCurrent", async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["C:\\Users\\dev\\my-project"] });
    mockResolveCanonicalRoot.mockReturnValue("C:\\Users\\dev\\my-project");
    mockCheckRootPolicy.mockReturnValue({ allowed: true });
    await pickDirectory(fakeWindow);
    expect(getCurrentCanonicalRoot()).not.toBeNull();

    clearCurrent();
    expect(getCurrentCanonicalRoot()).toBeNull();
  });
});
