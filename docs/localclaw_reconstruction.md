# LocalClaw Reconstruction Plan

This document replaces the earlier reconstruction note with a code-checked recovery plan. Parts of the old diagnosis were accurate, but several items were already implemented and should not drive the next round of work.

## What Is Already Present

These items are not the current blockers:

1. **The orchestrator already has an active polling loop.**
   `src/orchestrator.js` starts a timer, performs an immediate tick, and recovers interrupted tasks on startup.

2. **A persistence runner already exists.**
   `pm2.config.cjs` is already checked in and is the intended long-running process wrapper.

3. **Telegram is optional, not a boot requirement.**
   `src/telegram/bot.js` returns `null` when Telegram credentials are missing, so missing Telegram config alone does not kill boot.

4. **The chat timeout fix is already in place.**
   `src/control/chat.js` already uses a 60 second model timeout.

5. **The deterministic fallback planner is no longer empty.**
   `src/agent/planner.js` already emits bounded fallback steps including `list_files` and fallback notes.

6. **Railway repository-name mismatch is already permissive.**
   `src/railway/deployer.js` warns on name mismatch instead of hard-blocking deployment.

## Verified Pain Points

These are the actual breakpoints based on source review plus a local smoke run of `node src/index.js`:

### 1. Boot Still Hard-Depends On PostgreSQL

- `src/config.js` requires `DATABASE_URL`.
- `src/index.js` runs migrations before anything else.
- When PostgreSQL is unavailable, boot fails immediately.
- This was reproduced locally: bootstrap exited before the orchestrator started because the database connection could not be opened.

### 2. Local Bootstrap Assumes A Pre-Existing External Workspace Path

- `src/index.js` currently requires `SSD_BASE_PATH` and checks it before the app starts.
- The default examples still point at external-volume paths and older model assignments.
- A fresh machine or a clean clone does not have a repo-local bootstrap path.

### 3. There Is No Single Local-Only Start Path

- GitHub and Railway are already optional in code, but there is no operator-facing script that:
  - provisions a local database,
  - selects repo-local storage,
  - disables publish/deploy integrations,
  - runs migrations,
  - and starts the process with sane local defaults.

### 4. Ollama Warmup Is Still Missing

- `src/llm/ollama.js` forwards `keep_alive`, but it does not prewarm models.
- Cold local models can still fail the first request path or appear hung while weights load.
- This is now a resilience gap more than a pure timeout-constant problem.

### 5. Operator Docs Drifted Away From The Real Boot Story

- The old reconstruction note claimed the heartbeat loop was missing, which is no longer true.
- `.env.example` still advertises outdated model defaults and a non-local SSD path.
- The current repo needs a local-first start flow that matches the actual runtime expectations.

## Recovery Plan

### Step 1. Rebuild The Local Bootstrap Foundation

Fix all prerequisites required to get a clean local instance up without external services.

- Add a root `docker-compose.yml` for local PostgreSQL.
- Add a startup script that creates repo-local storage, starts PostgreSQL, runs migrations, and launches LocalClaw in local-only mode.
- Refresh `.env.example` so it reflects stable local defaults instead of stale model and storage values.

### Step 2. Add Explicit Local-Only Runtime Mode

Reduce hidden configuration coupling in bootstrap itself.

- Add a first-class local/offline mode flag in config.
- Let bootstrap derive safe defaults for GitHub, Railway, Telegram, and the control API from that mode.
- Make the workspace storage path auto-creatable instead of assuming a pre-mounted external disk.

### Step 3. Harden Ollama Cold-Start Behavior

Improve first-request reliability for local models.

- Add configurable model warmup during bootstrap.
- Add a longer first-run timeout or retry path for cold models.
- Surface clearer diagnostics when the model exists but is still loading.

### Step 4. Bring Operator Docs Back In Sync

After the runtime changes land:

- update the runbook to prefer the local bootstrap script,
- document the PM2 path as the persistence layer,
- and clearly separate local-only mode from publish/deploy-enabled mode.

## Step 1 Status

Completed in this pass:

- `docker-compose.yml` now provisions a local PostgreSQL instance on `127.0.0.1:54329`.
- `scripts/start-local.sh` now creates repo-local storage, starts PostgreSQL, runs migrations, and launches LocalClaw with local-first defaults.
- `.env.example` now reflects local defaults instead of the older external-disk and model assumptions.

## Step 2 Status

Completed in this pass:

- `LOCAL_ONLY_MODE` now exists in config.
- local-only mode disables Telegram, GitHub publish, and Railway deploy at config resolution time.
- bootstrap now creates the storage directory instead of assuming it already exists.
- local-only mode now forces repo-local workspace storage and repo-local workspace roots.

## Step 3 Status

Completed in this pass:

- the Ollama client now enforces configurable per-request timeouts,
- generation and embedding calls now get a bounded retry after retryable local failures,
- retryable first-request failures trigger a forced model warmup before the retry,
- bootstrap now performs a best-effort warmup pass across planner, coder, fast, review, and embedding models.

## Remaining Work

The next remaining boundary is operator-document sync beyond this reconstruction note, plus a full end-to-end runtime smoke test of `scripts/start-local.sh` against a live Docker + Ollama environment.
