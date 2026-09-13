import { describe, it, expect } from "vitest";
import net from "node:net";
import { parseEnvFile, checkTcpReachable } from "../scripts/preflight.mjs";

describe("parseEnvFile", () => {
  it("parses KEY=VALUE lines, skipping blanks and comments", () => {
    const parsed = parseEnvFile("HERMES_HOST=127.0.0.1\n# a comment\n\nHERMES_PORT=9130\n");
    expect(parsed).toEqual({ HERMES_HOST: "127.0.0.1", HERMES_PORT: "9130" });
  });

  it("never chokes on a line with no '=' — just skips it", () => {
    expect(parseEnvFile("not-a-valid-line\nHERMES_HOST=127.0.0.1")).toEqual({ HERMES_HOST: "127.0.0.1" });
  });
});

describe("checkTcpReachable", () => {
  it("resolves true when a listener is actually accepting connections on that port", async () => {
    const server = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      expect(await checkTcpReachable("127.0.0.1", port)).toBe(true);
    } finally {
      server.close();
    }
  });

  it("resolves false when nothing is listening on that port", async () => {
    // Bind a server only to immediately learn a free ephemeral port, then close it —
    // the same port is very unlikely to be reused by anything else in this instant.
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const freePort = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    expect(await checkTcpReachable("127.0.0.1", freePort, 500)).toBe(false);
  });
});
