import { describe, it, expect, beforeEach } from "vitest";
import { getAvailability, getAuthorizationState, beginAuthorization, clearAuthorization } from "../electron/hermesAuthorization";

// Every credential value used below is a controlled, obviously-fake placeholder — never a
// real Hermes token, never read from an environment variable, config file, or the user's
// own workspace. VYRON_CODE_V02_D08B_MEMORY_ONLY_HERMES_AUTHORIZATION_BOUNDARY_AUTHORIZATION
// explicitly forbids testing with a real token; none is used, requested, or discovered here.
const PLACEHOLDER_CREDENTIAL = "placeholder-test-credential-value-not-real";

beforeEach(() => {
  // Reset the module's in-memory authorization state between tests via the real, exported
  // clearAuthorization() — the only intentional way to reset it, matching production
  // behavior exactly (no direct access to the module's private state).
  clearAuthorization();
});

describe("getAvailability — static, build-time-only capability state", () => {
  it("reports available without performing any async work (no network probe of any kind)", () => {
    const result = getAvailability();
    expect(result).toEqual({ state: "available" });
  });

  it("returns the same static result on every call", () => {
    expect(getAvailability()).toEqual(getAvailability());
  });
});

describe("getAuthorizationState — safe ambient state, memory-only", () => {
  it("starts not_authorized", () => {
    expect(getAuthorizationState()).toEqual({ state: "not_authorized" });
  });

  it("reflects authorized_memory_only only after a successful beginAuthorization", async () => {
    await beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL });
    expect(getAuthorizationState()).toEqual({ state: "authorized_memory_only" });
  });

  it("never includes the credential, its length, or any derived field", async () => {
    await beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL });
    const result = getAuthorizationState();
    expect(Object.keys(result)).toEqual(["state"]);
    expect(JSON.stringify(result)).not.toContain(PLACEHOLDER_CREDENTIAL);
  });
});

describe("beginAuthorization — the single narrow credential-submission boundary", () => {
  it("accepts a well-formed request and returns authorized_memory_only", async () => {
    const result = await beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL });
    expect(result).toEqual({ state: "authorized_memory_only" });
  });

  it("never echoes the credential, its length, or a derived value back in the result", async () => {
    const result = await beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL });
    expect(Object.keys(result)).toEqual(["state"]);
    expect(JSON.stringify(result)).not.toContain(PLACEHOLDER_CREDENTIAL);
  });

  it("rejects a wrong-type request (string instead of object) with a safe typed failure", async () => {
    const result = await beginAuthorization("not-an-object" as unknown);
    expect(result).toEqual({ state: "safe_failure" });
    expect(getAuthorizationState().state).toBe("not_authorized");
  });

  it("rejects null", async () => {
    const result = await beginAuthorization(null);
    expect(result).toEqual({ state: "safe_failure" });
  });

  it("rejects an array", async () => {
    const result = await beginAuthorization([PLACEHOLDER_CREDENTIAL] as unknown);
    expect(result).toEqual({ state: "safe_failure" });
  });

  it("rejects a missing credential field", async () => {
    const result = await beginAuthorization({});
    expect(result).toEqual({ state: "safe_failure" });
  });

  it("rejects a non-string credential value", async () => {
    const result = await beginAuthorization({ credential: 12345 });
    expect(result).toEqual({ state: "safe_failure" });
  });

  it("rejects an empty-string credential", async () => {
    const result = await beginAuthorization({ credential: "" });
    expect(result).toEqual({ state: "safe_failure" });
    expect(getAuthorizationState().state).toBe("not_authorized");
  });

  it("rejects a whitespace-only credential", async () => {
    const result = await beginAuthorization({ credential: "   \t\n  " });
    expect(result).toEqual({ state: "safe_failure" });
  });

  it("rejects an oversized credential (over the 4096-character bound)", async () => {
    const oversized = "a".repeat(4097);
    const result = await beginAuthorization({ credential: oversized });
    expect(result).toEqual({ state: "safe_failure" });
    expect(getAuthorizationState().state).toBe("not_authorized");
  });

  it("accepts a credential exactly at the 4096-character bound", async () => {
    const atBound = "a".repeat(4096);
    const result = await beginAuthorization({ credential: atBound });
    expect(result).toEqual({ state: "authorized_memory_only" });
  });

  it("rejects a request with an unexpected extra field, even alongside a valid credential (T-14)", async () => {
    const result = await beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL, endpoint: "ws://example.invalid:9999" });
    expect(result).toEqual({ state: "safe_failure" });
    expect(getAuthorizationState().state).toBe("not_authorized");
  });

  it("rejects a request carrying only an unrelated field (e.g. an attempted host/port/session field), never guessing a credential", async () => {
    const result = await beginAuthorization({ host: "example.invalid" });
    expect(result).toEqual({ state: "safe_failure" });
  });

  it("a later successful call replaces (not merges with) a prior authorization", async () => {
    await beginAuthorization({ credential: "first-placeholder-credential" });
    expect(getAuthorizationState().state).toBe("authorized_memory_only");
    const second = await beginAuthorization({ credential: "second-placeholder-credential" });
    expect(second.state).toBe("authorized_memory_only");
    expect(getAuthorizationState().state).toBe("authorized_memory_only");
  });
});

describe("clearAuthorization — explicit, immediate revocation, memory-only", () => {
  it("transitions to a safe revoked state", async () => {
    await beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL });
    const result = clearAuthorization();
    expect(result).toEqual({ state: "revoked" });
    expect(getAuthorizationState()).toEqual({ state: "not_authorized" });
  });

  it("is idempotent — calling it again on an already-cleared state is safe and non-throwing", () => {
    expect(() => clearAuthorization()).not.toThrow();
    expect(clearAuthorization()).toEqual({ state: "revoked" });
    expect(getAuthorizationState().state).toBe("not_authorized");
  });

  it("never returns the credential or any derived value", async () => {
    await beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL });
    const result = clearAuthorization();
    expect(Object.keys(result)).toEqual(["state"]);
    expect(JSON.stringify(result)).not.toContain(PLACEHOLDER_CREDENTIAL);
  });
});

describe("Fresh module lifecycle begins not_authorized (app-restart equivalence)", () => {
  it("a freshly cleared state behaves exactly like a never-authorized state", () => {
    clearAuthorization();
    expect(getAuthorizationState()).toEqual({ state: "not_authorized" });
  });
});

describe("T-17 — stale in-flight authorization cannot restore authorized state after a revoke", () => {
  it("a beginAuthorization call already in flight when clearAuthorization runs resolves as revoked, not authorized", async () => {
    // Deliberately does not await beginAuthorization before calling clearAuthorization — this
    // exercises the exact race window beginAuthorization's own explicit yield point creates.
    const inFlight = beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL });
    clearAuthorization();
    const result = await inFlight;
    expect(result).toEqual({ state: "revoked" });
    expect(getAuthorizationState()).toEqual({ state: "not_authorized" });
  });

  it("a beginAuthorization call that completes with no intervening clear still succeeds normally", async () => {
    const inFlight = beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL });
    const result = await inFlight;
    expect(result).toEqual({ state: "authorized_memory_only" });
    expect(getAuthorizationState()).toEqual({ state: "authorized_memory_only" });
  });

  it("two concurrent beginAuthorization calls both complete safely, and a clear between them still wins over the later one", async () => {
    const first = beginAuthorization({ credential: "first-placeholder-credential" });
    clearAuthorization();
    const second = beginAuthorization({ credential: "second-placeholder-credential" });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual({ state: "revoked" });
    expect(secondResult).toEqual({ state: "authorized_memory_only" });
    expect(getAuthorizationState()).toEqual({ state: "authorized_memory_only" });
  });
});
