# LocalClaw Architecture

## 1. High-Level Design
`localclaw` is a Node.js-based autonomous coding agent. It operates as a persistent service that processes a task queue, interacts with LLMs via Ollama, and executes tools to modify project files, run tests, and manage deployments.

## 2. Component Breakdown

### 2.1. Core Orchestrator
- **Task Polling:** Continuously checks the PostgreSQL database for new or pending tasks.
- **State Machine:** Manages transitions between `pending`, `in_progress`, `waiting_approval`, `done`, and `failed`.
- **Heartbeats:** Maintains process health and ensures tasks aren't lost on restart.

### 2.2. Agent Plane
- **Planner:** Uses `qwen2.5-coder:14b` to break down objectives into structured steps.
- **Executor:** Runs the planned steps using curated tools.
- **Verifier:** Validates the outcome of each task (e.g., via `npm test` or linting).
- **Self-Healing:** Automatically attempts to repair common execution failures using an LLM-driven repair loop.

### 2.3. Tool Registry
- **Filesystem:** Atomic reads and writes within defined workspace roots.
- **Shell:** Execution of terminal commands with timeouts and redacting secrets.
- **Git/GitHub:** Automated repository creation, commits, and publishing.
- **Railway:** Automated deployment of applications to the Railway cloud.
- **Docker Sandbox:** Secure execution of untrusted or generated code.

### 2.4. Interfaces
- **CLI:** Primary control surface for status, diagnostics, and chat.
- **Operator UI:** A React/Vite dashboard for visual monitoring and approvals.
- **Telegram Bot:** Real-time alerts, deploy approvals, and basic status queries.

### 2.5. Memory & Context
- **PostgreSQL:** Stores the source of truth for all tasks, logs, and agent state.
- **RAG (Retrieval-Augmented Generation):** Indexes project docs and historical learnings to improve planner context.
- **Knowledge Graph:** Maps code symbols and dependencies for deeper impact analysis.

## 3. Storage Strategy
- **Internal Storage:** Application code and configuration.
- **External SSD (`/Volumes/Ari_SSD_01`):** 
  - **AI Models:** Ollama model weights.
  - **Projects:** Workspace directories for generated applications.
  - **Backups:** Database dumps and project snapshots.
