// One-off, handshake-ONLY verification against Hermes Agent's tui_gateway — never calls
// session.create or prompt.submit. Mirrors Vyron Pro's own scripts/ws-handshake-test.mjs
// pattern. Reads HERMES_HOST/HERMES_PORT/HERMES_SESSION_TOKEN from the process environment
// only (never from a file, never hardcoded) and NEVER logs the token, the full URL, or any
// header value — only a generic OPEN/ERROR outcome, matching
// VYRON_CODE_V01_HERMES_WS_SMOKE_TEST_REPORT.md's confirmed-safe error-message pattern.
import WS from "ws";

const host = process.env.HERMES_HOST;
const port = process.env.HERMES_PORT;
const token = process.env.HERMES_SESSION_TOKEN;

if (!host || !port || !token) {
  console.log("MISSING_CONFIG: HERMES_HOST, HERMES_PORT and HERMES_SESSION_TOKEN must all be set in the process environment");
  process.exit(1);
}

const origin = `http://${host}:${port}`;
const url = `ws://${host}:${port}/api/ws?token=${encodeURIComponent(token)}`;

const socket = new WS(url, { origin, headers: { Host: `${host}:${port}` }, handshakeTimeout: 10_000 });

const timer = setTimeout(() => {
  console.log("RESULT: TIMEOUT");
  try {
    socket.terminate();
  } catch {}
  process.exit(1);
}, 12_000);

socket.on("open", () => {
  clearTimeout(timer);
  console.log("RESULT: OPEN (authenticated handshake succeeded)");
  // Deliberately no session.create / prompt.submit — close immediately per this task's scope.
  socket.close();
  process.exit(0);
});

socket.on("error", (err) => {
  clearTimeout(timer);
  // err.message is confirmed generic (status code / readyState only, never the URL or token) —
  // see lib/hermesClient.ts's own doc comment for the source-level proof.
  console.log(`RESULT: ERROR ${err.message}`);
  process.exit(1);
});
