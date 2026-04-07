# LocalClaw Master HLD

Version: 1.0  
Date: 2026-04-07  
Status: Working architecture baseline  
Owner: Aritra  
Platform target: Mac Mini M4, 16 GB unified memory, local PostgreSQL, local Ollama, optional Docker sandbox

## 1. Purpose

LocalClaw is a persistent autonomous AI developer platform that runs locally, accepts work items, plans execution, uses curated tools to perform the work, verifies outputs, requests approval when needed, and reports progress through Telegram. Its first proving mission is to complete the Safe-Commit product after LocalClaw itself reaches the Phase 4 checkpoint.

The system is designed as a standalone platform and is not merged into the current eCardFactory runtime. It may later operate on multiple project repositories, but its own control plane, state, and tooling remain isolated.

## 2. Goals and Non-Goals

### 2.1 Goals

- Run continuously on the target Mac Mini with automatic restart and durable state.
- Use local inference first, with Ollama as the primary runtime.
- Accept tasks from a database-backed queue and Telegram control commands.
- Plan, execute, verify, and report each task through explicit state transitions.
- Keep humans in the loop for deployment, unsafe actions, and unresolved ambiguity.
- Persist logs, learnings, documents, skills, approvals, and deployment history.
- Reach a reliable Phase 4 MVP before enabling advanced self-improving behavior.

### 2.2 Non-Goals for MVP

- Multi-agent parallel execution across multiple active tasks.
- Unbounded shell execution on the host.
- Fully autonomous deployment without approval.
- Automatic arbitrary skill generation before the system is stable.
- Hugging Face as the default serving runtime.

## 3. Machine Profile and Constraints

### 3.1 Target Hardware

- Machine: Mac Mini M4
- Memory: 16 GB unified memory
- Storage:
  - Internal SSD for LocalClaw core runtime
  - External SSD for generated projects, temporary workspaces, backups, and sandbox bind mounts
- Local services:
  - Ollama
  - PostgreSQL
  - PM2
  - Docker Desktop or compatible Docker runtime

### 3.2 Constraints

- Only one substantial reasoning or coding model should be active at a time.
- Local inference latency and memory pressure must be treated as first-class operational constraints.
- CLI and runtime health of Ollama must be verified before model-dependent phases start.
- Host shell access should remain curated; broad code execution should move into a Docker sandbox once tool breadth grows.

## 4. Product Scope

LocalClaw owns:

- task intake and prioritization
- orchestration and execution lifecycle
- tool access and execution policy
- model routing and prompt contracts
- persistent state and logging
- human control surface through Telegram
- GitHub and Railway integration
- RAG and learnings retrieval
- skills registry and controlled skill execution

LocalClaw does not own:

- GitHub as a source of truth for task state
- Railway as the only deployment target forever
- direct model hosting beyond the supported runtime boundaries

## 5. Architecture Overview

### 5.1 Logical Planes

#### Control Plane

Responsible for lifecycle coordination and safety.

- Orchestrator
- task scheduler and queue leaser
- Telegram command gateway
- approval manager
- global state manager
- health monitor

#### Execution Plane

Responsible for doing work against a single active task.

- task executor
- planner
- verifier
- tool router
- skill runner
- failure handler

#### Model Runtime Layer

Primary model serving and retrieval services.

- Ollama client
- embedding client
- prompt registry
- model selector
- response validator

#### Data and State Layer

Responsible for durable execution memory and operational state.

- PostgreSQL core schema
- migrations
- task/event logs
- documents and chunk metadata
- learnings and skill registry
- approvals and deployments

#### Integration Layer

- Telegram bot
- GitHub API and git CLI wrapper
- Railway API wrapper
- filesystem and shell wrappers
- Docker sandbox runner

### 5.2 Runtime Topology

LocalClaw core runs as a Node.js application under PM2. PostgreSQL and Ollama are local services. Generated projects are stored on the external SSD. Docker is recommended for code execution, test, and build isolation once the MVP reaches stable task execution.

### 5.3 Core Design Rules

- One active task at a time in MVP.
- Every task step is persisted.
- Every external action is attributable.
- Unsafe actions require explicit approval.
- Recovery is restart-safe.
- Model output is treated as untrusted until validated.

## 6. End-to-End Task Lifecycle

### 6.1 Intake

Tasks may be created by Telegram, direct SQL insertion, a future local UI, or an internal follow-up task creator. Each task is normalized into title, description, priority, source, execution constraints, and optional repository metadata.

### 6.2 Lease and Start

The orchestrator polls for work and acquires a lease using a DB-level lock pattern such as `FOR UPDATE SKIP LOCKED`. Task status moves from `pending` to `leased` to `in_progress`. Lease metadata prevents duplicate pickup after process restart.

### 6.3 Planning

The planner receives:

- task description
- execution constraints
- relevant learnings
- relevant document chunks
- available tools
- available skills
- current repo or workspace context

Planner output must conform to a JSON schema that describes ordered steps, expected artifacts, required tools, approval needs, and verification conditions.

### 6.4 Execution

Each step is executed through curated tools or a skill. Code generation or transformation is isolated from tool invocation. Filesystem writes and shell commands are logged with redacted secrets.

### 6.5 Verification

Verification is mandatory before a task can be marked complete. Verification may include:

- static checks
- tests
- build
- migration dry run
- runtime health checks
- file existence assertions
- deployment result checks

### 6.6 Approval Gates

Approval is required for:

- deploy
- push after high-risk review
- destructive filesystem changes outside a scratch workspace
- unresolved architecture ambiguity
- any future external billing or payment operation

### 6.7 Completion and Learning

After successful completion, LocalClaw stores result metadata, extracts learnings, links artifacts, and optionally creates follow-up tasks. Failed tasks produce structured failure records and retry metadata. Blocked tasks remain resumable.

### 6.8 Recovery

On restart, LocalClaw scans for leased or in-progress tasks with expired heartbeat and either resumes or moves them to a recoverable blocked state. No task should be silently lost.

## 7. Agentic Operating Principles

- Tool-first execution: models propose actions, tools perform actions.
- Deterministic checkpoints: every phase has concrete entry and exit criteria.
- Explicit blocked state: the agent must never silently abandon ambiguity.
- Single active task in MVP: reduce concurrency complexity until reliability is proven.
- Human approval for high-impact actions: deployment and unsafe actions remain gated.
- Retrieval before generation: use stored context and learnings before open-ended generation.
- Bounded autonomy: model outputs are constrained by schemas, allowlists, and timeouts.
- Evidence over optimism: task completion requires observable outputs, not just model claims.

## 8. Model and Runtime Strategy

### 8.1 Primary Runtime

Ollama is the primary runtime. Hugging Face models may be imported through Ollama or evaluated later through a separate MLX sidecar, but the platform architecture is Ollama-first for simplicity and operational stability.

### 8.2 Mandatory Baseline

| Model Tag | Runtime | Purpose | Required | Expected State |
|---|---|---|---|---|
| `gemma4:e4b` | Ollama | planning, review, structured reasoning | yes | installed |
| `qwen2.5-coder:7b` | Ollama | coding, debugging, fix generation | yes | must be pulled if absent |
| `nomic-embed-text:latest` | Ollama | embeddings for RAG and similarity workflows | yes | installed |

### 8.3 Optional or Fallback Models

| Model Tag | Runtime | Purpose | Required | Current Role |
|---|---|---|---|---|
| `qwen2.5:7b-instruct` | Ollama | summaries, classification, lightweight JSON work | no | fast utility model |
| `llama3.1:8b` | Ollama | fallback reasoning, second opinion | no | fallback |
| `mistral:7b` | Ollama | fallback general assistant behavior | no | tertiary fallback |

### 8.4 Local Inventory Notes

Current local manifests indicate the system already has:

- `gemma4:e4b`
- `qwen2.5:7b-instruct`
- `llama3.1:8b`
- `mistral:7b`
- `nomic-embed-text:latest`

`qwen2.5-coder:7b` is part of the required baseline and should be added if not already pulled. Ollama runtime health must be confirmed before Phase 2 work is treated as executable.

### 8.5 Model Routing

| Step Type | Primary Model | Fallback |
|---|---|---|
| planning | `gemma4:e4b` | `llama3.1:8b` |
| review | `gemma4:e4b` | `qwen2.5:7b-instruct` |
| code | `qwen2.5-coder:7b` | `qwen2.5:7b-instruct` |
| debug | `qwen2.5-coder:7b` | `llama3.1:8b` |
| summarize | `qwen2.5:7b-instruct` | `mistral:7b` |
| embeddings | `nomic-embed-text:latest` | none |

### 8.6 Hugging Face Policy

Hugging Face remains a model source, not the default runtime. The preferred order is:

1. use Ollama library models
2. import compatible Hugging Face models into Ollama if needed
3. add a separate MLX sidecar only when a model or workflow cannot be served cleanly through Ollama

AirLLM is not a default LocalClaw runtime choice. It adds a Python sidecar and disk-heavy behavior that does not improve the core Phase 4 objective enough to justify the extra operational complexity.

## 9. Core Components

### 9.1 Orchestrator

Responsibilities:

- poll for new work
- maintain global runtime state
- acquire and renew task leases
- dispatch a single executor
- react to pause, resume, stop, and emergency commands
- enforce retry and timeout policy

### 9.2 Task Executor

Responsibilities:

- assemble task context
- run planner and validate output
- execute steps in order
- call tools and skills
- emit step logs and heartbeats
- trigger verifier
- request approval when necessary

### 9.3 Verifier

Responsibilities:

- run configured checks for the current task type
- collect test results and build output
- distinguish retryable failure from hard failure
- produce a compact evidence record stored in the DB

### 9.4 Tool Registry

Curated tools are registered by capability class:

- filesystem
- shell
- git
- GitHub
- Railway
- PostgreSQL
- Telegram
- Docker sandbox
- test and build
- document ingestion

Each tool declares:

- name
- allowed inputs
- execution boundary
- timeout
- approval need
- redaction policy

### 9.5 Skill Manager

Skills are reusable higher-level workflows composed of prompts, tool sequences, or deterministic logic. Two classes exist:

- built-in skills shipped with LocalClaw
- generated or curated skills registered after Phase 4

Generated skills must be versioned, tested, and explicitly enabled before broad use.

### 9.6 Retrieval Layer

Retrieval is used for:

- project documents
- execution learnings
- prior failure patterns
- approved coding conventions

Retrieval should inject only the minimum relevant context required for the active task to avoid prompt bloat and low-signal context windows.

## 10. Data Architecture

### 10.1 Core Tables

The platform schema should include at minimum:

- `tasks`
- `agent_logs`
- `task_artifacts`
- `agent_state`
- `approvals`
- `deployments`
- `skills`
- `skill_runs`
- `learnings`
- `documents`
- `document_chunks`
- `embeddings_index`
- `model_catalog`
- `schema_migrations`

### 10.2 Core Table Responsibilities

#### `tasks`

Stores task identity, queue metadata, current state, lease fields, retry fields, repository context, and final result summary.

#### `agent_logs`

Stores ordered step-level logs with tool, model, status, duration, and summarized input and output.

#### `approvals`

Stores human approval requests, status, approver identity, message channel metadata, and expiry.

#### `deployments`

Stores deployment attempts, provider metadata, logs snapshot, environment name, and final result.

#### `skills`

Stores skill definitions, version, status, provenance, and enablement state.

#### `learnings`

Stores reusable post-task observations with confidence and applicability metadata.

#### `documents`

Stores raw document metadata for HLDs, READMEs, runbooks, and project specifications.

#### `document_chunks`

Stores chunked document content with offsets and hashing to support selective refresh.

#### `embeddings_index`

Stores vector references or embedding blobs, plus source linkage and runtime metadata.

#### `model_catalog`

Stores required and optional models, install and health status, intended purpose, and fallback ordering.

### 10.3 RAG Flow

1. ingest a source document
2. normalize and chunk it
3. embed chunks
4. store embeddings and metadata
5. retrieve top relevant chunks for planning or execution
6. log which chunks were injected into a run

### 10.4 Learning Flow

1. collect task logs and verifier outputs
2. generate structured learning candidates
3. review and store high-signal learnings
4. retrieve by keyword and semantic relevance
5. update `times_applied` when reused successfully

## 11. Security and Sandboxing

### 11.1 Identity and Authorization

- Telegram messages are accepted only from approved user IDs.
- GitHub and Railway tokens are stored in env vars or a local secret store and never persisted in logs.
- Future local UI or API surfaces must reuse the same approval model, not bypass it.

### 11.2 Shell Safety

Shell execution must use an allowlist, not a loose blacklist. Each command family should declare:

- allowed executable
- allowed working directories
- whether Docker sandbox is mandatory
- max timeout
- whether network access is allowed

### 11.3 Docker Sandbox

Docker is recommended for any code-generation task that escalates beyond simple local inspection.

Recommended properties:

- non-root user
- read/write bind mount only for the task workspace
- no host networking by default
- CPU and memory limits
- ephemeral container per task or per execution session
- curated base image with git, node, pnpm or npm, python, and test tooling as needed

### 11.4 Secrets and Redaction

- redact tokens and credentials from all stored logs
- avoid echoing secrets to shell
- keep `.env` files out of generated repos unless explicitly intended

### 11.5 Failure Policy

- repeated tool failure moves the task to `blocked` or `failed`
- external service unavailability pauses model-dependent work
- lease expiry or PM2 restart should not lose task state

## 12. Deployment and Operations

### 12.1 Process Management

PM2 manages the LocalClaw core process with restart delay, separate logs, and health-aware restarts.

### 12.2 Migration Execution

Database migrations run in code at startup and again as a guarded deployment step. Migration execution must:

- connect to PostgreSQL
- acquire an advisory lock
- check `schema_migrations`
- run pending SQL files transactionally where safe
- persist version stamps
- fail fast if a migration cannot be applied cleanly

### 12.3 Observability

Track and expose:

- current status
- current task
- queue depth
- model used
- task duration
- approval wait time
- failure counts
- deployment results
- Ollama and PostgreSQL health

### 12.4 Backup and Recovery

Back up:

- PostgreSQL dumps
- generated project directories
- LocalClaw config and prompts
- selected log snapshots for failed tasks

## 13. Phased Roadmap

### Phase 0: Preflight and Runtime Health

Outcomes:

- verify Ollama health
- verify required model baseline
- verify PostgreSQL
- verify Telegram, GitHub, Railway credentials
- define SSD layout

Exit criteria:

- required models present or planned for pull
- `qwen2.5-coder:7b` scheduled or installed
- runtime dependencies reachable

### Phase 1: Foundation

Outcomes:

- Node.js core scaffold
- config loader
- PostgreSQL migrations
- Telegram bot
- orchestrator loop
- task polling

Exit criteria:

- LocalClaw starts under PM2
- commands respond
- tasks can be created and observed in state transitions

### Phase 2: LLM and Tool Execution

Outcomes:

- Ollama client
- planner contract
- executor
- verifier skeleton
- curated tool registry

Exit criteria:

- LocalClaw can complete a simple code task in a controlled workspace

### Phase 3: Git and GitHub

Outcomes:

- repository bootstrap
- commit and push
- GitHub repo creation
- task to repo linkage

Exit criteria:

- completed task can push to GitHub with audit trail

### Phase 4: MVP Checkpoint

Outcomes:

- deploy approval gate
- Railway integration
- restart-safe state
- evidence-backed completion

Exit criteria:

- LocalClaw can intake, plan, execute, verify, push, ask for deploy approval, deploy, and report result

### Phase 5: RAG and Learnings

Outcomes:

- document ingestion
- chunking and embeddings
- retrieval injection
- post-task learning extraction

### Phase 6: Skills Manager

Outcomes:

- built-in skills registry
- tested generated skills under explicit policy
- skill metrics

### Phase 7: Safe-Commit Proving Run

Outcomes:

- LocalClaw works through Safe-Commit backlog
- approval-gated deployment
- captured learnings

### Phase 8: Hardening

Outcomes:

- stronger sandboxing
- expanded health checks
- backup automation
- failure auto-pause
- daily summary

## 14. ETA Bands

Assuming prerequisites are ready and Ollama is healthy:

- Phase 0: 0.5 to 1 day
- Phase 1: 1 day
- Phase 2: 1.5 to 2 days
- Phase 3: 0.5 to 1 day
- Phase 4: 1 to 1.5 days
- Phase 5 to Phase 8: 4 to 7 additional working days depending on RAG and skill complexity

Reasonable Phase 4 target: 5 to 7 working days from implementation start.

## 15. Completion Definition

The LocalClaw platform is considered complete when:

- it has crossed the Phase 4 checkpoint
- it has working RAG and learnings retrieval
- it has a governed skills system
- it has completed the Safe-Commit proving run to an acceptable quality bar
- it operates safely with backups, restart recovery, approvals, and documented constraints

