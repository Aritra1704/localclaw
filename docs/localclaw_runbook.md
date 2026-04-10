# LocalClaw Runbook

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
```

Restart with env refresh:

```bash
pm2 restart localclaw --update-env
```

Use CLI from project root:

```bash
npm run cli -- status
npm run cli -- task init --file localclaw.task.json
npm run cli -- task plan --file localclaw.task.json --token "$CONTROL_API_TOKEN"
npm run cli -- task run --file localclaw.task.json --approve --token "$CONTROL_API_TOKEN"
```

The CLI waits briefly for the local API before mutating commands. To make manual checks deterministic after a restart:

```bash
until curl -sf http://127.0.0.1:4173/health >/dev/null; do sleep 1; done
```

Telegram remains focused on alerts and deploy approvals.
