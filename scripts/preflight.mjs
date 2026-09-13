#!/usr/bin/env node
/**
 * Manual foreground launch preflight (VYRON_CODE_V01_LOCAL_RUNTIME_HARDENING_IMPLEMENTATION_AUTHORIZATION).
 * Run before starting Vyron Code (`npm run start:local` chains this automatically). Never
 * reads, prints, or checks a token's VALUE — only whether HERMES_SESSION_TOKEN is present in
 * this terminal's own environment, as a boolean. Fails closed (non-zero exit) only when
 * Vyron Code's own port is already in use; a missing/unreachable Hermes serve or missing
 * token are reported as warnings, not hard failures, since read-only browsing/search/git
 * features work without Hermes — only chat needs it, and the chat route already fails closed
 * on its own if the token is absent.
 */
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VYRON_CODE_HOST = "127.0.0.1";
const VYRON_CODE_PORT = 3055;
const CONNECT_TIMEOUT_MS = 1500;

export function checkTcpReachable(host, port, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
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

export function parseEnvFile(content) {
  const env = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return env;
}

export function readEnvLocal(cwd) {
  const p = path.join(cwd, ".env.local");
  if (!fs.existsSync(p)) return {};
  return parseEnvFile(fs.readFileSync(p, "utf8"));
}

async function main() {
  console.log("Vyron Code local preflight");
  console.log("---------------------------");

  const portBusy = await checkTcpReachable(VYRON_CODE_HOST, VYRON_CODE_PORT);
  if (portBusy) {
    console.error(
      `FAIL: ${VYRON_CODE_HOST}:${VYRON_CODE_PORT} is already in use. Stop whatever is using it first — this preflight never picks an alternate port automatically.`
    );
    process.exitCode = 1;
    return;
  }
  console.log(`OK   ${VYRON_CODE_HOST}:${VYRON_CODE_PORT} is free.`);

  const env = readEnvLocal(process.cwd());
  const hermesHost = env.HERMES_HOST;
  const hermesPort = env.HERMES_PORT ? Number(env.HERMES_PORT) : undefined;
  if (!hermesHost || !hermesPort) {
    console.warn("WARN HERMES_HOST/HERMES_PORT not set in .env.local — chat will fail closed until configured (read-only features are unaffected).");
  } else {
    const reachable = await checkTcpReachable(hermesHost, hermesPort);
    if (reachable) {
      console.log(`OK   Hermes serve appears reachable at ${hermesHost}:${hermesPort}.`);
    } else {
      console.warn(
        `WARN Hermes serve is not reachable at ${hermesHost}:${hermesPort} — chat will fail closed until it's running (read-only features are unaffected).`
      );
    }
  }

  if (process.env.HERMES_SESSION_TOKEN) {
    console.log("OK   HERMES_SESSION_TOKEN is present in this terminal's environment (value never checked or displayed).");
  } else {
    console.warn("WARN HERMES_SESSION_TOKEN is not set in this terminal — chat will fail closed until you set it yourself before starting.");
  }

  console.log("Preflight complete.");
}

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
  main();
}
