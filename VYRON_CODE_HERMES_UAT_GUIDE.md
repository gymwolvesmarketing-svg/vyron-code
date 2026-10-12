# Vyron Code Desktop — Hermes API Server UAT Guide

This guide walks through the supported way to connect Vyron Code Desktop to your local
Hermes Agent's officially documented API Server, and what to expect at each step.

## What this connects to, and what it doesn't

Vyron Code Desktop's Hermes integration talks **only** to the Hermes Agent's OpenAI-compatible
**API Server** (`gateway/platforms/api_server.py` in the Hermes Agent source) — never to the
internal dashboard/TUI WebSocket route (`/api/ws`). The API Server is a separate, optional
component of Hermes Agent that must be explicitly enabled; it is not on by default.

The only thing Vyron Code ever does against it, even once "reachable," is one fixed liveness
check: `GET /health`. No prompt, task, workspace, file, session, or context data is ever sent —
this build has no capability to send any of that, by design.

## Prerequisites

- Hermes Agent (NousResearch) installed locally.
- Vyron Code Desktop built (`npm run build:electron`) and launchable via
  `scripts/start-desktop.ps1`.

## 1. Enable the Hermes API Server

The API Server is gated by three environment variables that Hermes Agent's own env-loading
mechanism reads from its `.env` override file (typically `%LOCALAPPDATA%\hermes\.env`):

```
API_SERVER_ENABLED=true
API_SERVER_KEY=<a strong random value — e.g. output of: openssl rand -hex 32>
API_SERVER_PORT=8642
```

Add these three lines yourself to that `.env` file (back up the file first). **Never commit
this file, and never paste the real key value into a chat, a report, or any file inside this
repository.**

Then (re)start the Hermes backend so it picks up the new variables:

```
hermes serve --host 127.0.0.1 --port <your dashboard port> --skip-build
```

(`hermes serve --status` shows whether it's already running; `hermes serve --stop` stops it
first if needed.)

## 2. Confirm the API Server is actually listening

From a terminal, on the machine running Hermes:

```
curl http://127.0.0.1:8642/health
```

A healthy response looks like `{"status": "ok", ...}` with no `Authorization` header sent —
this specific route is intentionally unauthenticated. If this fails, nothing in Vyron Code can
succeed either; fix this first.

## 3. Launch Vyron Code Desktop

Run `scripts\start-desktop.ps1` from the repository root (requires a fresh
`npm run build:electron` first if you've pulled new code).

## 4. Authorize Hermes for this session

In the **Hermes** section, click **Authorize Hermes for this session**, enter your
`API_SERVER_KEY` value into the credential field, and click **Authorize**.

- The credential is held only in this running desktop app's memory — never written to disk,
  never sent anywhere except as the `Authorization: Bearer <credential>` header on your later
  explicit verification request (and only if you configure the endpoint below).
- The **Authorize** button stays disabled while the field is empty — you must type something
  before it becomes clickable.
- On success, the panel reads **"Hermes: Authorized for this app session only."**

## 5. Configure the local endpoint

Click **Configure local Hermes connection**, enter your endpoint in the credential-free format:

```
http://127.0.0.1:8642
```

(or `http://127.0.0.1:8642/v1` — either is accepted; the app always probes the fixed `/health`
path at the origin regardless of which you enter). Check **"I trust this local Hermes companion
service"**, then click **Configure**.

- Only `http://` is accepted, only to `127.0.0.1`/`localhost`/`::1`/`[::1]`, only with an
  explicit non-zero port, and only with an empty, `/`, or `/v1` path — anything else is
  rejected safely with no network action taken.
- On success, the panel reads **"Ready to verify local Hermes API Server."**

## 6. Explicitly verify the connection

Click **Verify local Hermes connection**. This sends exactly one `GET <your-endpoint-origin>/health`
request from the Electron main process — never automatically, never repeated, never before you
click it.

**Expected success text:** `Local Hermes API Server reachable.`

## Safe failure states you may see, and what each one means

| UI text | Meaning | What to check |
|---|---|---|
| `Local Hermes API Server verification is unavailable in this build.` | The desktop bridge itself isn't available (should not happen in a normal build). | Rebuild with `npm run build:electron`; relaunch. |
| `Ready to verify local Hermes API Server.` (after clicking Verify, i.e. reverted) with an error line `Verification could not be completed. Please try again.` | The request failed after being sent — usually a non-2xx HTTP response. | Confirm `API_SERVER_ENABLED=true` really took effect (step 2's `curl` check) and that the port you configured matches `API_SERVER_PORT`. |
| No state change reachable at all / stuck on `endpoint_not_configured` | Endpoint was never accepted. | Re-check the endpoint format against step 5's exact rules. |

None of these ever reveal a raw HTTP status code, header, body, your API key, or the endpoint
you entered — by design, so this guide is the only place those specifics are explained.

## What verifying does **not** do

- It never sends your task draft, any workspace content, file, search result, or Git
  information.
- It never creates a session, sends a prompt, or requests a chat completion.
- It never retries automatically, polls, or reconnects — one click, one request.

## Handling your API key

- Generate it yourself (`openssl rand -hex 32` or equivalent) — never ask an assistant session
  to invent or reveal one to you in chat.
- Type it only into Vyron Code's own credential field, or your `.env` file.
- Never commit it, paste it into an issue/report, or share a screenshot that includes it.
