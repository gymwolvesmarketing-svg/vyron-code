# Vyron Code Desktop — D-11 Local Hermes Task Submission: Setup & UAT

This is the complete, current guide for the explicit reviewed task submission feature. It
supersedes the older `VYRON_CODE_HERMES_UAT_GUIDE.md` / `VYRON_CODE_HERMES_REAL_UAT_GUIDE.md`
(health-verification-only) guides for anything task-related.

## What this feature does — and does not do

You can now type a short task, review the exact text that will be sent, and explicitly send it
to your local Hermes installation. You'll get back one plain-text answer.

It does **not**: create a session, remember anything between sends, attach your workspace/
files/search results/Git info, pick a model or provider, stream a response, or let Hermes use
any tool (terminal, filesystem, browser, web, code execution, memory, delegation, MCP) — all of
that is disabled for this connection, verified live (see below).

## 1. Prerequisites (one-time)

You need three things running/configured:

1. **Tool isolation** — already applied to your Hermes config this session:
   `platform_toolsets.api_server: ["no_mcp"]` in `%LOCALAPPDATA%\hermes\config.yaml`. Live-
   verified: `GET /v1/toolsets` now reports zero enabled toolsets for the `api_server`
   platform. No further action needed unless you've reinstalled Hermes since.

2. **The Hermes gateway (hosts the API Server)**:
   ```
   hermes gateway run
   ```
   Check it's running with `hermes gateway status`.

3. **The local auth proxy** (the installed Hermes version doesn't enforce your API key on the
   task endpoint itself — this proxy does, so nothing on your machine can use it without your
   key):
   ```
   HERMES_API_SERVER_KEY=<your API_SERVER_KEY from %LOCALAPPDATA%\hermes\.env> `
   HERMES_UPSTREAM_PORT=8642 HERMES_PROXY_PORT=8643 `
   node scripts/hermes-auth-proxy.mjs
   ```
   Leave this running in its own terminal window alongside Hermes.

## 2. Start Vyron Code Desktop

```
.\scripts\start-desktop.ps1
```
(rebuild first with `npm run build:electron` if you've pulled new code.)

## 3. Authorize, configure, verify (same as before)

1. **Authorize Hermes for this session** — type your `API_SERVER_KEY`, click Authorize.
2. **Configure local Hermes connection** — enter `http://127.0.0.1:8643` (the **proxy's** port,
   not Hermes's own 8642), check the trust box, click Configure.
3. **Verify local Hermes connection** — should reach "Local Hermes API Server reachable."

## 4. Write, review, and send a task

1. In the **Task** section, type your task into the draft box.
2. Click **Review task draft**.
3. The review screen shows:
   - The exact text that will be sent, verbatim.
   - **"Only this task text will be sent."**
   - **"No workspace, file, search result, Git data or selected context is sent."**
   - **"Hermes tools and persistent task history are disabled for this connection."**
   - Whether the connection is verified.
4. If everything looks right, click **Send reviewed task**.
5. Status moves through **"Ready to send." → "Sending…" → "Completed."**, and the answer
   appears as plain text underneath.

If you edit the draft, you'll need to click **Back to draft** and **Review task draft** again —
a review can never be sent stale.

## 5. Clearing state

- **Close review** or **Back to draft** clears any reviewed/sent task.
- **Clear Hermes authorization** or clearing your endpoint configuration also clears it.
- Quitting the app clears everything — nothing about your task or the answer is saved anywhere,
  by Vyron Code, between runs.

## 6. Rotating your API key

If you ever need a new key: generate one yourself (`openssl rand -hex 32`), update
`API_SERVER_KEY=` in `%LOCALAPPDATA%\hermes\.env`, restart `hermes gateway run`, and restart
`scripts/hermes-auth-proxy.mjs` with the new value in `HERMES_API_SERVER_KEY`. Then re-authorize
in Vyron Code with the new key.

## Known limitation — please read

Hermes's own installed task-persistence behavior (writing your prompt/response/session data to
its local database) is **not** disabled by anything in this setup — only the tool-access and
authentication gaps were addressed. See `hermes-patches/0001-api-server-task-auth-and-ephemeral-history.patch`
if you'd like to apply the (unsupported, source-level) fix for that yourself; it wasn't applied
automatically, by design.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Authorize Hermes before sending a task." | Not authorized, or authorization was cleared. |
| "Not available in this build." on the send row | Endpoint isn't configured yet. |
| Configure/Send buttons stay disabled | Check you used `http://127.0.0.1:8643` (not `8642`) and a non-empty draft. |
| "The task could not be completed. Please try again." | The proxy or Hermes gateway isn't running, or your key doesn't match — check both terminal windows. |
| Answer is provider-related error text like "free tier" or "403" | This is Hermes's own configured model backend responding, not a Vyron Code or proxy issue — check your own Hermes model/provider setup. |
