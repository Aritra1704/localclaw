# Phase 16: Local-First Coding Agent Core

Date: 2026-05-04
Status: complete

## Purpose

Phase 16 refocuses LocalClaw from a universal approval-gated workflow engine into a local-first coding agent:

- safe local coding and documentation tasks should plan and run with low friction
- publish, deploy, and other external/public actions should remain approval-gated
- project identity should control repository and deploy routing
- browser automation should be possible without exposing the operator's normal browser session

## Delivered

- explicit `executionPolicy` support in `task_contract_v1`
- deterministic execution classes for local-only vs external/public work
- local-only auto-run after planning in chat and file-based task execution paths
- per-project GitHub, Railway, and browser-origin metadata
- publish/deploy routing based on project metadata instead of one global target
- structured `plan_v1`, `execution_summary_v1`, and `verification_summary_v1` artifacts
- document-oriented artifacts such as `phase_plan_v1`, `implementation_note_v1`, and `task_handoff_v1`
- isolated browser automation scaffolding with origin allowlists and screenshot support

## Operator Expectations

After Phase 16:

- a local-only request such as creating a markdown file, editing project files, or running local tests should be able to start immediately after planning
- a task that requests publish, deploy, or another external/public action should still stop in `waiting_approval`
- missing repository or deploy mappings should block only the external task path, not local-only work

## Rollout Steps

Run these steps before judging the new behavior:

```bash
cd /Users/aritrarpal/Documents/workspace_biz/localclaw
npm install
npm run migrate
pm2 restart localclaw --update-env
until curl -sf http://127.0.0.1:4173/health >/dev/null; do sleep 1; done
```

Then start a fresh chat session:

```bash
localclaw chat --project .
```

## Known Caveat

If a long-running CLI session or PM2 process was started before the Phase 16 rollout, chat may still print legacy approval-gated wording even when the task actually runs in the background. In that case:

- restart PM2
- start a fresh chat session
- check the task with `localclaw status` or `/status <task-id>`

This is an operator-surface consistency issue, not the intended execution policy.
