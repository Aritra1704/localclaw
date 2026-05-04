# Phase 13-15 Fast Close

Purpose: close the remaining roadmap with the smallest set of high-leverage implementation slices instead of treating Phases 13, 14, and 15 as three large independent projects.

## What Already Exists

Phase 13 groundwork is already present:

- repair proposal generation exists in `src/selfhealing/repairEngine.js`
- failed execution can enter `needs_repair`
- repair approvals exist in Telegram and the orchestrator
- approved repairs can now resume immediately through the orchestrator instead of waiting only for the next poll cycle

Phase 14 groundwork is already present:

- persistent chat messages already exist in `chat_sessions` and `chat_messages`
- chat can auto-draft approval-gated tasks from imperative requests
- chat can approve the single pending task from natural language

Phase 15 groundwork is already present:

- evidence-bound narrated summaries already exist in `src/persona/artifacts.js`
- channel drafts already exist for Telegram and UI
- repair handoff narration already exists
- review-comment drafts and proactive observation artifacts already exist

## Fastest Closure Order

### 1. Finish Phase 13 as the shared execution substrate

This phase should be closed first because Phase 14 and 15 both benefit from a more reliable execution loop.

Remaining work:

- add retry budget and exponential back-off around repair attempts
- persist repair attempt count and last repair outcome on the task record
- feed successful repairs into reflection and knowledge-graph learnings
- add narrow proactive operational remediations behind explicit allowlists
- add operator-facing diagnostics that explain why auto-repair stopped

Exit criteria:

- a failed task can attempt bounded self-repair without manual queue babysitting
- every repair attempt is visible in task runtime and logs
- exhausted repair loops produce a clean human handoff with next actions

### 2. Finish Phase 14 with one compact conversational loop

Do not build a general chat platform. Close only the missing planning loop.

Remaining work:

- store rolling session summaries so long chats stay bounded
- add iterative contract refinement instead of one-shot task drafting
- distinguish clarification questions from execution-ready requests
- extract operator preferences from chat into structured metadata
- expose chat summary and preference state in the control API and UI

Exit criteria:

- chat can refine a task over multiple turns without losing context
- long sessions stay compact because summaries replace raw history where appropriate
- operator preferences become machine-readable state instead of prompt-only convention

### 3. Finish Phase 15 by wiring persona outputs to controls and channels

Most of the narration primitives already exist. What is left is integration and governance.

Remaining work:

- add operator controls for verbosity, teaching depth, proactive observations, and GitHub voice
- add channel adapters so Telegram, UI, and GitHub render from the same evidence bundle with different policies
- gate GitHub review-comment publication behind explicit approval or config
- add golden tests that verify narrated output stays evidence-bound
- persist preference profiles separately from task artifacts

Exit criteria:

- persona output is configurable per operator and channel
- GitHub feedback is generated from the same evidence model as Telegram and UI summaries
- narration remains non-authoritative and testable

## Recommended Sequence

1. Close the remaining Phase 13 executor/repair gaps.
2. Add chat summaries plus preference extraction for Phase 14.
3. Bind those preferences into Phase 15 channel controls.
4. Add golden tests last so the behavior is locked before future expansion.

## Suggested Next Concrete Tasks

1. Add repair retry budget, attempt counters, and back-off metadata.
2. Persist chat session summaries and preference extraction artifacts.
3. Add persona/operator settings to the control API and browser UI.
4. Add approval-gated GitHub review draft publication using existing persona artifacts.
