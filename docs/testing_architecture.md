# Testing Architecture

## Current Automated Coverage

- `tests/telegram_commands.test.js`
  - verifies `/start`, `/status`, `/add`, `/tasks`, `/pause`, `/resume`, and `/kill`
  - uses the LocalClaw Postgres schema
- `tests/project_contract.test.js`
  - verifies repo-contract seeding
  - verifies `.gitignore` baseline rules
  - verifies workspace junk cleanup
- `tests/planner.test.js`
  - verifies planner fallback behavior for incomplete model JSON

## Current Manual Verification

- PM2 boot health
- Telegram operator flow
- generated workspace inspection on SSD
- GitHub publish verification
- Railway Phase 4 approval and deploy verification

## Runbook

```bash
cd /Users/aritrarpal/Documents/workspace_biz/localclaw
node --test
```

## Next Gaps

- publish flow integration test with a mocked GitHub client
- Railway deploy integration test with a mocked Railway client
- end-to-end Phase 4 task replay with planner, publish, approval, and deploy state assertions
