# LocalClaw Runbook

## Phase Schedule

- Phase 7A: complete. CLI control, `.env` token discovery, project allowlist, chat sessions, actors, and plan-gated task creation are implemented.
- Phase 7B: complete. React/Vite operator UI is served by the local control API with dashboard, tasks, approvals, projects, skills, and chat.
- Phase 7C: complete. Operator cockpit polish and reliability pass includes sidebar navigation, chat-first workspace, visible token state, faster chat fallbacks, task timeline, approval UX, diagnostics, and clearer empty/error states.
- Phase 8: not started. Safe-Commit workflow begins after the Phase 7 operator surface is usable for normal project intake.

## Start LocalClaw

From the project root:

```bash
cd /Users/aritrarpal/Documents/workspace_biz/localclaw
pm2 start pm2.config.cjs
pm2 status
pm2 logs localclaw
```

If `localclaw` is already registered in PM2:

```bash
cd /Users/aritrarpal/Documents/workspace_biz/localclaw
pm2 restart localclaw
pm2 logs localclaw
```

If you changed `.env`, reload the process with the new environment:

```bash
cd /Users/aritrarpal/Documents/workspace_biz/localclaw
pm2 restart localclaw --update-env
pm2 logs localclaw
```

## Confirm Boot Complete

After startup, confirm the logs include these milestones:

- `Telegram bot started`
- `Orchestrator started`
- `LocalClaw bootstrap complete`

Then confirm from Telegram:

```text
/status
```

You should see:

- `Boot phase: boot_complete`
- `Polling active: yes`

## Stop LocalClaw

Stop the running app but keep the PM2 process entry:

```bash
pm2 stop localclaw
```

Remove the PM2 process entry completely:

```bash
pm2 delete localclaw
```

## Check Status

```bash
pm2 status
```

## CLI-First Control

Enable local control API in `.env`:

```bash
CONTROL_API_ENABLED=true
CONTROL_API_HOST=127.0.0.1
CONTROL_API_PORT=4173
CONTROL_API_TOKEN=change_me
LOCALCLAW_WORKSPACE_ROOTS=/Users/aritrarpal/Documents/workspace_biz
UI_ENABLED=true
UI_DIST_DIR=web/dist
```

Restart with env refresh:

```bash
pm2 restart localclaw --update-env
```

Use CLI from project root:

```bash
npm run cli -- doctor
npm run cli -- status
npm run cli -- projects list
npm run cli -- projects add /Users/aritrarpal/Documents/workspace_biz/localclaw --name localclaw
npm run cli -- chat --project /Users/aritrarpal/Documents/workspace_biz/localclaw --actor architect
npm run cli -- task init --file localclaw.task.json
npm run cli -- task plan --file localclaw.task.json
npm run cli -- task run --file localclaw.task.json --approve
```

The CLI discovers `CONTROL_API_TOKEN` from `.env`, so normal usage should not require pasting the token. It waits briefly for the local API before mutating commands. To make manual checks deterministic after a restart:

```bash
until curl -sf http://127.0.0.1:4173/health >/dev/null; do sleep 1; done
```

Telegram remains focused on alerts and deploy approvals.

## Browser Operator UI

Install/build the Vite UI when dependencies are available:

```bash
npm --prefix web install
npm run ui:build
pm2 restart localclaw --update-env
```

Open:

```text
http://127.0.0.1:4173/
```

The dashboard is read-only without a token. Paste `CONTROL_API_TOKEN` into the mutation token box only when you need to approve, reject, create sessions, add projects, or plan tasks. The UI stores the token in browser session storage only.
