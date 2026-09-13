import { NextResponse } from "next/server";
import net from "node:net";

// Passive, read-only reachability check ONLY — a plain TCP connect attempt, immediately
// closed. Never a WebSocket upgrade, never carries the token, never calls session.create or
// any other Hermes RPC method. Used solely to drive the UI's own health/liveness indicator
// (VYRON_CODE_V01_LOCAL_RUNTIME_HARDENING_IMPLEMENTATION_AUTHORIZATION, section C) — it must
// never be wired to any "reconnect"/"retry" action that creates a session or sends a prompt.
const CONNECT_TIMEOUT_MS = 1500;

function checkReachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: CONNECT_TIMEOUT_MS });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export async function GET() {
  const host = process.env.HERMES_HOST;
  const port = process.env.HERMES_PORT ? Number(process.env.HERMES_PORT) : undefined;
  if (!host || !port) {
    return NextResponse.json({ configured: false, reachable: false });
  }
  const reachable = await checkReachable(host, port);
  return NextResponse.json({ configured: true, reachable });
}
