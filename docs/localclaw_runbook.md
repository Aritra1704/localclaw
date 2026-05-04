# LocalClaw Runbook

## Phase Schedule

- Phase 7A-7C: complete. CLI control, Browser UI, and Operator Cockpit are stable.
- Phase 8: complete. Safe-Commit proving run is finished.
- Phase 9: complete. Hardening, Docker Sandboxing, and Space Guard are implemented.
- Phase 10: complete. Specialized Agent Expansion (Security, Docs, Deps) now gates finalization and creates dependency follow-up work.
- Phase 11: complete. Internal MCP servers now standardize filesystem, PostgreSQL-backed runtime state, RAG indexing/retrieval, reflection, chat, projects, skills, and GitHub operations.
- Phase 12: complete. Knowledge graph storage, graph-based retrieval, semantic impact analysis, and historical learnings are integrated into planning and approval previews.
- Phase 13: complete. Repair proposal generation, immediate repair resume, bounded retry budget, self-healing learnings, structured operator diagnostics, and allowlisted proactive remediations are now in place.
- Phase 14: complete. Persistent chat context, structured `chat_summary_v1` summaries, preference extraction, clarification-driven contract refinement, and browser chat visibility are now in place.
- Phase 15: planned. Persona Layer and Humanized Presence will stay post-execution and non-authoritative while adding evidence-bound narration, operator preference profiles, channel adapters, optional "by the way" observations, and approval-gated GitHub voice.

## Start LocalClaw

### 1. Start Ollama (on External SSD)

Since all models are stored on `Ari_SSD_01`, you must tell the system where to find them before launching the Ollama app.

From your Terminal:

```bash
# 1. Set the environment variable for the current session and system manager
launchctl setenv OLLAMA_MODELS "/Volumes/Ari_SSD_01/AI_MODELS/ollama/models"

# 2. Restart the Ollama App
# (Quit Ollama from the menu bar first, then run:)
open /Applications/Ollama.app
```

### 2. Start the Orchestrator (PM2)

```bash
cd /Users/aritrarpal/Documents/workspace_biz/localclaw
pm2 start pm2.config.cjs
until curl -sf http://127.0.0.1:4173/health >/dev/null; do sleep 1; done
pm2 status
pm2 logs localclaw
```

### 3. Use the CLI

LocalClaw is now globally linked. You can run it from **any directory** without `npm run cli`.

```bash
localclaw status
localclaw doctor
localclaw chat --project .
```

## First-Time Bootstrap
...
## CLI-First Control

Enable local control API in `.env`:

```bash
CONTROL_API_ENABLED=true
CONTROL_API_HOST=127.0.0.1
CONTROL_API_PORT=4173
CONTROL_API_TOKEN=...
LOCALCLAW_WORKSPACE_ROOTS=/Users/aritrarpal/Documents/workspace_biz
UI_ENABLED=true
UI_DIST_DIR=web/dist
```

The CLI discovers `CONTROL_API_TOKEN` from `.env`, so normal usage should not require pasting the token. 

Commands (can be run from anywhere):

```bash
localclaw doctor
localclaw status
localclaw projects list
localclaw projects add /Users/aritrarpal/Documents/workspace_biz/my-project
localclaw chat --project /Users/aritrarpal/Documents/workspace_biz/my-project
localclaw task init --file task.json
localclaw task run --file task.json --approve
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

For live frontend development with Vite:

Terminal 1:

```bash
cd /Users/aritrarpal/Documents/workspace_biz/localclaw
npm run dev
```

Terminal 2:

```bash
cd /Users/aritrarpal/Documents/workspace_biz/localclaw
npm run ui:dev
```

Open:

```text
http://127.0.0.1:5173/
```

`5173` is the Vite dev UI. `4173` is the built UI served by LocalClaw.

## Chat And Task Flow

In the browser chat:

- `Send` stays conversational for discussion prompts, but a clear execution-style request can now create an approval-gated task automatically.
- `Plan task` creates a real task from the current prompt and links it to the chat session.
- Session tasks also appear in the `Tasks` view.

Current execution approval behavior:

- Auto-created chat tasks still stop in `waiting_approval`; they do not execute until you approve them.
- If a task is in `waiting_approval`, you can approve it directly from the chat runtime card or the task detail view.
- CLI and API approval paths still work and are useful for manual or scripted operation.
- After approval, CLI chat prints the current phase immediately and then emits short heartbeat lines if the task is still queued, planning, working, or verifying for a while.

Approve a task from CLI:

```bash
cd /Users/aritrarpal/Documents/workspace_biz/localclaw
npm run cli -- task approve <task-id>
```

Approve a task from API:

```bash
curl -X POST http://127.0.0.1:4173/v1/tasks/<task-id>/approve-execution \
  -H "Authorization: Bearer <CONTROL_API_TOKEN>" \
  -H "Content-Type: application/json"
```

Reject a task from CLI:

```bash
cd /Users/aritrarpal/Documents/workspace_biz/localclaw
npm run cli -- task reject <task-id> "Rejected by operator"
```

## Task States

Common task states in the UI:

- `waiting_approval`: plan preview exists and execution has not started yet
- `pending`: approved and queued for execution
- `in_progress`: workspace preparation, planning, tool steps, or verification are running
- `blocked`: execution stopped and needs operator attention
- `done`: task completed successfully
- `failed`: execution failed

Important note:

- `Approvals` in the sidebar is for deployment approvals.
- Plan-gated task execution approval is separate from deployment approval.

Examples of `blocked` reasons:

- deployment target mismatch
- publish target mismatch
- verification requested human follow-up
- execution tool failure

## Live Runtime Context

While a task is active, the chat view and task detail view now show a transient runtime panel with:

- current stage
- current model when an LLM call is active
- prompt and output token counts when available
- load and total duration when available
- current step
- checklist of planned steps with `pending`, `current`, `completed`, or `failed`

This runtime context is intentionally transient:

- it is kept in process memory only
- it is not stored in the database
- after restart or after the live snapshot is gone, the UI falls back to persisted task/log context

## Recent UI Changes

Recent operator UI behavior now includes:

- more neutral visual styling instead of the earlier pink-heavy theme
- clearer fetch and validation error messages
- project delete action in the `Projects` view
- live runtime context for active tasks
- safer fallback handling when the local chat model is slow

Localclaw:
cd /Users/aritrarpal/Documents/workspace_biz/localclaw
pm2 start pm2.config.cjs
until curl -sf http://127.0.0.1:4173/health >/dev/null; do sleep 1; done
pm2 status
pm2 logs localclaw


CLI:
localclaw status
localclaw doctor
localclaw chat --project .


UI:
cd /Users/aritrarpal/Documents/workspace_biz/localclaw
npm run ui:dev

http://127.0.0.1:5173/
