# LocalClaw — High Level Design & Phased Build Plan
**Version:** 1.0  
**Author:** Aritra (assisted by Claude)  
**Date:** April 2026  
**Target Machine:** Mac Mini M4 · 16GB Unified RAM · External SSD  
**Build Method:** Codex CLI (Phase 1 bootstraps the system, system runs itself thereafter)

---

## Table of Contents

1. [Vision & Objectives](#1-vision--objectives)
2. [System Overview](#2-system-overview)
3. [High Level Architecture](#3-high-level-architecture)
4. [Component Design](#4-component-design)
5. [Data Architecture](#5-data-architecture)
6. [Model Strategy](#6-model-strategy)
7. [Tool & Skills Registry](#7-tool--skills-registry)
8. [Telegram Control Interface](#8-telegram-control-interface)
9. [Deployment Pipeline](#9-deployment-pipeline)
10. [Self-Improvement System](#10-self-improvement-system)
11. [Security & Safety](#11-security--safety)
12. [Folder Structure](#12-folder-structure)
13. [Phase-wise Build Plan](#13-phase-wise-build-plan)
14. [Codex Bootstrap Instructions](#14-codex-bootstrap-instructions)
15. [Configuration Reference](#15-configuration-reference)
16. [Decisions Log](#16-decisions-log)

---

## 1. Vision & Objectives

### 1.1 What Is LocalClaw?

LocalClaw is a **persistent, autonomous AI developer agent** that runs continuously on your Mac Mini M4. It operates like a senior developer assigned permanently to your side projects — picking up tasks from a queue, writing code, testing, pushing to GitHub, deploying to Railway, and reporting to you via Telegram. It never stops unless you tell it to.

It uses **local Ollama models** exclusively for LLM inference — no API costs, no cloud dependency, full privacy.

### 1.2 Core Objectives

| Objective | Description |
|---|---|
| **Autonomous execution** | Work through task queues without human intervention |
| **Intelligent questioning** | Ask via Telegram when blocked, never silently fail |
| **Full-stack output** | Generate apps from scratch — frontend, backend, DB schema, deployment config |
| **Self-improving** | Learn from every task, persist learnings, get better over time |
| **Skill creation** | Write its own tools and skills when it encounters a gap |
| **Human-in-the-loop** | You approve deploys, unblock the agent, and add tasks via Telegram |
| **Safe-Commit awareness** | Route all pre-push code through Safe-Commit once it is live |

### 1.3 First Real Task

The first task LocalClaw will execute upon going live is:

> **Complete the Safe-Commit project** — an AI-powered code auditor SaaS with dual-AI consensus model (Claude + Gemini), targeting solo builders and dev shops, with a free tier and paid Studio plan.

---

## 2. System Overview

```
YOU (Aritra)
    │
    │  Telegram (commands, approvals, questions)
    ▼
┌─────────────────────────────────────────────────────────────────┐
│                        LocalClaw Core                           │
│                    (Node.js · PM2 · Mac Mini)                   │
│                                                                 │
│  ┌─────────────┐   ┌──────────────┐   ┌─────────────────────┐  │
│  │  Scheduler  │──▶│  Task Queue  │──▶│   Agent Executor    │  │
│  │  (cron)     │   │  (Postgres)  │   │   (ReAct Loop)      │  │
│  └─────────────┘   └──────────────┘   └──────────┬──────────┘  │
│                                                   │             │
│  ┌────────────────────────────────────────────────▼──────────┐  │
│  │                     Tool Registry                         │  │
│  │  git · railway · telegram · postgres · fs · shell · test  │  │
│  └────────────────────────────────────────────────┬──────────┘  │
│                                                   │             │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────▼──────────┐  │
│  │  Skills Mgr  │   │  Self-Improve│   │   Ollama Interface  │  │
│  │  (create/run)│   │  (learnings) │   │  gemma3 / qwen2.5   │  │
│  └──────────────┘   └──────────────┘   └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
         │               │               │              │
     Postgres         GitHub          Railway        Telegram
    (local)           (code)         (deploy)         (you)
         │
    External SSD
   (project files)
```

### 2.1 Operating Principle

LocalClaw runs an infinite **Agent Loop**:

```
POLL tasks → SELECT next task → PLAN steps (LLM) → EXECUTE steps (tools)
    → VERIFY result → REPORT via Telegram → MARK done → POLL next task
         │
         └─ If BLOCKED → ask Telegram → WAIT for reply → RESUME
         └─ If ERROR   → retry N times → escalate to Telegram
         └─ If PAUSED  → hold loop until /resume command
```

---

## 3. High Level Architecture

### 3.1 Architecture Diagram (Detailed)

```
┌─────────────────────────── MAC MINI M4 ──────────────────────────┐
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │                    PM2 Process Manager                   │    │
│  │                                                          │    │
│  │  ┌─────────────────────────────────────────────────┐    │    │
│  │  │              LocalClaw Core (Node.js)            │    │    │
│  │  │                                                  │    │    │
│  │  │  ┌───────────┐    ┌────────────────────────┐    │    │    │
│  │  │  │  Cron     │    │     Telegram Gateway   │    │    │    │
│  │  │  │  Scheduler│    │  (commands + replies)  │    │    │    │
│  │  │  └─────┬─────┘    └──────────┬─────────────┘    │    │    │
│  │  │        │                     │                   │    │    │
│  │  │  ┌─────▼─────────────────────▼─────────────┐    │    │    │
│  │  │  │           Orchestrator                  │    │    │    │
│  │  │  │  - Task selection & priority            │    │    │    │
│  │  │  │  - Agent state machine                  │    │    │    │
│  │  │  │  - Pause / Resume / Stop control        │    │    │    │
│  │  │  └──────────────────┬──────────────────────┘    │    │    │
│  │  │                     │                            │    │    │
│  │  │  ┌──────────────────▼──────────────────────┐    │    │    │
│  │  │  │           Agent Executor                │    │    │    │
│  │  │  │                                         │    │    │    │
│  │  │  │  1. THINK  → Ollama (planner model)     │    │    │    │
│  │  │  │  2. ACT    → Tool call                  │    │    │    │
│  │  │  │  3. OBSERVE→ Tool result                │    │    │    │
│  │  │  │  4. REPEAT until done or blocked        │    │    │    │
│  │  │  └────────────────────────────────────────-┘    │    │    │
│  │  │           │            │            │            │    │    │
│  │  │  ┌────────▼──┐  ┌──────▼───┐  ┌────▼──────┐    │    │    │
│  │  │  │  Ollama   │  │  Tools   │  │  Skills   │    │    │    │
│  │  │  │  Client   │  │  Runner  │  │  Manager  │    │    │    │
│  │  │  └────────┬──┘  └──────────┘  └───────────┘    │    │    │
│  │  │           │                                     │    │    │
│  │  └───────────┼─────────────────────────────────────┘    │    │
│  └──────────────┼──────────────────────────────────────────┘    │
│                 │                                                │
│  ┌──────────────▼──────────┐  ┌──────────────────────────────┐  │
│  │   Ollama Runtime        │  │   PostgreSQL (local)         │  │
│  │                         │  │                              │  │
│  │  Model 1: gemma3:27b    │  │  tasks · skills · learnings  │  │
│  │  Model 2: qwen2.5-coder │  │  agent_logs · deployments    │  │
│  │  (sequential, not para) │  │  agent_state                 │  │
│  └─────────────────────────┘  └──────────────────────────────┘  │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │               External SSD (always connected)             │  │
│  │   /Volumes/[SSD]/localclaw/                              │  │
│  │     ├── projects/     (generated app folders)            │  │
│  │     ├── workspace/    (agent working dir)                │  │
│  │     └── backups/      (snapshots)                        │  │
│  └───────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
         │                    │                    │
    ┌────▼─────┐        ┌─────▼────┐        ┌─────▼────┐
    │ Telegram │        │  GitHub  │        │ Railway  │
    │   Bot    │        │  (PAT)   │        │   API    │
    └──────────┘        └──────────┘        └──────────┘
```

### 3.2 Key Design Decisions

| Decision | Choice | Reason |
|---|---|---|
| Runtime | Node.js 20+ | Best async tooling, good LangChain support |
| LLM | Ollama local | Zero cost, privacy, M4 capable |
| Persistence | PostgreSQL local | Reliable, structured, good for agent state |
| Process manager | PM2 | Auto-restart, log management, Mac Mini always-on |
| Agent loop | ReAct (Reason + Act) | Proven pattern, works well with tool-calling models |
| Project storage | External SSD | Keeps Mac Mini storage clean, portable |
| Human interface | Telegram | Mobile-first, async, easy bot integration |

---

## 4. Component Design

### 4.1 Orchestrator

The central controller. Responsibilities:

- Polls task queue every 30 seconds (configurable)
- Selects next task by priority + FIFO
- Manages global state: `RUNNING | PAUSED | STOPPED`
- Handles Telegram command events (pause, resume, stop, status)
- Spawns Agent Executor per task
- Catches unhandled errors, logs, notifies Telegram

**State Machine:**

```
IDLE ──────▶ RUNNING ──────▶ PAUSED
  ▲               │              │
  └───────────────┘◀─────────────┘
                  │
               STOPPED (manual only)
```

### 4.2 Agent Executor

Implements the **ReAct loop** for each task:

```
Task received
    │
    ▼
[THINK] Call planner model (gemma3:27b)
  - Read task description
  - Read relevant learnings from DB
  - Read available tools/skills
  - Output: step-by-step plan as JSON
    │
    ▼
[ACT] For each step in plan:
  - Call coder model (qwen2.5-coder:14b) if code needed
  - Execute tool (git, fs, shell, railway, etc.)
    │
    ▼
[OBSERVE] Capture tool output
  - Success? → next step
  - Error? → retry up to 3x, then ask Telegram
  - Blocked? → post question to Telegram, await reply
    │
    ▼
[VERIFY] Run tests, lint, check output
    │
    ▼
[DONE] Update task status, log to DB, notify Telegram
```

### 4.3 Ollama Client

Abstracts Ollama model calls with:

- Model selection per step type (plan vs code vs review)
- Automatic context window management (truncate if needed)
- Retry on timeout
- Response streaming with buffering
- Tool-call parsing (JSON extraction from response)

**Model routing:**

| Step Type | Model | Why |
|---|---|---|
| Planning, reasoning, reviewing | `gemma3:27b` | Superior reasoning |
| Code generation, debugging | `qwen2.5-coder:14b` | Best local code model |
| Simple lookups, classification | `qwen2.5-coder:7b` (fallback) | Fast, low resource |

Since M4 16GB cannot run both simultaneously, models are called **sequentially**. The Ollama client manages model loading/unloading by calling the appropriate model per step — Ollama handles the in-memory swap automatically.

### 4.4 Skills Manager

Skills are **small, single-purpose JS functions** the agent uses as building blocks. They live in two places:

1. `/localclaw/core/skills/` — built-in skills (shipped with the system)
2. `skills` table in Postgres — dynamically created skills

**Built-in skills (Phase 1):**

| Skill | What it does |
|---|---|
| `git.createRepo` | Create GitHub repo via API |
| `git.push` | Stage, commit, push to remote |
| `git.createPR` | Open a pull request |
| `railway.deploy` | Trigger Railway deployment |
| `railway.getLogs` | Fetch deployment logs |
| `railway.getStatus` | Check deploy status |
| `telegram.send` | Post message to you |
| `telegram.ask` | Post question, await your reply |
| `postgres.query` | Run SQL query |
| `postgres.migrate` | Run migration file |
| `fs.writeFile` | Write file to SSD workspace |
| `fs.readFile` | Read file from workspace |
| `shell.run` | Run shell command with timeout |
| `test.runNpm` | Run `npm test` in a folder |
| `test.runLint` | Run ESLint on a folder |

**Self-created skills:** When the agent encounters a repeated pattern (e.g., "I keep needing to parse Railway JSON logs"), it writes a new skill, tests it, and registers it to Postgres. Next task that needs it loads from DB.

### 4.5 Self-Improvement Engine

Runs as a background job after every task completion:

1. Extract key observations from agent_logs for that task
2. Categorize: `code_pattern | error_recovery | tool_usage | architecture`
3. Persist to `learnings` table
4. Every 10 tasks: run a "meta-summary" via Ollama to distill patterns into compressed `insights`
5. On task start: agent reads top 20 relevant learnings via semantic similarity (keyword match in Phase 1, vector search in later phase)

---

## 5. Data Architecture

### 5.1 PostgreSQL Schema

```sql
-- ─────────────────────────────────────────
-- TASK MANAGEMENT
-- ─────────────────────────────────────────

CREATE TYPE task_status AS ENUM (
  'pending', 'in_progress', 'verifying',
  'blocked', 'done', 'failed', 'cancelled'
);

CREATE TYPE task_priority AS ENUM ('critical', 'high', 'medium', 'low');

CREATE TABLE tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  status          task_status DEFAULT 'pending',
  priority        task_priority DEFAULT 'medium',
  project_name    TEXT,                          -- e.g. 'safe-commit'
  project_path    TEXT,                          -- path on external SSD
  github_repo     TEXT,                          -- owner/repo
  source          TEXT DEFAULT 'manual',         -- 'telegram' | 'manual' | 'agent'
  retry_count     INTEGER DEFAULT 0,
  max_retries     INTEGER DEFAULT 3,
  blocked_reason  TEXT,
  result          JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_priority ON tasks(priority, created_at);

-- ─────────────────────────────────────────
-- SKILLS
-- ─────────────────────────────────────────

CREATE TABLE skills (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT UNIQUE NOT NULL,          -- e.g. 'railway.parseDeployLogs'
  description     TEXT,
  code            TEXT NOT NULL,                 -- JS function body
  version         INTEGER DEFAULT 1,
  success_count   INTEGER DEFAULT 0,
  fail_count      INTEGER DEFAULT 0,
  is_builtin      BOOLEAN DEFAULT FALSE,
  created_by_task UUID REFERENCES tasks(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- LEARNINGS (Self-Improvement)
-- ─────────────────────────────────────────

CREATE TABLE learnings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         UUID REFERENCES tasks(id),
  category        TEXT,                          -- 'code_pattern' | 'error_recovery' etc.
  observation     TEXT NOT NULL,
  keywords        TEXT[],                        -- for retrieval
  quality_score   INTEGER DEFAULT 5,             -- 1-10, agent self-rates
  times_applied   INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_learnings_keywords ON learnings USING GIN(keywords);

-- ─────────────────────────────────────────
-- AGENT EXECUTION LOGS
-- ─────────────────────────────────────────

CREATE TABLE agent_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         UUID REFERENCES tasks(id),
  step_number     INTEGER,
  step_type       TEXT,                          -- 'think' | 'act' | 'observe' | 'verify'
  model_used      TEXT,
  tool_called     TEXT,
  input_summary   TEXT,
  output_summary  TEXT,
  duration_ms     INTEGER,
  tokens_used     INTEGER,
  success         BOOLEAN,
  error_message   TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_agent_logs_task ON agent_logs(task_id);

-- ─────────────────────────────────────────
-- DEPLOYMENTS
-- ─────────────────────────────────────────

CREATE TABLE deployments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         UUID REFERENCES tasks(id),
  github_repo     TEXT,
  github_branch   TEXT DEFAULT 'main',
  railway_service TEXT,
  railway_env     TEXT DEFAULT 'production',
  status          TEXT,                          -- 'pending' | 'building' | 'live' | 'failed'
  deploy_url      TEXT,
  log_snapshot    TEXT,
  triggered_at    TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

-- ─────────────────────────────────────────
-- AGENT GLOBAL STATE
-- ─────────────────────────────────────────

CREATE TABLE agent_state (
  key             TEXT PRIMARY KEY,
  value           JSONB,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default state
INSERT INTO agent_state (key, value) VALUES
  ('status',         '"running"'),
  ('current_task_id', 'null'),
  ('pause_reason',   'null'),
  ('stats',          '{"tasks_completed": 0, "tasks_failed": 0, "uptime_start": null}');
```

### 5.2 Data Flow per Task

```
Task added (Telegram or manual)
    │
    ▼
tasks table: status = 'pending'
    │
    ▼
Orchestrator picks it up
    │
    ▼
tasks table: status = 'in_progress', started_at = NOW()
    │
    ▼
Each agent step → agent_logs row inserted
    │
    ▼
Task completes → learnings extracted → learnings rows inserted
    │
    ▼
If deployed → deployments row inserted
    │
    ▼
tasks table: status = 'done', completed_at = NOW(), result = {...}
```

---

## 6. Model Strategy

### 6.1 Available Models (to confirm against your `ollama list`)

**Recommended setup for M4 16GB:**

| Model | Pull command | Size (Q4) | Primary use |
|---|---|---|---|
| `gemma3:27b` | already pulled | ~17GB | Planning, reasoning, review |
| `qwen2.5-coder:14b` | `ollama pull qwen2.5-coder:14b` | ~9GB | Code generation |
| `qwen2.5-coder:7b` | `ollama pull qwen2.5-coder:7b` | ~5GB | Fast tasks, classification |

> **Note:** After you share your `ollama list` output, this section will be updated with exact models and we can validate the memory fit.

### 6.2 Memory Management

Ollama on M4 uses unified memory (CPU + GPU share the same 16GB pool). Rules:

- Never load two large models simultaneously
- Call the appropriate model per step; Ollama auto-evicts previous model after idle timeout (set `OLLAMA_KEEP_ALIVE=30s` for faster swapping)
- gemma3:27b at Q4_K_M fits in ~17GB — this will use swap on M4 16GB. Monitor with `sudo powermetrics` and drop to `gemma3:12b` if latency is too high

### 6.3 Model Selection Logic

```javascript
function selectModel(stepType) {
  switch (stepType) {
    case 'plan':       return 'gemma3:27b';     // reasoning
    case 'review':     return 'gemma3:27b';     // code review
    case 'code':       return 'qwen2.5-coder:14b'; // code gen
    case 'debug':      return 'qwen2.5-coder:14b'; // debugging
    case 'classify':   return 'qwen2.5-coder:7b';  // fast ops
    case 'summarize':  return 'qwen2.5-coder:7b';  // log summaries
    default:           return 'qwen2.5-coder:14b';
  }
}
```

---

## 7. Tool & Skills Registry

### 7.1 Tool Definitions (Agent sees these as callable functions)

```
Tools available to agent:

FILESYSTEM
  fs.write(path, content)          Write file to SSD workspace
  fs.read(path)                    Read file
  fs.mkdir(path)                   Create directory
  fs.ls(path)                      List directory
  fs.delete(path)                  Delete file/dir

SHELL
  shell.run(cmd, cwd, timeout)     Run command, capture stdout/stderr

GIT / GITHUB
  git.init(projectPath)            Init repo
  git.commit(msg)                  Stage all + commit
  git.push(remote, branch)         Push to GitHub
  git.createRepo(name, private)    Create GitHub repo via API
  git.createBranch(name)           Create branch
  git.status()                     Get working tree status

RAILWAY
  railway.deploy(serviceId)        Trigger deploy
  railway.getStatus(deployId)      Poll deploy status
  railway.getLogs(serviceId, n)    Fetch last N log lines
  railway.listServices()           List Railway services

POSTGRES
  db.query(sql, params)            Run parameterized query
  db.migrate(filePath)             Run migration file
  db.getTask(id)                   Convenience fetch

TELEGRAM
  telegram.send(message)           Send message to you
  telegram.ask(question)           Send question, await /reply
  telegram.sendCode(lang, snippet) Send formatted code block

TESTING
  test.npm(projectPath)            Run npm test
  test.lint(projectPath)           Run ESLint
  test.build(projectPath)          Run npm run build

SKILLS
  skills.list()                    List all registered skills
  skills.run(name, args)           Execute a registered skill
  skills.create(name, desc, code)  Register new skill
```

### 7.2 Safe-Commit Integration Hook

```javascript
// In tool: git.push() — pre-push hook
async function gitPush(remote, branch) {
  if (config.SAFE_COMMIT_ENABLED) {
    const audit = await safeCommit.audit(projectPath);
    if (audit.riskLevel === 'HIGH') {
      await telegram.ask(`Safe-Commit flagged HIGH risk. Approve push anyway?`);
      // await reply
    }
  }
  // proceed with push
}
```

When `SAFE_COMMIT_ENABLED=false` (current state), this block is skipped entirely.

---

## 8. Telegram Control Interface

### 8.1 Bot Setup (Phase 1)

1. Open Telegram → search `@BotFather`
2. `/newbot` → name: `LocalClaw` → username: `localclaw_[yourname]_bot`
3. Copy the token → set as `TELEGRAM_BOT_TOKEN` in `.env`
4. Get your chat ID: message `@userinfobot` → set as `TELEGRAM_CHAT_ID`
5. LocalClaw only accepts messages from your `TELEGRAM_CHAT_ID` (security)

### 8.2 Commands You Can Send

| Command | Action |
|---|---|
| `/status` | Current task, queue depth, uptime, model in use |
| `/tasks` | List all pending + in-progress tasks |
| `/done` | List completed tasks (last 10) |
| `/add <description>` | Add a new task to the queue |
| `/pause [reason]` | Pause the agent after current task finishes |
| `/resume` | Resume from pause |
| `/stop` | Gracefully stop (finish current step, then halt) |
| `/kill` | Immediate stop (emergency) |
| `/log <taskId>` | Fetch last 20 log lines for a task |
| `/deploy <taskId>` | Manually approve a Railway deploy |
| `/reply <text>` | Reply to agent's question |
| `/skills` | List all registered skills |
| `/learnings` | Show last 10 learnings |

### 8.3 Agent-Initiated Messages

LocalClaw will message you when:

| Event | Message format |
|---|---|
| Task started | `🚀 Starting: [task title]` |
| Blocked | `⛔ Blocked on [task]: [question]` |
| Deploy ready | `🚢 [App] ready to deploy to Railway. Approve? /deploy [id]` |
| Deploy live | `✅ [App] is live at [url]` |
| Deploy failed | `❌ Deploy failed. Logs: [snippet]` |
| Task done | `✅ Done: [task title] in [duration]` |
| Task failed | `💀 Failed: [task title] after [N] retries. [reason]` |
| Self-created skill | `🛠️ Created new skill: [name] — [description]` |
| Daily summary | `📊 Daily: [N] done, [N] pending, [N] failed` |

---

## 9. Deployment Pipeline

### 9.1 Flow for "Generate New App" Task

```
Task: "Build X app"
    │
    ├─ PLAN phase (gemma3:27b)
    │   - Determine tech stack
    │   - Design folder structure
    │   - Identify required Railway services (web, postgres, etc.)
    │
    ├─ CODE phase (qwen2.5-coder:14b)
    │   - Generate files iteratively
    │   - Write to SSD: /Volumes/[SSD]/localclaw/projects/[app-name]/
    │
    ├─ TEST phase
    │   - npm install
    │   - npm run lint
    │   - npm test (if tests exist)
    │   - Fix errors (up to 3 iterations)
    │
    ├─ GIT phase
    │   - git init
    │   - Create GitHub repo (via API)
    │   - git push
    │
    ├─ DEPLOY GATE (Telegram)
    │   - "App ready. Deploy to Railway?" → await /deploy
    │
    ├─ RAILWAY phase (if approved)
    │   - Trigger Railway deploy
    │   - Poll status every 30s (timeout: 10 min)
    │   - Fetch logs if failed
    │
    └─ REPORT
        - Send Telegram: live URL or error details
        - Update task status in DB
        - Extract learnings
```

### 9.2 GitHub Token Scope

Use a **Fine-grained PAT** (not classic):

- Repository access: Only repos created by LocalClaw (or selected repos)
- Permissions needed: `contents: write`, `metadata: read`, `pull_requests: write`
- Token stored in: `.env` as `GITHUB_PAT`
- Never committed to any repo

### 9.3 Railway API

- Token stored in: `.env` as `RAILWAY_API_TOKEN`
- Phase 1: deploy gate is **always manual approval**
- Phase 3+: auto-deploy option per task via a task flag `auto_deploy: true`

---

## 10. Self-Improvement System

### 10.1 How It Works

After every task (success or fail), the Self-Improvement Engine runs:

```javascript
async function extractLearnings(taskId) {
  const logs = await db.query(
    'SELECT * FROM agent_logs WHERE task_id = $1 ORDER BY step_number',
    [taskId]
  );

  const prompt = `
    You are reviewing your own execution logs.
    Extract 2-5 concrete learnings that will help you do better next time.
    Format as JSON array: [{category, observation, keywords[], quality_score}]
    
    Logs: ${JSON.stringify(logs)}
  `;

  const response = await ollama.call('qwen2.5-coder:7b', prompt);
  const learnings = JSON.parse(response);

  for (const learning of learnings) {
    await db.query(
      'INSERT INTO learnings (task_id, category, observation, keywords, quality_score) VALUES ($1,$2,$3,$4,$5)',
      [taskId, learning.category, learning.observation, learning.keywords, learning.quality_score]
    );
  }
}
```

### 10.2 Retrieval at Task Start

```javascript
async function getRelevantLearnings(taskDescription) {
  // Phase 1: keyword matching
  const keywords = extractKeywords(taskDescription); // simple tokenization
  return await db.query(
    `SELECT observation FROM learnings
     WHERE keywords && $1::text[]
     ORDER BY times_applied DESC, quality_score DESC
     LIMIT 20`,
    [keywords]
  );
  // Phase 3+: replace with pgvector semantic search
}
```

### 10.3 Meta-Summarization (every 10 tasks)

A background job runs Ollama to compress all learnings into high-level `insights` — stored back to Postgres. This prevents context bloat over time as learnings accumulate.

---

## 11. Security & Safety

### 11.1 Telegram Authorization

LocalClaw only processes messages from `TELEGRAM_CHAT_ID`. All other messages are ignored silently.

```javascript
bot.on('message', (ctx) => {
  if (ctx.from.id.toString() !== process.env.TELEGRAM_CHAT_ID) return;
  // handle command
});
```

### 11.2 Shell Command Safety

All `shell.run()` calls:

- Execute in the project's SSD workspace directory only
- Have a configurable timeout (default: 120 seconds)
- Block certain commands: `rm -rf /`, `sudo`, `curl | bash`, etc.
- Log every command to `agent_logs`

### 11.3 GitHub PAT Scope Limiting

- Fine-grained PAT, not a classic full-access token
- Restrict to specific repos once LocalClaw has created them
- Rotate every 90 days (add as a recurring task)

### 11.4 Fail-Safe Behaviors

| Scenario | Behavior |
|---|---|
| Ollama unresponsive | Retry 3x with 10s backoff, then pause + notify Telegram |
| Postgres connection lost | Retry 5x, then PM2 restarts the process |
| Task stuck > 2 hours | Auto-mark as `blocked`, notify Telegram |
| 3 consecutive task failures | Auto-pause, notify Telegram |
| External SSD not mounted | Halt all task execution, alert Telegram immediately |

---

## 12. Folder Structure

### 12.1 LocalClaw Core (Mac Mini — internal SSD)

```
~/localclaw/
├── .env                          # All secrets (never committed)
├── package.json
├── pm2.config.js                 # PM2 process config
│
├── src/
│   ├── index.js                  # Entry point, starts orchestrator
│   ├── orchestrator.js           # Main loop, state machine
│   ├── agent/
│   │   ├── executor.js           # ReAct loop implementation
│   │   ├── planner.js            # Planning prompts + parser
│   │   └── verifier.js           # Post-execution verification
│   │
│   ├── llm/
│   │   ├── ollama.js             # Ollama HTTP client
│   │   └── modelSelector.js     # Route step → model
│   │
│   ├── tools/
│   │   ├── registry.js           # Tool definitions
│   │   ├── fs.js                 # Filesystem tools
│   │   ├── shell.js              # Shell execution
│   │   ├── git.js                # GitHub + git tools
│   │   ├── railway.js            # Railway API tools
│   │   ├── postgres.js           # DB tools
│   │   └── telegram.js           # Telegram tools
│   │
│   ├── skills/
│   │   ├── manager.js            # Load, run, create skills
│   │   └── builtin/              # Built-in skill files
│   │
│   ├── selfimprovement/
│   │   ├── extractor.js          # Post-task learning extraction
│   │   ├── retriever.js          # Fetch relevant learnings
│   │   └── summarizer.js         # Meta-summarization job
│   │
│   ├── telegram/
│   │   ├── bot.js                # Bot instance + command handlers
│   │   └── commands.js           # /status, /pause, /add, etc.
│   │
│   ├── db/
│   │   ├── client.js             # PG pool
│   │   └── migrations/           # SQL migration files
│   │       ├── 001_initial.sql
│   │       └── 002_skills.sql
│   │
│   └── config.js                 # Load + validate env vars
│
└── logs/                         # PM2 logs (auto-created)
```

### 12.2 External SSD Layout

```
/Volumes/[YourSSD]/localclaw/
├── projects/
│   ├── safe-commit/              # First real project
│   │   ├── frontend/
│   │   ├── backend/
│   │   └── ...
│   └── [next-app]/
│
├── workspace/
│   └── tmp/                      # Agent temp working area
│
└── backups/
    └── [date]/                   # Periodic DB + project snapshots
```

---

## 13. Phase-wise Build Plan

> **Build method:** Codex CLI builds the initial system. Once bootstrapped, LocalClaw works on itself.

---

### Phase 0 — Prerequisites (Before Codex runs)
**Duration:** 1–2 hours (manual setup)

| Step | Action |
|---|---|
| P0.1 | Verify Ollama running: `ollama list` — share output to finalize model config |
| P0.2 | Pull models: `ollama pull qwen2.5-coder:14b` (if not present) |
| P0.3 | Verify Postgres: `psql -U postgres -c '\l'` — confirm local DB access |
| P0.4 | Create Telegram bot via BotFather, save token |
| P0.5 | Get your Telegram chat ID via `@userinfobot` |
| P0.6 | Create GitHub fine-grained PAT with repo permissions |
| P0.7 | Verify External SSD mounted: `ls /Volumes/[SSD]` |
| P0.8 | Create SSD folders: `mkdir -p /Volumes/[SSD]/localclaw/{projects,workspace,backups}` |
| P0.9 | Install PM2: `npm install -g pm2` |
| P0.10 | Create `.env` file with all tokens (template in Section 15) |

---

### Phase 1 — Foundation (Codex builds this)
**Duration:** 1 session with Codex (~2–3 hours)  
**Goal:** System starts, polls DB, sends Telegram messages, can run shell commands

**Deliverables:**
- Project scaffold (`src/` structure above)
- PostgreSQL schema created and migrated
- Telegram bot live, responds to `/status`, `/pause`, `/resume`
- Orchestrator loop running (POLLING state, no tasks yet)
- Basic shell tool working
- PM2 config running LocalClaw as a background process

**Codex prompt for Phase 1:** *(see Section 14)*

**Acceptance criteria:**
- `pm2 start pm2.config.js` starts LocalClaw
- Telegram `/status` returns: `Status: RUNNING | Queue: 0 tasks | Uptime: Xm`
- Adding a row to `tasks` table → Telegram notifies "Task picked up: [title]"

---

### Phase 2 — Ollama Integration + ReAct Loop
**Duration:** 1–2 Codex sessions  
**Goal:** Agent can think through a task and generate files

**Deliverables:**
- Ollama HTTP client with model selection
- Planner (gemma3 → step-by-step JSON plan)
- Code generator (qwen2.5-coder → write files to SSD)
- Filesystem tools: write, read, mkdir, ls
- Agent log every step to `agent_logs` table

**Acceptance criteria:**
- Add task: "Create a simple Express.js hello world app"
- Agent creates `~/localclaw` → SSD project folder with working code
- Every step logged in `agent_logs`
- Telegram: "Done: Hello World app created at /Volumes/[SSD]/localclaw/projects/hello-world"

---

### Phase 3 — Git + GitHub Integration
**Duration:** 1 Codex session  
**Goal:** Agent pushes code to GitHub

**Deliverables:**
- Git tools: init, add, commit, push
- GitHub API: create repo
- GitHub PAT authentication
- Task field: `github_repo` populated after push

**Acceptance criteria:**
- Previous Hello World app is pushed to `github.com/[you]/hello-world`
- Commit message generated by agent reflects what was built

---

### Phase 4 — Railway Deployment
**Duration:** 1 Codex session  
**Goal:** Agent can deploy to Railway with approval gate

**Deliverables:**
- Railway API tools: deploy, status, getLogs
- Telegram approval gate: agent asks, waits for `/deploy [id]`
- Log polling on deploy failure (fetch last 50 lines)
- Deployment row in `deployments` table

**Acceptance criteria:**
- Agent messages "App ready. Deploy?" → you reply `/deploy [id]` → Railway deploys
- If deploy fails → Telegram sends log snippet + reason

---

### Phase 5 — Self-Improvement Loop
**Duration:** 1 Codex session  
**Goal:** Agent learns from every task

**Deliverables:**
- Post-task learning extractor (Ollama call → JSON learnings)
- `learnings` table populated after each task
- Learning retriever (keyword-based) injected at task start
- Meta-summarizer job (every 10 tasks)

**Acceptance criteria:**
- After 3 tasks: `SELECT * FROM learnings` shows real observations
- Task 4 context prompt includes relevant learnings from previous tasks

---

### Phase 6 — Skills Manager
**Duration:** 1–2 Codex sessions  
**Goal:** Agent can write and register its own tools

**Deliverables:**
- Skills registry: load from DB + built-in folder
- `skills.create()` tool: agent writes + tests a new skill
- Skill versioning and success/fail tracking
- Agent can call `skills.list()` and pick the right one

**Acceptance criteria:**
- Agent identifies a repeated pattern, writes a skill, registers it to DB
- Next task uses that skill from DB, not rewriting the code

---

### Phase 7 — First Real Task: Safe-Commit
**Duration:** Ongoing — this is now LocalClaw's job  
**Goal:** LocalClaw completes the Safe-Commit project autonomously

**LocalClaw task description to add:**
```
Title: Complete Safe-Commit SaaS
Description:
  Safe-Commit is an AI-powered code auditor SaaS with:
  - Dual-AI consensus model: Claude API + Gemini API
  - Free tier: basic audit, limited requests
  - Studio plan: full audit, history, team features
  - Tech stack: React frontend, Node.js/Express backend, PostgreSQL
  - Auth: JWT
  - Payments: Razorpay
  - Target: solo builders and dev shops in India
  
  Reference any existing code in /Volumes/[SSD]/localclaw/projects/safe-commit/
  If folder is empty, generate from scratch.
  
  Push to GitHub, ask before Railway deploy.
  Ask via Telegram if any architectural decisions are unclear.
```

---

### Phase 8 — Hardening (Post Safe-Commit)
**Duration:** 1 session  
**Goal:** Production-grade reliability

**Deliverables:**
- External SSD mount check on startup (halt if not mounted)
- 3 consecutive failure → auto-pause
- Task timeout: 2 hours max per task
- Daily Telegram summary (9 AM)
- Backup job: Postgres dump + project snapshot to SSD `/backups/`
- `OLLAMA_KEEP_ALIVE` tuned for M4

---

### Phase 9 — Safe-Commit Integration
**Duration:** After Safe-Commit is live  
**Goal:** LocalClaw routes all pre-push code through Safe-Commit

**Deliverables:**
- `SAFE_COMMIT_ENABLED=true` in config
- `git.push()` calls Safe-Commit API before pushing
- HIGH risk → Telegram ask before proceeding
- MEDIUM risk → Telegram warn, auto-proceed

---

## 14. Codex Bootstrap Instructions

When you open Codex CLI tonight, use this as your starting prompt:

---

**Codex Phase 1 Prompt:**

```
Build a Node.js application called LocalClaw. This is a persistent autonomous AI developer agent.

Project structure: create all files under ~/localclaw/

Requirements for Phase 1:
1. PostgreSQL connection using pg library. Connection string from env var DATABASE_URL.
   Run migration: create tables tasks, agent_logs, agent_state, learnings, skills, deployments
   (full schema provided in the HLD doc — ask me to paste it)

2. Telegram bot using telegraf library.
   Bot token from env var TELEGRAM_BOT_TOKEN.
   Only accept messages from TELEGRAM_CHAT_ID env var.
   Commands: /status, /pause [reason], /resume, /tasks, /add <description>, /kill

3. Orchestrator loop:
   - Poll tasks table every 30 seconds for status='pending'
   - Select highest priority task (critical > high > medium > low), FIFO within priority
   - Update status to 'in_progress'
   - Log to console + agent_logs table
   - For now: just log "Would execute task: [title]" — agent executor is Phase 2
   - Update status to 'done' after fake execution
   - Respect PAUSED state: if paused, skip polling

4. Global state from agent_state table:
   - status: 'running' | 'paused' | 'stopped'
   - /pause sets it to 'paused', /resume sets to 'running'

5. PM2 config: pm2.config.js that runs src/index.js with name 'localclaw', auto-restart

6. .env.example file with all required env vars:
   DATABASE_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, GITHUB_PAT,
   RAILWAY_API_TOKEN, OLLAMA_BASE_URL, SSD_BASE_PATH, SAFE_COMMIT_ENABLED

Use async/await throughout. Proper error handling. Log all errors.
```

---

## 15. Configuration Reference

### 15.1 .env Template

```bash
# Database
DATABASE_URL=postgresql://postgres:password@localhost:5432/localclaw

# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
TELEGRAM_CHAT_ID=your_telegram_user_id

# GitHub
GITHUB_PAT=github_pat_xxxxxxxxxx
GITHUB_USERNAME=your_github_username

# Railway
RAILWAY_API_TOKEN=your_railway_token
# Leave blank until Phase 4

# Ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_KEEP_ALIVE=30s
MODEL_PLANNER=gemma3:27b
MODEL_CODER=qwen2.5-coder:14b
MODEL_FAST=qwen2.5-coder:7b

# Storage
SSD_BASE_PATH=/Volumes/YourSSDName/localclaw

# Feature Flags
SAFE_COMMIT_ENABLED=false
SAFE_COMMIT_API_URL=http://localhost:3001

# Agent Behavior
TASK_POLL_INTERVAL_MS=30000
TASK_MAX_RETRIES=3
TASK_TIMEOUT_HOURS=2
MAX_CONSECUTIVE_FAILURES=3
DAILY_SUMMARY_HOUR=9

# Security
ALLOWED_SHELL_TIMEOUT_MS=120000
```

### 15.2 pm2.config.js

```javascript
module.exports = {
  apps: [{
    name: 'localclaw',
    script: './src/index.js',
    watch: false,
    env_file: '.env',
    restart_delay: 5000,
    max_restarts: 10,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    merge_logs: true
  }]
};
```

---

## 16. Decisions Log

| # | Decision | Choice | Rationale | Revisit |
|---|---|---|---|---|
| 1 | LLM provider | Ollama local only | Zero cost, privacy, M4 capable | If task quality is poor: add OpenRouter as fallback |
| 2 | Two models | gemma3 (plan) + qwen2.5-coder (code) | Best local split for reason vs code | After `ollama list` review |
| 3 | Model execution | Sequential, not parallel | 16GB unified RAM constraint | Phase 8+ if upgraded to 32GB Mac Mini |
| 4 | GitHub | Personal account + fine-grained PAT | Showcasing on profile, no bot account overhead | Can add bot account later |
| 5 | Railway deploy | Manual approval gate by default | Safety — you approve every deploy | Per-task `auto_deploy` flag in Phase 4 |
| 6 | Code sandboxing | child_process + timeout (Phase 1) | Good enough for personal use | Add Docker in Phase 8 |
| 7 | Safe-Commit | `SAFE_COMMIT_ENABLED=false` flag | Safe-Commit not finished yet | Flip to `true` after Safe-Commit Phase 9 |
| 8 | Project storage | External SSD always connected | Keeps Mac Mini storage clean | |
| 9 | First real task | Complete Safe-Commit | Highest priority side project | |
| 10 | Vector search | Keyword match (Phase 1), pgvector (Phase 5+) | Avoid complexity in v1 | Add pgvector extension in Phase 5 |

---

*Document version: 1.0 — Will be updated after `ollama list` review and Phase 1 completion.*  
*Next action: Share `ollama list` output → update Section 6 → start Codex Phase 1 tonight.*
