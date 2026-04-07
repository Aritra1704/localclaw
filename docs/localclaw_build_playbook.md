# LocalClaw Build Playbook

Version: 1.0  
Date: 2026-04-07  
Purpose: macro-step implementation plan, environment preparation guide, schema blueprint, and testing matrix for LocalClaw

## 1. Build Strategy

The build is split into macro stages. Each stage must produce observable outputs before the next stage begins. Phase 4 is the MVP checkpoint and must be crossed before the platform enables advanced self-improvement features.

## 2. Macro Stages

### Stage A: Repository and Folder Creation

Create the LocalClaw project root and supporting storage layout.

Recommended layout:

```text
~/localclaw/
  package.json
  pm2.config.js
  .env
  src/
  db/
    migrations/
  prompts/
  skills/
    builtin/
  docs/
  scripts/
  logs/

/Volumes/<SSD>/localclaw/
  projects/
  workspace/
  backups/
  sandboxes/
```

Actions:

- create LocalClaw repository locally
- initialize git
- create baseline folder structure
- decide package manager and lockfile policy
- connect external SSD path through config

Testing:

- verify all required directories exist
- verify the SSD path is mounted and writable
- verify the repo can be initialized without secret files being tracked

### Stage B: GitHub Repository Creation

Create the remote repository and credential policy.

Actions:

- create GitHub fine-grained PAT
- grant `contents:write`, `metadata:read`, `pull_requests:write`
- create repository `localclaw`
- add remote to local repo
- confirm push from local machine

Testing:

- `git status` works in the repo
- empty or bootstrap commit can be pushed
- PAT scope is sufficient but not broader than required

### Stage C: Environment Bootstrap

Required env vars:

```bash
DATABASE_URL=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
GITHUB_PAT=
GITHUB_USERNAME=
RAILWAY_API_TOKEN=
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_KEEP_ALIVE=30s
MODEL_PLANNER=gemma4:e4b
MODEL_CODER=qwen2.5-coder:7b
MODEL_FAST=qwen2.5:7b-instruct
MODEL_REVIEW=gemma4:e4b
MODEL_EMBED=nomic-embed-text:latest
SSD_BASE_PATH=
DOCKER_SANDBOX_ENABLED=false
TASK_POLL_INTERVAL_MS=30000
TASK_TIMEOUT_HOURS=2
MAX_CONSECUTIVE_FAILURES=3
```

Actions:

- create `.env.example`
- create runtime env validation
- fail startup if mandatory env vars are missing

Testing:

- missing env vars fail fast with a readable message
- valid env vars allow a clean bootstrap

### Stage D: Database Schema Creation

Use SQL migrations applied through code. LocalClaw should never depend on manual ad hoc schema edits in production-like execution.

Required tables:

- `schema_migrations`
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

### Stage E: Foundation Services

Actions:

- implement config loader
- implement PostgreSQL client
- implement migration runner
- implement Telegram bot
- implement orchestrator and polling
- implement state transitions and heartbeats

Testing:

- the app starts under PM2
- `/status`, `/pause`, `/resume`, `/tasks`, `/add`, `/kill` respond correctly
- tasks move through basic states in PostgreSQL

### Stage F: LLM and Tooling

Actions:

- implement Ollama client
- implement planner schema validation
- implement executor
- implement tool registry
- implement verifier skeleton

Testing:

- planner output is validated
- malformed planner output is rejected or repaired once
- a simple workspace task can be executed with logs

### Stage G: GitHub and Deployment

Actions:

- implement git wrapper
- implement GitHub repo creation
- implement Railway deploy and status polling
- add Telegram approval workflow

Testing:

- generated project can be committed and pushed
- deploy cannot proceed without approval
- failed deploy returns logs and updates DB

### Stage H: RAG, Skills, and Hardening

Actions:

- add document ingestion and chunking
- add embeddings
- add retrieval injection
- add learnings extractor
- add skill registry
- add Docker sandbox enforcement where required

Testing:

- relevant docs are retrieved into planning context
- learnings are stored and reused
- skills can be enabled and executed under policy
- sandbox restrictions are enforced

## 3. Model Catalog Requirement

The database must include a model catalog that explicitly tracks the expected runtime footprint and availability of required models.

### Suggested Table

```sql
CREATE TABLE model_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_tag TEXT UNIQUE NOT NULL,
  runtime TEXT NOT NULL,
  purpose TEXT NOT NULL,
  is_required BOOLEAN NOT NULL DEFAULT FALSE,
  is_installed BOOLEAN NOT NULL DEFAULT FALSE,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  fallback_order INTEGER,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Suggested Seed Data

```sql
INSERT INTO model_catalog
  (model_tag, runtime, purpose, is_required, is_installed, health_status, fallback_order, notes)
VALUES
  ('gemma4:e4b', 'ollama', 'planning_and_review', TRUE, TRUE, 'unknown', 1, 'mandatory planner model'),
  ('qwen2.5-coder:7b', 'ollama', 'coding_and_debugging', TRUE, FALSE, 'missing', 1, 'pull if not already installed'),
  ('nomic-embed-text:latest', 'ollama', 'embeddings', TRUE, TRUE, 'unknown', 1, 'mandatory retrieval model'),
  ('qwen2.5:7b-instruct', 'ollama', 'summarize_and_classify', FALSE, TRUE, 'unknown', 2, 'fast utility model'),
  ('llama3.1:8b', 'ollama', 'reasoning_fallback', FALSE, TRUE, 'unknown', 3, 'general fallback'),
  ('mistral:7b', 'ollama', 'assistant_fallback', FALSE, TRUE, 'unknown', 4, 'tertiary fallback');
```

## 4. Core Schema Blueprint

### `tasks`

Suggested minimum fields:

```sql
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'manual',
  project_name TEXT,
  project_path TEXT,
  repo_url TEXT,
  locked_by TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  blocked_reason TEXT,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### `agent_logs`

```sql
CREATE TABLE agent_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  step_type TEXT NOT NULL,
  model_used TEXT,
  tool_called TEXT,
  status TEXT NOT NULL,
  input_summary TEXT,
  output_summary TEXT,
  duration_ms INTEGER,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### `approvals`

```sql
CREATE TABLE approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  approval_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_via TEXT NOT NULL DEFAULT 'telegram',
  request_message_id TEXT,
  response_message_id TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  response_payload JSONB
);
```

### `deployments`

```sql
CREATE TABLE deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'railway',
  target_env TEXT NOT NULL DEFAULT 'production',
  repo_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  deploy_url TEXT,
  log_snapshot TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
```

### `skills`

```sql
CREATE TABLE skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  source_type TEXT NOT NULL,
  description TEXT NOT NULL,
  definition JSONB NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### `learnings`

```sql
CREATE TABLE learnings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  observation TEXT NOT NULL,
  keywords TEXT[] NOT NULL DEFAULT '{}',
  confidence_score INTEGER NOT NULL DEFAULT 5,
  times_applied INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### `documents`, `document_chunks`, `embeddings_index`

```sql
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL,
  source_path TEXT NOT NULL,
  title TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  token_estimate INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE embeddings_index (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_chunk_id UUID NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  model_tag TEXT NOT NULL,
  embedding JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## 5. Migration Execution Via Code

### 5.1 Startup Migration Flow

At application boot:

1. validate env
2. connect to PostgreSQL
3. acquire advisory lock
4. ensure `schema_migrations` exists
5. read migration files from `db/migrations`
6. run pending migrations in order
7. insert applied version rows
8. release lock
9. continue app startup

### 5.2 Deployment-Time Migration Flow

During deployment or release boot:

1. run the same migration runner before the app accepts work
2. fail deployment if any migration fails
3. log the failing migration file and error output
4. do not mark deployment healthy until migrations succeed

### 5.3 Suggested Node.js Execution Pattern

```javascript
import fs from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';

export async function runMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_lock($1)', [424242]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const files = (await fs.readdir(path.resolve('db/migrations')))
      .filter((name) => name.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const already = await client.query(
        'SELECT 1 FROM schema_migrations WHERE version = $1',
        [file]
      );
      if (already.rowCount > 0) continue;

      const sql = await fs.readFile(path.resolve('db/migrations', file), 'utf8');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations(version) VALUES ($1)',
        [file]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [424242]).catch(() => {});
    client.release();
  }
}
```

Testing:

- run against an empty database
- run twice and confirm idempotence
- introduce a failing migration and confirm rollback

## 6. Docker Sandbox Proposal

Docker is recommended once LocalClaw begins creating and executing code in broad project workspaces.

### 6.1 Sandbox Policy

- use a curated base image
- run as a non-root user
- mount only the task workspace
- mount a read-only copy of shared docs if needed
- keep host networking disabled by default
- set CPU and memory limits
- clean up the container after execution

### 6.2 Suggested Use Cases

- install dependencies
- run tests
- run builds
- execute generated code
- perform repository-local scripts

### 6.3 Suggested Non-Use Cases in Early MVP

- simple file reads
- git status
- DB-only reads
- Telegram command handling

### 6.4 Sandbox Testing

- verify a container cannot see unrelated host directories
- verify network is blocked when disabled
- verify a failing build returns logs and exits cleanly
- verify resource limits prevent runaway processes

## 7. Testing Matrix

### 7.1 Config

- missing env vars fail startup
- malformed values fail with actionable messages

### 7.2 Database

- migrations apply cleanly
- migrations are idempotent
- task lease logic prevents duplicate pickup

### 7.3 Telegram

- only approved chat ID is accepted
- command parsing is stable
- approval responses update DB state

### 7.4 Orchestrator

- polling respects pause state
- only one task is active
- expired lease is recoverable

### 7.5 Ollama Client

- health check works
- model routing selects expected tags
- structured output parsing handles invalid JSON

### 7.6 Tools

- allowlisted commands run
- blocked commands are rejected
- filesystem writes stay within allowed paths

### 7.7 GitHub

- repository creation succeeds
- push succeeds
- auth failures are surfaced clearly

### 7.8 Railway

- deployment requires approval
- status polling updates DB
- failure logs are captured

### 7.9 RAG

- documents ingest correctly
- chunks are retrievable
- retrieved chunks are linked to execution evidence

### 7.10 Skills

- built-in skills load correctly
- disabled skills cannot run
- versioned skills are auditable

### 7.11 Docker Sandbox

- sandbox starts cleanly
- restricted mounts work
- resource limits apply

### 7.12 End-to-End

Run a sample task such as:

- create a simple Node.js hello-world service
- initialize git
- create a GitHub repo
- push code
- request deploy approval
- deploy to Railway
- log success or failure and store evidence

## 8. Acceptance Criteria by Macro Stage

### Stage A to C

- repository exists
- env policy is documented
- storage layout exists

### Stage D to F

- migrations run through code
- Telegram and orchestrator work
- executor completes a controlled task

### Stage G

- code can reach GitHub
- deployment is approval-gated
- logs and failures are captured

### Stage H

- retrieval improves planning context
- learnings are reusable
- skills are governed
- sandbox controls are enforceable

## 9. Phase 4 Checkpoint Reminder

Do not expand the platform into uncontrolled self-improvement before the following are proven:

- reliable task lifecycle
- durable state and recovery
- safe tool execution
- GitHub push
- approval-gated deployment
- observable evidence in PostgreSQL and Telegram

