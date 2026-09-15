import { describe, it, expect, beforeEach } from "vitest";
import { getEndpointConfigurationState, configureEndpoint, clearEndpointConfiguration, getConfiguredEndpoint } from "../electron/hermesEndpointSetup";

// Every endpoint value below is an explicit, obviously-fake sample — never a real Hermes
// deployment target, never read from .env.local/process.env, never a real running service.
// VYRON_CODE_V02_D08E_MEMORY_ONLY_HERMES_ENDPOINT_SETUP_AUTHORIZATION explicitly forbids any
// network/DNS/TCP/WebSocket activity in this task; none is used, attempted, or possible here —
// configureEndpoint() performs only in-memory string/URL validation, never I/O.
const FAKE_LOOPBACK_ENDPOINT = "ws://127.0.0.1:19130/api/ws";

beforeEach(() => {
  // Reset the module's in-memory configuration between tests via the real, exported
  // clearEndpointConfiguration() — matching production behavior exactly.
  clearEndpointConfiguration();
});

describe("getEndpointConfigurationState — safe ambient state, memory-only", () => {
  it("starts not_configured", () => {
    expect(getEndpointConfigurationState()).toEqual({ state: "not_configured" });
  });

  it("reflects configured_memory_only only after a successful configureEndpoint", async () => {
    await configureEndpoint({ endpoint: FAKE_LOOPBACK_ENDPOINT });
    expect(getEndpointConfigurationState()).toEqual({ state: "configured_memory_only" });
  });

  it("never includes the endpoint, its length, or any derived field", async () => {
    await configureEndpoint({ endpoint: FAKE_LOOPBACK_ENDPOINT });
    const result = getEndpointConfigurationState();
    expect(Object.keys(result)).toEqual(["state"]);
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
    expect(JSON.stringify(result)).not.toContain("19130");
  });
});

describe("configureEndpoint — the single narrow endpoint-submission boundary", () => {
  it("accepts a well-formed, policy-compliant fake loopback endpoint", async () => {
    const result = await configureEndpoint({ endpoint: FAKE_LOOPBACK_ENDPOINT });
    expect(result).toEqual({ state: "configured_memory_only" });
  });

  it("never echoes the endpoint, its components, or a derived value back in the result", async () => {
    const result = await configureEndpoint({ endpoint: FAKE_LOOPBACK_ENDPOINT });
    expect(Object.keys(result)).toEqual(["state"]);
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
    expect(JSON.stringify(result)).not.toContain("19130");
  });

  it("rejects a wrong-type request (string instead of object)", async () => {
    const result = await configureEndpoint("not-an-object");
    expect(result).toEqual({ state: "invalid_configuration" });
    expect(getEndpointConfigurationState().state).toBe("not_configured");
  });

  it("rejects null", async () => {
    expect(await configureEndpoint(null)).toEqual({ state: "invalid_configuration" });
  });

  it("rejects an array", async () => {
    expect(await configureEndpoint([FAKE_LOOPBACK_ENDPOINT])).toEqual({ state: "invalid_configuration" });
  });

  it("rejects a missing endpoint field", async () => {
    expect(await configureEndpoint({})).toEqual({ state: "invalid_configuration" });
  });

  it("rejects a non-string endpoint value", async () => {
    expect(await configureEndpoint({ endpoint: 12345 })).toEqual({ state: "invalid_configuration" });
  });

  it("rejects a request with an unexpected extra field, even alongside a valid endpoint (T-14-style)", async () => {
    const result = await configureEndpoint({ endpoint: FAKE_LOOPBACK_ENDPOINT, host: "example.invalid" });
    expect(result).toEqual({ state: "invalid_configuration" });
    expect(getEndpointConfigurationState().state).toBe("not_configured");
  });

  it("rejects a request carrying token/session/prompt-shaped fields instead of endpoint", async () => {
    expect(await configureEndpoint({ token: "fake-value" })).toEqual({ state: "invalid_configuration" });
    expect(await configureEndpoint({ sessionId: "fake-session" })).toEqual({ state: "invalid_configuration" });
    expect(await configureEndpoint({ prompt: "hello" })).toEqual({ state: "invalid_configuration" });
  });

  it("rejects an empty-string endpoint", async () => {
    expect(await configureEndpoint({ endpoint: "" })).toEqual({ state: "invalid_configuration" });
  });

  it("rejects a whitespace-only endpoint", async () => {
    expect(await configureEndpoint({ endpoint: "   \t\n  " })).toEqual({ state: "invalid_configuration" });
  });

  it("rejects an endpoint containing control characters", async () => {
    expect(await configureEndpoint({ endpoint: `ws://127.0.0.1:19130/api\x00/ws` })).toEqual({ state: "invalid_configuration" });
  });

  it("rejects an oversized endpoint (over the 2048-character bound)", async () => {
    const oversized = "ws://127.0.0.1:19130/" + "a".repeat(2100);
    expect(await configureEndpoint({ endpoint: oversized })).toEqual({ state: "invalid_configuration" });
  });

  it("rejects a malformed URL string", async () => {
    expect(await configureEndpoint({ endpoint: "not a url at all" })).toEqual({ state: "invalid_configuration" });
  });

  it("rejects an unsupported scheme (http)", async () => {
    expect(await configureEndpoint({ endpoint: "http://127.0.0.1:19130/api/ws" })).toEqual({ state: "policy_rejected" });
  });

  it("rejects URL userinfo", async () => {
    expect(await configureEndpoint({ endpoint: "ws://user:pass@127.0.0.1:19130/api/ws" })).toEqual({ state: "policy_rejected" });
  });

  it("rejects a query string", async () => {
    expect(await configureEndpoint({ endpoint: "ws://127.0.0.1:19130/api/ws?token=fake" })).toEqual({ state: "policy_rejected" });
  });

  it("rejects a fragment", async () => {
    expect(await configureEndpoint({ endpoint: "ws://127.0.0.1:19130/api/ws#frag" })).toEqual({ state: "policy_rejected" });
  });

  it("rejects a disallowed non-loopback host", async () => {
    expect(await configureEndpoint({ endpoint: "ws://203.0.113.5:19130/api/ws" })).toEqual({ state: "policy_rejected" });
  });

  it("rejects a wildcard bind address (0.0.0.0)", async () => {
    expect(await configureEndpoint({ endpoint: "ws://0.0.0.0:19130/api/ws" })).toEqual({ state: "policy_rejected" });
  });

  it("rejects a link-local address", async () => {
    expect(await configureEndpoint({ endpoint: "ws://169.254.1.1:19130/api/ws" })).toEqual({ state: "policy_rejected" });
  });

  it("rejects a trailing-dot hostname form (not exactly 'localhost')", async () => {
    expect(await configureEndpoint({ endpoint: "ws://localhost.:19130/api/ws" })).toEqual({ state: "policy_rejected" });
  });

  it("rejects a subdomain-trick hostname that merely starts with a loopback-looking string", async () => {
    expect(await configureEndpoint({ endpoint: "ws://127.0.0.1.example.invalid:19130/api/ws" })).toEqual({ state: "policy_rejected" });
  });

  it("safely accepts (not bypasses) encoded/shorthand IPv4 forms that the URL parser itself normalizes to loopback", async () => {
    // These are not a bypass: the WHATWG URL parser normalizes each to the exact literal
    // "127.0.0.1" before this module's exact-match host check ever runs — confirmed via a
    // direct Node check, not assumed. A trick encoding of any OTHER address would normalize to
    // that other address's own canonical form and be correctly rejected instead.
    for (const form of ["ws://0x7f000001:19130/api/ws", "ws://2130706433:19130/api/ws", "ws://127.1:19130/api/ws"]) {
      const result = await configureEndpoint({ endpoint: form });
      expect(result, `expected ${form} to be accepted as loopback`).toEqual({ state: "configured_memory_only" });
      clearEndpointConfiguration();
    }
  });

  it("rejects an endpoint with no port at all", async () => {
    expect(await configureEndpoint({ endpoint: "ws://127.0.0.1/api/ws" })).toEqual({ state: "invalid_configuration" });
  });

  it("rejects an endpoint with an explicit zero port", async () => {
    expect(await configureEndpoint({ endpoint: "ws://127.0.0.1:0/api/ws" })).toEqual({ state: "invalid_configuration" });
  });

  it("rejects an endpoint whose path exceeds the 512-character bound", async () => {
    const longPath = "ws://127.0.0.1:19130/" + "a".repeat(600);
    expect(await configureEndpoint({ endpoint: longPath })).toEqual({ state: "invalid_configuration" });
  });

  it("accepts wss as well as ws", async () => {
    expect(await configureEndpoint({ endpoint: "wss://127.0.0.1:19130/api/ws" })).toEqual({ state: "configured_memory_only" });
  });

  it("a later successful call replaces (not merges with) a prior configuration", async () => {
    await configureEndpoint({ endpoint: "ws://127.0.0.1:19130/api/ws" });
    expect(getEndpointConfigurationState().state).toBe("configured_memory_only");
    const second = await configureEndpoint({ endpoint: "ws://localhost:19131/api/ws" });
    expect(second.state).toBe("configured_memory_only");
    expect(getEndpointConfigurationState().state).toBe("configured_memory_only");
  });
});

describe("clearEndpointConfiguration — explicit, immediate revocation, memory-only", () => {
  it("transitions to a safe cleared state", async () => {
    await configureEndpoint({ endpoint: FAKE_LOOPBACK_ENDPOINT });
    const result = clearEndpointConfiguration();
    expect(result).toEqual({ state: "cleared" });
    expect(getEndpointConfigurationState()).toEqual({ state: "not_configured" });
  });

  it("is idempotent — calling it again on an already-cleared state is safe and non-throwing", () => {
    expect(() => clearEndpointConfiguration()).not.toThrow();
    expect(clearEndpointConfiguration()).toEqual({ state: "cleared" });
    expect(getEndpointConfigurationState().state).toBe("not_configured");
  });

  it("never returns the endpoint or any derived value", async () => {
    await configureEndpoint({ endpoint: FAKE_LOOPBACK_ENDPOINT });
    const result = clearEndpointConfiguration();
    expect(Object.keys(result)).toEqual(["state"]);
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
  });
});

describe("Fresh module lifecycle begins not_configured (app-restart equivalence)", () => {
  it("a freshly cleared state behaves exactly like a never-configured state", () => {
    clearEndpointConfiguration();
    expect(getEndpointConfigurationState()).toEqual({ state: "not_configured" });
  });
});

describe("T-17-style — stale in-flight configure cannot restore configuration after a clear", () => {
  it("a configureEndpoint call already in flight when clearEndpointConfiguration runs resolves as cleared, not configured", async () => {
    const inFlight = configureEndpoint({ endpoint: FAKE_LOOPBACK_ENDPOINT });
    clearEndpointConfiguration();
    const result = await inFlight;
    expect(result).toEqual({ state: "cleared" });
    expect(getEndpointConfigurationState()).toEqual({ state: "not_configured" });
  });

  it("a configureEndpoint call that completes with no intervening clear still succeeds normally", async () => {
    const inFlight = configureEndpoint({ endpoint: FAKE_LOOPBACK_ENDPOINT });
    const result = await inFlight;
    expect(result).toEqual({ state: "configured_memory_only" });
  });
});

describe("getConfiguredEndpoint — main-process-internal accessor, never renderer-visible", () => {
  it("returns null when nothing is configured", () => {
    expect(getConfiguredEndpoint()).toBeNull();
  });

  it("returns the validated trusted endpoint object after a successful configuration", async () => {
    await configureEndpoint({ endpoint: FAKE_LOOPBACK_ENDPOINT });
    const endpoint = getConfiguredEndpoint();
    expect(endpoint?.kind).toBe("trusted");
    if (endpoint?.kind === "trusted") {
      expect(endpoint.url).toBeInstanceOf(URL);
      expect(endpoint.url.hostname).toBe("127.0.0.1");
    }
  });

  it("returns null again after clear", async () => {
    await configureEndpoint({ endpoint: FAKE_LOOPBACK_ENDPOINT });
    expect(getConfiguredEndpoint()).not.toBeNull();
    clearEndpointConfiguration();
    expect(getConfiguredEndpoint()).toBeNull();
  });
});
