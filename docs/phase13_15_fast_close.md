# Phase 13-15 Fast Close

Purpose: close the remaining roadmap with the smallest set of high-leverage implementation slices instead of treating Phases 13, 14, and 15 as three large independent projects.

## What Already Exists

Phase 13 is now complete:

- repair proposal generation exists in `src/selfhealing/repairEngine.js`
- failed execution can enter `needs_repair`
- repair approvals exist in Telegram and the orchestrator
- approved repairs can now resume immediately through the orchestrator instead of waiting only for the next poll cycle
- repair retries are bounded with persisted cooldown metadata and self-healing learnings
- structured operator diagnostics and allowlisted proactive remediations are now part of the runtime loop

Phase 14 is now complete:

- persistent chat messages already exist in `chat_sessions` and `chat_messages`
- structured `chat_summary_v1` state now persists on chat sessions and summary history rows
- explicit and inferred operator preferences now persist with confidence and evidence metadata
- chat can auto-draft approval-gated tasks from imperative requests
- chat can now keep a rolling draft contract, request clarification for vague execution asks, and auto-plan after the follow-up fills the gap
- the browser chat workspace now exposes session summary, preferences, draft readiness, clarification gaps, and direct planning from the current ready draft
- follow-up turns can now refine structured contract fields such as scope, constraints, success criteria, priority, and deploy intent before planning
- chat can approve the single pending task from natural language

Phase 15 groundwork is already present:

- evidence-bound narrated summaries already exist in `src/persona/artifacts.js`
- channel drafts already exist for Telegram and UI
- repair handoff narration already exists
- review-comment drafts and proactive observation artifacts already exist
- operator persona settings now persist in `agent_state` and are editable through the control API and browser UI
- orchestrator persona generation now consumes those settings plus chat-session preferences when building task persona artifacts

## Fastest Closure Order

### 1. Finish Phase 15 by wiring persona outputs to controls and channels

Most of the narration primitives already exist. What is left is integration and governance.

Remaining work:

- add channel adapters so Telegram, UI, and GitHub render from the same evidence bundle with different policies
- gate GitHub review-comment publication behind explicit approval or config
- add golden tests that verify narrated output stays evidence-bound
- persist preference profiles separately from task artifacts when the controls outgrow the current global settings profile

Exit criteria:

- persona output is configurable per operator and channel
- GitHub feedback is generated from the same evidence model as Telegram and UI summaries
- narration remains non-authoritative and testable

## Recommended Sequence

1. Add approval-gated GitHub review publication using the existing persona artifacts.
2. Add dedicated channel adapters for Telegram, UI, and GitHub policy differences.
3. Add golden tests last so the behavior is locked before future expansion.

## Suggested Next Concrete Tasks

1. Add approval-gated GitHub review draft publication using existing persona artifacts.
2. Add dedicated channel adapters and policy tests.
3. Add golden evidence-bound narration tests across Telegram, UI, and GitHub drafts.
