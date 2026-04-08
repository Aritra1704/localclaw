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
