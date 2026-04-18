# LocalClaw Context

Version: 1.2  
Date: 2026-04-11  
Purpose: end-to-end execution context and checkpoint guide for LocalClaw delivery

## 0. Current Phase Status

As of 2026-04-11, the project status is:

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

Outputs:

- "Senior Engineer" level awareness of codebase architectural debt and cross-cutting impacts

### Phase 13: Self-Healing & Proactive Autonomy (Planned)

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

Outputs:

- LocalClaw can automatically recover from a significant percentage of common execution failures.
- Reduced operator intervention for routine errors.
- Enhanced platform resilience and operational stability.

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
