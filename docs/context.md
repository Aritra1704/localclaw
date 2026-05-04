# LocalClaw Context

Version: 1.5
Date: 2026-05-04  
Purpose: end-to-end execution context and checkpoint guide for LocalClaw delivery

## 0. Current Phase Status

As of 2026-05-04, the project status is:

| Phase | Status | Notes |
|---|---|---|
| Phase 0: Preflight | complete | SSD layout is ready, mandatory local model baseline is present, Telegram token and chat ID are available, DB credentials are verified, and Railway token can be added later. |
| Phase 1: Foundation | complete | repo scaffold, env handling, migration runner, dedicated `localclaw` schema, orchestrator bootstrap, PM2 config, Telegram command wiring, command-handler integration testing, and live Telegram polling verification are complete. |
| Phase 2: LLM and Tool Execution | complete | Ollama client, planner, workspace tool registry, task executor, and verifier are implemented. A live Telegram task generated `src/app.js` and `README.md` in the controlled workspace and verified successfully. |
| Phase 3: Git and GitHub | complete | Git wrapper, GitHub client, and auto-publish flow are implemented. A live task pushed successfully to GitHub with repo linkage and publish logs captured in the DB. |
| Phase 4: Deploy Gate Checkpoint | complete | Railway deploy workflow now includes end-to-end approval and successful deployment evidence. Telegram inline Approve/Reject buttons are active, and deployment retry handling is in place for fast-fail/no-log Railway responses. |
| Phase 5: RAG and Learnings | complete | Planner receives retrieved historical context from learnings/doc chunks, completed tasks persist extracted learnings, and retrieval behavior is covered by tests. |
| Phase 6: Skills Manager | complete | Built-in skill registry, enablement policy, skill run logging, guarded generated skills, and skill tests are implemented. |
| Phase 7A: CLI Control Plane | complete | Local control API, `.env` token discovery, `doctor`, project allowlist, chat sessions, actors, and plan-gated task creation are implemented. |
| Phase 7B: Browser Operator UI | complete | React/Vite UI is served by LocalClaw and covers dashboard, tasks, approvals, projects, skills, and chat. |
| Phase 7C: Operator Cockpit Reliability | complete | Sidebar navigation, chat-first workspace, visible token state, faster chat fallbacks, task timeline, approval UX, diagnostics, and clearer empty/error states are implemented. |
| Phase 8: Safe-Commit Proving Run | complete | LocalClaw has successfully executed its first major proving mission (Safe-Commit) and stabilized the multi-agent routing engine. |
| Phase 9: Hardening & Sandbox | complete | Mandatory Docker sandbox escalation, workspace cleanup protections, and operator-safe recovery guardrails are in place. |
| Phase 10: Specialized Agents | complete | Documentation, Security, and Dependency agents now run before publish, refresh workspace docs, flag risky findings, and create dependency follow-up tasks. |
| Phase 11: MCP Integration | complete | Filesystem, GitHub, task/runtime PostgreSQL access, RAG indexing/retrieval, reflection, chat, projects, and skills now run through internal MCP-style servers with verified runtime coverage. |
| Phase 12: Cognitive Memory | complete | Knowledge graph storage now maps files, symbols, dependencies, document references, historical changes, and related learnings, and semantic impact analysis is injected into planning and approval previews alongside flat RAG. |
| Phase 13: Self-Healing & Proactive Autonomy | complete | Repair proposal generation, immediate repair resume, bounded retry budget, self-healing learnings, structured operator diagnostics, and allowlisted proactive remediations are now in place. |
| Phase 14: Conversational Agent & Iterative Planning | in progress | Persistent chat context is live, `chat_summary_v1` persists summaries and preferences, and chat can now refine vague execution requests through a clarification loop before auto-planning; broader surfacing and deeper contract evolution remain open. |
| Phase 15: Persona Layer & Humanized Presence | planned | A channel-aware narration and preference layer will make LocalClaw sound like a consistent teammate across Telegram, UI, and GitHub. |

## 1. Mission

Build LocalClaw as a local always-on autonomous developer platform that can:

- accept work
- reason about the work using local models
- execute curated tools
- verify outputs
- push code
- request deploy approval
- deploy and report results

The first proving mission after LocalClaw reaches MVP is Safe-Commit.

## 2. Current Assumptions

- LocalClaw is a new standalone project and not an extension of the eCardFactory services.
- Ollama is the primary model runtime.
- Hugging Face is a secondary model source, not the default runtime path.
- Docker is available locally and may be introduced as a sandbox boundary when tool execution expands.
- Target machine is memory constrained enough that large multi-model parallelism is out of scope.
- `qwen2.5-coder:7b` is required for the intended coding path even if it must still be pulled.

## 3. Mandatory Model Baseline

| Model | Purpose | Requirement |
|---|---|---|
| `gemma4:e4b` | planning, review | mandatory |
| `qwen2.5-coder:7b` | coding, debugging | mandatory |
| `nomic-embed-text:latest` | embeddings | mandatory |

Optional and fallback models:

- `qwen2.5:7b-instruct`
- `llama3.1:8b`
- `mistral:7b`

## 4. Delivery Sequence

### Phase 0: Preflight

Inputs:

- Mac Mini ready
- PostgreSQL installed
- Ollama installed
- Docker available
- external SSD mounted
- tokens and credentials available

Actions:

- verify Ollama runtime health
- verify or pull mandatory models
- verify PostgreSQL access
- create Telegram bot and capture chat ID
- create GitHub fine-grained PAT
- capture Railway token
- define SSD layout

Outputs:

- environment readiness checklist completed
- required model status recorded
- runtime blockers identified early

Main blockers:

- Ollama CLI or HTTP instability
- missing `qwen2.5-coder:7b`
- missing credentials

### Phase 1: Foundation

Inputs:

- Phase 0 completed

Actions:

- bootstrap LocalClaw repo and folder layout
- create config loader and env validation
- create migrations and bootstrap schema
- implement Telegram bot
- implement orchestrator and task polling
- wire PM2 process config

Outputs:

- LocalClaw can start
- commands work
- task queue state changes are durable

Main blockers:

- broken DB connection
- invalid env handling
- Telegram callback routing errors

### Phase 2: LLM and Tool Execution

Inputs:

- stable core process
- working Ollama service

Actions:

- add Ollama client
- implement model selection
- implement planner schema and parser
- add curated tool registry
- create task executor
- add verifier skeleton

Outputs:

- LocalClaw can plan and execute a simple controlled task
- logs show step-by-step execution

Main blockers:

- invalid planner JSON
- missing coder model
- unsafe tool boundaries

### Phase 3: Git and GitHub

Inputs:

- Phase 2 execution path working

Actions:

- add git wrappers
- add GitHub API integration
- create repo bootstrap flow
- persist repo linkage in tasks and deployments

Outputs:

- task-generated code can be committed and pushed
- GitHub repo creation is automated

Main blockers:

- PAT scope mismatch
- git auth failures
- repo naming collisions

### Phase 4: Deploy Gate Checkpoint

Inputs:

- LocalClaw can already execute code tasks and push artifacts

Actions:

- add Railway integration
- add approval request and wait state
- capture deployment logs and status polling
- prove restart-safe recovery for in-progress tasks

Outputs:

- full MVP loop exists
- deploy remains approval gated
- failure and recovery evidence is captured

### Phase 5: RAG and Learnings

Inputs:

- stable Phase 4 MVP

Actions:

- add document ingestion
- add chunking and embeddings
- add retrieval injection
- add post-task learning extraction

Outputs:

- planning context improves using prior docs and prior runs

### Phase 6: Skills Manager

Inputs:

- reliable retrieval and execution foundation

Actions:

- define built-in skill format
- add registry and enablement policy
- add skill metrics and versioning
- allow generated skills only under explicit guardrails

Outputs:

- repeated workflows become reusable and governed

### Phase 7A: CLI Control Plane

Inputs:

- LocalClaw deploy and skill foundations are available
- operator needs a first-class terminal workflow

Actions:

- add local control API
- add CLI `.env` token discovery and `doctor`
- add project allowlist
- add chat sessions and actors
- keep execution plan-gated

Outputs:

- LocalClaw can be controlled from CLI without copying tokens
- chat can draft and plan tasks without bypassing approval

### Phase 7B: Browser Operator UI

Inputs:

- local control API
- CLI-first workflow

Actions:

- add React/Vite app served by LocalClaw
- expose dashboard, tasks, approvals, projects, skills, and chat
- keep mutations token-protected

Outputs:

- browser UI provides a local operator console

### Phase 7C: Operator Cockpit Reliability

Inputs:

- browser UI and chat control plane

Actions:

- add sidebar navigation
- make chat the primary workspace
- add visible token state
- reduce chat latency with bounded model fallback
- add task timeline, approval UX, diagnostics, and clear empty/error states

Outputs:

- LocalClaw has a usable cockpit for normal project intake

### Phase 8: Safe-Commit Proving Run

Inputs:

- LocalClaw Phase 4 checkpoint cleared
- RAG and skills available or at least partially available
- operator cockpit available

Actions:

- load Safe-Commit backlog
- execute prioritized tasks
- deploy with approval
- track quality, blockers, and learnings

Outputs:

- LocalClaw proves value on a real project

### Phase 9: Hardening & Sandbox Escalation

Inputs:

- real-world execution evidence from Phase 8

Actions:

- [x] introduce mandatory Docker sandbox enforcement for all `Executor` tasks
- [x] add automated backups for PostgreSQL and project workspaces
- [x] add failure auto-pause and "Self-Diagnostic" skill
- [x] refine health checks and resource controls for the external SSD

Outputs:

- LocalClaw is production-grade for personal autonomous use with zero-risk host impact

### Phase 10: Specialized Agent Domain Expansion

Inputs:

- stable hardening and multi-agent routing foundation

Actions:

- implement **Security Review Agent**: scans diffs for secrets and common CVEs
- implement **Documentation Agent**: autonomously updates HLDs and READMEs based on code changes
- implement **Dependency Agent**: monitors and creates tasks for patching outdated packages

Outputs:

- multi-layered autonomous review process before any code reaches the `Publisher`

### Phase 11: MCP Server Integration & Tool Standardization

Inputs:

- requirements for standardized tool access across models

Actions:

- implement **Filesystem MCP Server** for standardized workspace file operations
- implement **PostgreSQL MCP Server** for task/runtime state, approvals, deployments, chat, projects, skills, RAG indexing/retrieval, and reflection workflows
- implement **GitHub MCP Server** for repository creation and lookup during publish flows
- migrate the active runtime paths onto those internal MCP boundaries while retaining direct-SQL fallback compatibility

Outputs:

- decoupled, standardized internal tool ecosystem that isolates runtime capabilities behind MCP-style interfaces and sets up Phase 12 memory work on a stable boundary

### Phase 12: Knowledge Graph & Cognitive Memory

Inputs:

- large-scale project context exceeding flat RAG capabilities

Actions:

- implement **Knowledge Graph**: map symbols, dependencies, and historical changes
- integrate graph-based retrieval into the `Planner`
- add **Semantic Reasoning Layer**: for impact analysis before any code is written

Current progress:

- knowledge graph storage now exists in PostgreSQL for nodes and edges
- project sync now indexes files, symbols, dependencies, and markdown references
- retrieval context now includes graph matches, nearby relationships, historical changes, and related learnings before planning
- semantic impact analysis now summarizes likely edit targets, upstream dependencies, downstream dependents, volatility, and historical cautions before code is written
- approval-gated planning now stores impact analysis in the pre-execution preview for operator visibility
- this phase remains focused on codebase, architecture, and task memory; operator/team communication preferences are intentionally deferred to later persona work so factual retrieval stays cleanly separated from tone adaptation

Outputs:

- "Senior Engineer" level awareness of codebase architectural debt and cross-cutting impacts

### Phase 13: Self-Healing & Proactive Autonomy (Complete)

Inputs:

- All prior phases (0-12) completed and stable, providing robust foundation.
- Continuous execution history and learnings from diverse engineering tasks.

Actions:

- Implement **Automated Failure Analysis**: When a tool execution or verification step fails, an LLM-driven module within the Executor will analyze logs and context to diagnose the root cause.
- Develop **Repair Planning Agent**: An LLM (e.g., specialized qwen2.5-coder with prompt engineering) generates a corrective plan (e.g., adjust tool args, modify code, re-prompt planner, install missing dependencies).
- Integrate **Automated Retry & Back-off**: The Executor will be enhanced to manage multiple repair attempts with intelligent back-off strategies and contextual retries.
- Capture **Learnings from Self-Repair**: Successful self-corrections are fed into the reflection engine and knowledge graph as new, high-value learnings, enhancing future problem-solving.
- Refine **Human Escalation**: If automated repair attempts are exhausted or the identified risk is too high, the system escalates to the operator with a comprehensive diagnostic report and proposed manual intervention.
- Introduce **Proactive System Remediation**: Beyond passive monitoring (Space Guard), the system will actively attempt to fix minor operational issues (e.g., restart a hung Ollama process, clear specific caches).
- Keep **Autonomy Scope Narrow**: proactive behavior in this phase is operational and recovery-oriented only; repo hygiene suggestions, review tone, and user-facing teammate behaviors are deferred to Phase 15.

Current progress:

- repair proposal generation is active through `src/selfhealing/repairEngine.js`, and failed execution can now enter a structured `needs_repair` path
- repair approvals no longer wait only for the next queue poll; approved repairs can now resume immediately through the orchestrator
- repair attempts now use bounded retry policy via `tasks.retry_count` and `tasks.max_retries`, with persisted `repairState` metadata in task results
- repeated repair attempts now carry exponential cooldown metadata (`nextEligibleAt`, `backoffMs`) so the operator can see when a retry is eligible
- exhausted repair budgets now fail cleanly with narrated handoff context instead of looping indefinitely or degrading into a generic task failure
- repaired and exhausted runs now emit `self-healing` learnings, and reflection prompts now include repair-state context so recovery outcomes can influence later behavior
- self-healing handoff now includes structured diagnostics for attempt counts, failed step/tool, cooldown, inspect targets, and recommended operator actions
- proactive remediation is now explicit and allowlisted: low-disk `auto_prune` remains available behind `disk_auto_prune`, and `workspace_junk_cleanup` can proactively remove ignored workspace junk without broad shell autonomy

Outputs:

- LocalClaw can automatically recover from a significant percentage of common execution failures.
- Reduced operator intervention for routine errors.
- Enhanced platform resilience and operational stability.

### Phase 14: Conversational Agent & Iterative Planning (In Progress)

Inputs:

- All prior phases (0-13) completed and stable.
- Operator requirements for seamless, natural language interaction for task definition and planning.

Actions:

- Implement **Persistent Chat Session Context**: Modify `src/control/chat.js` to store and retrieve full conversational history for `localclaw chat` sessions in the PostgreSQL database.
- Develop **Contextual Understanding & Iterative Planning Loop**: Enhance `chatService` to process new user messages in the context of the historical conversation, leveraging a specialized "Chat Planner" agent to:
    - Interpret user intent (refine task, ask clarification, new task).
    - Iteratively draft a `task_contract_v1` JSON structure based on dialogue.
    - Ask clarifying questions or present evolving contract for discussion.
- Integrate **Natural Language Discussion & Clarification**: Enable the chat agent to ask for missing details, present options, explain reasoning, and generate human-like responses during planning.
- Ensure **Seamless Transition to Execution**: Allow direct conversion of an approved `task_contract` (negotiated in chat) into an executable task, linking the conversation to the new `task_id`.
- Add **Conversation Summaries & Preference Extraction**: distill long chat histories into structured summaries, extract explicit and inferred operator preferences, and record confidence so later phases do not rely on raw message replay alone.
- Define **Preference Override & Decay Rules**: explicit operator instructions override inferred preferences, and stale tone/style inferences expire unless re-confirmed by newer interactions.

Current progress:

- persistent chat sessions, chat history storage, and session summaries are already implemented in the control plane
- chat sessions now persist structured `chat_summary_v1` state alongside the plain-text summary, so long-running sessions can keep machine-readable highlights and not only a flat summary string
- chat summary state now captures explicit and inferred operator preferences such as verbosity, explanation depth, planning style, and interaction mode, with confidence and evidence stored in PostgreSQL
- chat prompts now inject captured preference state back into the conversation loop so later turns can adapt without replaying the full raw history
- chat now keeps a rolling draft contract inside session state, asks clarification questions when an execution request is too vague to plan safely, and auto-plans once follow-up detail makes the draft concrete enough
- actor-based chat now selects the actor model role instead of forcing the fast chat path, so `architect` discussions use planner-oriented model selection
- chat and CLI plan output now render explicit numbered plan steps instead of only brief summaries when the operator asks for steps
- clear execution-style chat requests can now be converted directly into approval-gated planned tasks, so imperative asks such as creating files or scaffolding a project no longer stall in discussion-only mode
- CLI chat now exposes `/approve [task-id]` and `/status [task-id]` so an operator can start an approval-gated task and inspect progress without leaving the chat session
- after approval, CLI chat now watches the task and prints state changes such as `in_progress`, current step, `blocked`, `failed`, and `done`
- while a task remains active without a state transition, CLI chat now emits short heartbeat phrases such as queued, planning, working, or verifying so the terminal does not go silent during long operations
- natural-language approval now works conservatively inside chat when there is exactly one task in `waiting_approval`; replies such as "yes, start it" approve that task and start execution tracking
- CLI chat now distinguishes a planned-but-not-started task from a running task: it shows the task id, waiting-approval status, and plan steps immediately, but only starts live progress watching after execution approval succeeds
- execution remains approval-gated; open-ended discussion stays conversational, while clear execution requests create a pending task that still needs explicit operator approval before any code runs
- the remaining work is concentrated on richer contract evolution across longer chats and surfacing summary/preference/draft state through more control-plane views

Outputs:

- LocalClaw transforms from a plan-gated execution engine to an interactive, persistent, and contextual conversational engineering partner.
- Operators can define and refine tasks through natural language dialogue.
- Reduced friction in task initiation and planning.

### Phase 15: Persona Layer & Humanized Presence (Planned)

Inputs:

- All prior phases (0-14) planned and sequenced, with Phase 12 memory and Phase 14 chat context available as the main personalization substrate.
- Stable Telegram, Browser UI, and GitHub integration boundaries from Phases 7B, 7C, and 11.
- Operator need for LocalClaw to communicate like a credible engineering teammate instead of a neutral status bot.

Actions:

- Implement a **Persona Layer** in the orchestrator/reporting path: a specialized narration step converts raw task logs, verification results, repair attempts, and approvals into grounded human-friendly summaries before they are emitted to Telegram, UI activity feeds, or GitHub.
- Keep the **Persona Layer Non-Authoritative**: persona output narrates and formats execution state after planning/execution steps are complete; it does not choose tools, alter verification outcomes, or override approval gates.
- Add **Narrative Personality** controls: define a consistent LocalClaw voice for progress updates, completions, risk notes, and review comments while preserving a strict link back to factual execution records.
- Add **Inner Monologue / Why Trace** support: expose reasoning-oriented summaries in logs and previews such as why a pattern, retry path, or tool choice was selected, without leaking chain-of-thought-style raw model internals.
- Build **User Preference Profiles** on top of Phase 12 memory and Phase 14 chat history: persist explicit and inferred operator/team preferences such as brevity, explanation depth, coding-style bias, review tone, and tolerance for comment noise.
- Add **Adaptive Tone & Audience Policy**: vary tone, verbosity, and teaching depth by surface and recipient so Telegram can stay concise, the UI can stay explanatory, and GitHub can sound like a peer reviewer rather than a deployment notifier.
- Implement **Proactive Observation Hooks**: while executing or retrieving context, capture adjacent findings such as stale READMEs, TODO clusters, dependency drift, or suspicious code paths and offer them as optional "by the way" suggestions or follow-up tasks instead of silently expanding scope.
- Extend **Human Handover Narration** for blocked/self-healing failures: when automated repair is exhausted, summarize what was tried, where it failed, what context may be missing, and which logs or artifacts the operator should inspect next.
- Add **PR Persona** workflows: let validation and review runs generate human-style GitHub feedback that can highlight concerns, ask targeted questions, or acknowledge strong logic instead of posting only pass/fail state.
- Define **Persona Guardrails and Evaluation**: narrated output must stay faithful to logged facts, clearly separate observations from inferences, avoid invented confidence, and remain testable with golden examples for each channel.
- Split delivery into three internal tracks:
  - **Narration pipeline** for evidence-bound summary generation from logs, plans, verification, and repair state
  - **Preference memory** for explicit/inferred persona controls and audience-specific defaults
  - **Channel adapters** for Telegram, Browser UI, and GitHub-specific rendering and policy
- Make narrated output **Evidence-Bound**: every meaningful claim in a narrated summary, handover note, or review draft should be traceable to task step logs, plan artifacts, verification output, or stored approvals.
- Add **Operator Controls**: allow persona enablement, verbosity, teaching depth, proactive observation opt-in, and GitHub review voice to be configured per operator/team.
- Add **Public Surface Guardrails**: GitHub persona output starts as a draft or approval-gated comment path before any fully automatic public posting.

Current progress:

- deterministic persona artifacts now exist for execution and handoff state: `persona_profile_v1`, `narrated_summary_v1`, `handover_summary_v1`, `observation_note_v1`, and `review_comment_draft_v1`
- orchestrator task details now hydrate persona artifacts alongside raw logs so downstream surfaces can compare narration against evidence
- Telegram and operator-facing task views now use narrated summaries when available for completion, blocked, failed, repair, and deploy-approval states
- Browser UI task detail now shows narrated summary, handover notes, observation notes, and raw facts side by side so the operator can see both the humanized explanation and the underlying execution state
- persona output remains post-execution and non-authoritative; it does not choose tools, bypass approval gates, or alter verification results

Outputs:

- LocalClaw communicates with a recognizable, consistent engineering persona across Telegram, UI, and GitHub.
- Operator preferences measurably shape summaries, explanations, and review tone without sacrificing auditability.
- The platform behaves more like a proactive teammate by surfacing useful adjacent observations and better stuck-state handovers.
- Execution facts remain durable and machine-readable while persona-rich summaries improve trust and usability.

First implementation slice:

- introduce a `narrated_summary_v1` artifact generated from execution logs and verification output
- add `persona_profile_v1`, `handover_summary_v1`, `observation_note_v1`, and `review_comment_draft_v1` as separate artifacts instead of collapsing all communication into one generic summary type
- emit narrated output to Telegram and the Browser UI before expanding to GitHub review/comment workflows
- show raw facts alongside narrated summaries in the Browser UI so operators can compare evidence and wording directly
- keep raw logs, narrated summaries, and preference inputs stored separately so the persona layer stays debuggable and reversible

## 5. Phase 4 Checkpoint

Phase 4 is the formal MVP gate. LocalClaw does not claim platform readiness before this checkpoint is crossed.

### 5.1 What Must Work

- LocalClaw starts and stays alive under PM2
- task intake is durable
- one task can be leased and executed safely
- planner and executor complete a controlled code task
- task steps and results are logged in PostgreSQL
- GitHub push works
- deploy approval is requested through Telegram
- Railway deploy can be triggered after approval
- deploy outcome is reported with logs on failure
- restart recovery works for interrupted tasks

### 5.2 What Is Intentionally Deferred

- broad self-generated skills
- unrestricted shell autonomy
- multi-task concurrency
- alternate runtime sidecars such as MLX
- automatic deploy without approval
- aggressive self-modification

### 5.3 Evidence Required to Pass

- successful end-to-end sample task record in DB
- Telegram approval message and response flow
- GitHub repo link from an executed task
- Railway deployment attempt with success or failure evidence
- restart recovery demonstration
- operator signoff that logs and controls are understandable

## 6. Risk Ledger

### 6.1 Runtime Health Risk

Ollama runtime health is the top prerequisite risk. If the CLI crashes or the HTTP API is unavailable, model-dependent phases cannot start cleanly.

### 6.2 Memory Fit Risk

The machine has 16 GB unified memory. The platform must avoid sizing decisions that assume multiple large resident models.

### 6.3 Credential Readiness Risk

Telegram, GitHub, and Railway all require tokens before the MVP can be proven end-to-end.

### 6.4 Sandbox Timing Risk

Docker is available, but full sandboxing may slow early progress if introduced too early. The recommended approach is curated host-safe tooling first, with Docker becoming stronger after the Phase 4 checkpoint or earlier if task breadth grows.

### 6.5 Scope Expansion Risk

RAG, skills, and Safe-Commit are all valuable, but the project fails if the core MVP loop is not stabilized before those expansions.

## 7. Completion Definition

Project completion means all of the following are true:

- Phase 4 checkpoint is crossed
- RAG and learnings are functional
- skills are governed and reusable
- Safe-Commit has been executed as the first proving mission
- hardening measures are in place
- the platform can recover, pause, resume, and report reliably

## 8. Execution Rules

- never bypass the Phase 4 gate
- do not enable broad self-generated skills before controlled skill governance exists
- keep one active task in MVP
- treat model output as suggestions until validated through tools or tests
- require human approval for deploy and unsafe external actions

## 9. Backlog

### 9.1 Per-Project Deploy Targets

After the fixed-service Phase 4 checkpoint is crossed, move Railway deploy targeting out of global `.env` state and into the database.

Backlog intent:

- keep only account-level provider credentials in `.env`
- store GitHub repo and Railway target mapping per generated project
- allow LocalClaw to manage multiple projects without changing runtime env vars
- preserve approval-gated deploys even when a project has its own repo and service

Expected implementation shape:

- add project-level records for repository and deploy target mapping
- persist `railway_project_id`, `railway_environment_id`, and `railway_service_id` per project
- make tasks resolve their deploy target from DB, not a single global service
- keep dynamic repo and service creation out of the current MVP until the fixed-target path is proven stable
