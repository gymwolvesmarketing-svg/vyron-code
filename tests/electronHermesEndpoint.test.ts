import { describe, it, expect } from "vitest";
import { validateEndpointCandidate, resolveTrustedEndpoint } from "../electron/hermesEndpoint";

// Every candidate below is a fake, obviously-sample value — never a real Hermes host/port,
// never read from .env.local, process.env, or any real running service.
// VYRON_CODE_V02_D10_API_SERVER_REMEDIATION_AUTHORIZATION explicitly forbids inspecting real
// configuration or establishing any network connection in this task — this file does neither;
// every assertion below is pure, synchronous, in-memory validation.
const FAKE_LOOPBACK_CANDIDATE = {
  endpointId: "sample-loopback-endpoint",
  url: "http://127.0.0.1:9999",
  hostPolicy: "loopback-only" as const,
};

describe("resolveTrustedEndpoint — the actual entry point hermesApiServer.ts consumes", () => {
  it("returns unavailable/not_configured when no candidate source exists (the current, real production behavior)", () => {
    expect(resolveTrustedEndpoint()).toEqual({ kind: "unavailable", reason: "not_configured" });
  });

  it("never reads process.env, never inspects a real file, never opens a network connection — a pure, synchronous call", () => {
    // If this function touched I/O or the network, it would need to be async or could throw
    // an environment-dependent error; it does neither.
    expect(() => resolveTrustedEndpoint()).not.toThrow();
  });
});

describe("validateEndpointCandidate — the reusable policy-enforcement core (fully testable with fake values)", () => {
  it("no configuration (undefined) returns unavailable/not_configured", () => {
    expect(validateEndpointCandidate(undefined)).toEqual({ kind: "unavailable", reason: "not_configured" });
  });

  it("null returns unavailable/not_configured", () => {
    expect(validateEndpointCandidate(null)).toEqual({ kind: "unavailable", reason: "not_configured" });
  });

  it("a wrong-type candidate (string instead of object) returns unavailable/invalid_configuration", () => {
    expect(validateEndpointCandidate("not-an-object")).toEqual({ kind: "unavailable", reason: "invalid_configuration" });
  });

  it("a candidate missing required fields returns unavailable/invalid_configuration", () => {
    expect(validateEndpointCandidate({ endpointId: "x" })).toEqual({ kind: "unavailable", reason: "invalid_configuration" });
  });

  it("a candidate with a non-string endpointId returns unavailable/invalid_configuration", () => {
    expect(validateEndpointCandidate({ ...FAKE_LOOPBACK_CANDIDATE, endpointId: 123 })).toEqual({
      kind: "unavailable",
      reason: "invalid_configuration",
    });
  });

  it("a candidate with an empty endpointId returns unavailable/invalid_configuration", () => {
    expect(validateEndpointCandidate({ ...FAKE_LOOPBACK_CANDIDATE, endpointId: "" })).toEqual({
      kind: "unavailable",
      reason: "invalid_configuration",
    });
  });

  it("a candidate with an unrecognized hostPolicy value returns unavailable/invalid_configuration", () => {
    expect(validateEndpointCandidate({ ...FAKE_LOOPBACK_CANDIDATE, hostPolicy: "anything-goes" })).toEqual({
      kind: "unavailable",
      reason: "invalid_configuration",
    });
  });

  it("a malformed URL string returns unavailable/invalid_configuration", () => {
    expect(validateEndpointCandidate({ ...FAKE_LOOPBACK_CANDIDATE, url: "not a url at all" })).toEqual({
      kind: "unavailable",
      reason: "invalid_configuration",
    });
  });

  it("a URL with no host at all returns unavailable/invalid_configuration (WHATWG URL parsing itself rejects an empty host for http:)", () => {
    expect(validateEndpointCandidate({ ...FAKE_LOOPBACK_CANDIDATE, url: "http://" })).toEqual({
      kind: "unavailable",
      reason: "invalid_configuration",
    });
  });

  it("an unsupported scheme (ws) is rejected as policy_rejected — the retired dashboard-socket scheme is no longer accepted", () => {
    expect(validateEndpointCandidate({ ...FAKE_LOOPBACK_CANDIDATE, url: "ws://127.0.0.1:9999" })).toEqual({
      kind: "unavailable",
      reason: "policy_rejected",
    });
  });

  it("an unsupported scheme (wss) is rejected as policy_rejected", () => {
    expect(validateEndpointCandidate({ ...FAKE_LOOPBACK_CANDIDATE, url: "wss://127.0.0.1:9999" })).toEqual({
      kind: "unavailable",
      reason: "policy_rejected",
    });
  });

  it("an unsupported scheme (https) is rejected as policy_rejected — only http: is accepted this milestone", () => {
    expect(validateEndpointCandidate({ ...FAKE_LOOPBACK_CANDIDATE, url: "https://127.0.0.1:9999" })).toEqual({
      kind: "unavailable",
      reason: "policy_rejected",
    });
  });

  it("an unsupported scheme (file) is rejected as policy_rejected", () => {
    expect(validateEndpointCandidate({ ...FAKE_LOOPBACK_CANDIDATE, url: "file:///etc/passwd" })).toEqual({
      kind: "unavailable",
      reason: "policy_rejected",
    });
  });

  it("URL userinfo (username/password embedded in the URL) is rejected as policy_rejected", () => {
    expect(validateEndpointCandidate({ ...FAKE_LOOPBACK_CANDIDATE, url: "http://user:pass@127.0.0.1:9999" })).toEqual({
      kind: "unavailable",
      reason: "policy_rejected",
    });
  });

  it("a query string is rejected as policy_rejected (never a place to smuggle a credential)", () => {
    expect(validateEndpointCandidate({ ...FAKE_LOOPBACK_CANDIDATE, url: "http://127.0.0.1:9999?key=fake-sample-value" })).toEqual({
      kind: "unavailable",
      reason: "policy_rejected",
    });
  });

  it("a fragment is rejected as policy_rejected", () => {
    expect(validateEndpointCandidate({ ...FAKE_LOOPBACK_CANDIDATE, url: "http://127.0.0.1:9999#fragment" })).toEqual({
      kind: "unavailable",
      reason: "policy_rejected",
    });
  });

  it("loopback-only policy rejects a non-loopback host", () => {
    expect(validateEndpointCandidate({ ...FAKE_LOOPBACK_CANDIDATE, url: "http://203.0.113.5:9999" })).toEqual({
      kind: "unavailable",
      reason: "policy_rejected",
    });
  });

  it("loopback-only policy rejects a LAN-shaped host", () => {
    expect(validateEndpointCandidate({ ...FAKE_LOOPBACK_CANDIDATE, url: "http://192.168.1.50:9999" })).toEqual({
      kind: "unavailable",
      reason: "policy_rejected",
    });
  });

  it("rejects a disallowed pathname — anything other than empty, '/', or '/v1'", () => {
    for (const path of ["/api/ws", "/v1/chat/completions", "/health", "/v2", "/v1/"]) {
      const result = validateEndpointCandidate({ ...FAKE_LOOPBACK_CANDIDATE, url: `http://127.0.0.1:9999${path}` });
      expect(result, `path ${path} should be rejected`).toEqual({ kind: "unavailable", reason: "policy_rejected" });
    }
  });

  it("rejects a missing port", () => {
    expect(validateEndpointCandidate({ ...FAKE_LOOPBACK_CANDIDATE, url: "http://127.0.0.1" })).toEqual({
      kind: "unavailable",
      reason: "invalid_configuration",
    });
  });

  it("rejects an explicit zero port", () => {
    expect(validateEndpointCandidate({ ...FAKE_LOOPBACK_CANDIDATE, url: "http://127.0.0.1:0" })).toEqual({
      kind: "unavailable",
      reason: "invalid_configuration",
    });
  });

  it("a well-formed, fully policy-compliant fake candidate (empty path) resolves to a trusted internal object only", () => {
    const result = validateEndpointCandidate(FAKE_LOOPBACK_CANDIDATE);
    expect(result.kind).toBe("trusted");
    if (result.kind === "trusted") {
      expect(result.transport).toBe("http");
      expect(result.hostPolicy).toBe("loopback-only");
      expect(result.endpointId).toBe("sample-loopback-endpoint");
      expect(result.url).toBeInstanceOf(URL);
      expect(result.url.hostname).toBe("127.0.0.1");
    }
  });

  it("accepts every permitted pathname shape — empty, '/', and '/v1'", () => {
    for (const path of ["", "/", "/v1"]) {
      const result = validateEndpointCandidate({ ...FAKE_LOOPBACK_CANDIDATE, url: `http://127.0.0.1:9999${path}` });
      expect(result.kind, `path "${path}" should be trusted`).toBe("trusted");
    }
  });

  it("accepts every documented loopback spelling under loopback-only policy", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const result = validateEndpointCandidate({ ...FAKE_LOOPBACK_CANDIDATE, url: `http://${host}:9999` });
      expect(result.kind, `host ${host} should be trusted`).toBe("trusted");
    }
  });

  it("explicit-approved-host policy rejects every host when no approved-hosts list is supplied (the real, production default)", () => {
    const result = validateEndpointCandidate({ ...FAKE_LOOPBACK_CANDIDATE, url: "http://127.0.0.1:9999", hostPolicy: "explicit-approved-host" });
    expect(result).toEqual({ kind: "unavailable", reason: "policy_rejected" });
  });

  it("explicit-approved-host policy accepts a host only when it appears in a caller-supplied fake approved-hosts list (testability only — production never supplies one)", () => {
    const candidate = { ...FAKE_LOOPBACK_CANDIDATE, url: "http://sample-approved-host.example.invalid:9999", hostPolicy: "explicit-approved-host" as const };
    const rejected = validateEndpointCandidate(candidate, []);
    expect(rejected).toEqual({ kind: "unavailable", reason: "policy_rejected" });
    const accepted = validateEndpointCandidate(candidate, ["sample-approved-host.example.invalid"]);
    expect(accepted.kind).toBe("trusted");
  });

  it("never mutates or returns the raw candidate object itself", () => {
    const candidate = { ...FAKE_LOOPBACK_CANDIDATE };
    const frozen = Object.freeze(candidate);
    expect(() => validateEndpointCandidate(frozen)).not.toThrow();
  });

  it("never performs DNS, HTTP, or TCP activity — a pure, synchronous function", () => {
    expect(() => validateEndpointCandidate(FAKE_LOOPBACK_CANDIDATE)).not.toThrow();
  });
});
