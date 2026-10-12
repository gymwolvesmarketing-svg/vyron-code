# Vyron Code Desktop — Real Hermes UAT Guide

Your local Hermes API Server is now enabled and running. This guide is the last step: clicking
through the real desktop app yourself to see it succeed.

## 1. Confirm Hermes is still running

```
hermes gateway status
```

Should show `✓ Gateway is running`. If it isn't, start it with:

```
hermes gateway run
```

(leave that window/process running — closing it stops the API Server).

## 2. Start Vyron Code Desktop

From the repository root:

```
.\scripts\start-desktop.ps1
```

## 3. Authorize Hermes

In the **Hermes** section, click **Authorize Hermes for this session**, type your
`API_SERVER_KEY` value into the credential field (find it in your own
`%LOCALAPPDATA%\hermes\.env` file — never share or paste it anywhere else), and click
**Authorize**.

Expected: **"Hermes: Authorized for this app session only."**

## 4. Configure the endpoint

Click **Configure local Hermes connection**. Enter:

```
http://127.0.0.1:8642
```

Check **"I trust this local Hermes companion service"**, then click **Configure**.

Expected: **"Ready to verify local Hermes API Server."**

## 5. Verify

Click **Verify local Hermes connection**.

Expected: **"Local Hermes API Server reachable."**

If you see this, the integration is working end-to-end against your real local Hermes
installation.

## If something doesn't match

- **Stuck on "Authorization could not be stored..."** — make sure you actually typed
  something into the credential field; the button won't enable for an empty field.
- **Configure button stays disabled** — double-check you typed exactly `http://127.0.0.1:8642`
  (must start with `http://`, not `ws://`) and checked the trust box.
- **"Local Hermes API Server verification is unavailable in this build."** or
  **"Verification could not be completed. Please try again."** — confirm `hermes gateway
  status` still shows running, and that you used port `8642` (the port configured in your
  `.env`'s `API_SERVER_PORT`).

None of these screens ever show your key, the endpoint, or any raw server response — by
design.

## What this does and doesn't do

- Verifying sends exactly one plain `GET /health` request. Nothing else.
- No task, prompt, workspace, file, or Git data is ever sent by this action.
- No session is created, no chat is started.
- Nothing here is saved between app restarts — you'll authorize and configure again next time
  you open the app.
