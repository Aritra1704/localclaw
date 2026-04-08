# LocalClaw Context

Version: 1.0  
Date: 2026-04-08  
Purpose: end-to-end execution context and checkpoint guide for LocalClaw delivery

## 0. Current Phase Status

As of 2026-04-08, the project status is:

| Phase | Status | Notes |
|---|---|---|
| Phase 0: Preflight | complete | SSD layout is ready, mandatory local model baseline is present, Telegram token and chat ID are available, DB credentials are verified, and Railway token can be added later. |
| Phase 1: Foundation | complete | repo scaffold, env handling, migration runner, dedicated `localclaw` schema, orchestrator bootstrap, PM2 config, Telegram command wiring, command-handler integration testing, and live Telegram polling verification are complete. |
| Phase 2: LLM and Tool Execution | complete | Ollama client, planner, workspace tool registry, task executor, and verifier are implemented. A live Telegram task generated `src/app.js` and `README.md` in the controlled workspace and verified successfully. |
| Phase 3: Git and GitHub | not started | GitHub API and repo automation are still pending. |
| Phase 4: Deploy Gate Checkpoint | not started | Railway integration and deploy approval flow are not implemented yet. |
| Phase 5: RAG and Learnings | not started | deferred until after MVP. |
| Phase 6: Skills Manager | not started | deferred until after MVP. |
| Phase 7: Safe-Commit Proving Run | not started | depends on crossing Phase 4. |
| Phase 8: Hardening | not started | depends on live execution evidence. |

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

### Phase 7: Safe-Commit Proving Run

Inputs:

- LocalClaw Phase 4 checkpoint cleared
- RAG and skills available or at least partially available

Actions:

- load Safe-Commit backlog
- execute prioritized tasks
- deploy with approval
- track quality, blockers, and learnings

Outputs:

- LocalClaw proves value on a real project

### Phase 8: Hardening

Inputs:

- real-world execution evidence from earlier phases

Actions:

- introduce stronger Docker sandbox enforcement
- add backups and summaries
- add failure auto-pause
- refine health checks and resource controls

Outputs:

- LocalClaw is production-grade for personal autonomous use

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
