# localclaw Runbook

## 1. Project Overview
`localclaw` is an autonomous coding engine acting as a persistent developer partner. It integrates with GitHub for code management, Railway for cloud deployments, and Telegram for operator alerts and remote control.

## 2. Startup & Execution

### 2.1. Start the PostgreSQL Database
```bash
cd /Users/aritrarpal/Documents/workspace_biz/localclaw
docker-compose up -d postgres
```

### 2.2. Start the Engine (PM2)
The backend runs as a persistent process.
```bash
pm2 start pm2.config.cjs
pm2 logs localclaw
```

### 2.3. Start the Operator UI
The UI is available on port 5173 (dev) or served via port 4173 (prod).
```bash
npm run ui:dev
# Open: http://127.0.0.1:5173/
```

## 3. Ollama & Models
All models are stored on the external SSD.

### 3.1. Warm up models
Ensure models are pulled and ready:
```bash
ollama pull qwen2.5-coder:14b
ollama pull qwen2.5-coder:7b
ollama pull llama3.2:3b
ollama pull nomic-embed-text:latest
```

### 3.2. Model Configuration
Current assignments from `.env`:
- **Planner/Reviewer:** `qwen2.5-coder:14b`
- **Coder:** `qwen2.5-coder:7b`
- **Fast/Utility:** `llama3.2:3b`
- **Embeddings:** `nomic-embed-text:latest`

External SSD Path: `/Volumes/Ari_SSD_01/AI_MODELS/ollama/models`

## 4. CLI Interaction
The `localclaw` CLI is used for status checks and task management.

```bash
localclaw doctor      # Check health
localclaw status      # View engine state
localclaw chat        # Start interactive planning
localclaw tasks       # List active tasks
```

## 5. Integration Details
- **Telegram Bot:** Sends alerts and requests deploy approvals.
- **GitHub:** Automatically publishes successful local work (configured to `GITHUB_REPO_OWNER=Aritra1704`).
- **Railway:** Automated deployments to Railway (enabled).
- **Control API:** Runs on port `4173` (Token: `genie123`).
- **Workspace Roots:** `/Users/aritrarpal/Documents/workspace_biz`
- **External SSD Projects:** `/Volumes/Ari_SSD_01/PROJECTS/localclaw`

## 6. Troubleshooting
- **Database:** Ensure port `54329` is not blocked.
- **Ollama:** If models are slow, ensure the external SSD is mounted.
- **PM2:** Restart with `pm2 restart localclaw --update-env` after `.env` changes.


the right input:
/plan Read /Users/aritrarpal/Documents/workspace_biz/ContractGenie/docs/localclaw_execution_guide.md and create a task plan for Stage 1 only. Stage 1 means "Phase 1: Engine Startup & Verification". Do not execute commands. Output an ordered task list with dependencies, checks, and approval points.


two-step flow:
/draft Read /Users/aritrarpal/Documents/workspace_biz/ContractGenie/docs/localclaw_execution_guide.md and create a Stage 1-only plan. No execution.

after reviewing the draft:
/plan Read /Users/aritrarpal/Documents/workspace_biz/ContractGenie/docs/localclaw_execution_guide.md and create a Stage 1-only plan. No execution.
