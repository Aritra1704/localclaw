# LocalClaw Recovery & Stabilization Plan

This document outlines the targeted modifications required to resolve the "not able to code" issue and stabilize the system.

## 1. Targeted Code Modifications

### 1.1 Increase Chat & Planning Timeouts
The current 20s timeout is too aggressive for local LLMs on most consumer hardware.
- **File:** `src/control/chat.js`
- **Action:** Update `CHAT_MODEL_TIMEOUT_MS` to `60000` (60 seconds).
- **Rationale:** Prevents `AbortError` when models are cold-starting or processing complex prompts.

### 1.2 Model Re-Assignment
The Router currently favors `gemma4` for planning, which is failing.
- **File:** `.env`
- **Action:** Set `MODEL_PLANNER=qwen2.5-coder:7b`.
- **Rationale:** Qwen 2.5 Coder has superior JSON schema adherence and is already proven to work in this environment for the `coder` role.

### 1.3 Permissive Deployment Gates
The deployment check is blocking tasks unnecessarily due to name mismatches.
- **File:** `src/railway/deployer.js`
- **Action:** Loosen `validateRepositoryName` or allow an override via `.env`.
- **Rationale:** Prevents tasks from being marked as "Blocked" after they have successfully completed the coding phase.

### 1.4 Enhanced Fallback Logic
The current fallback produces no code.
- **File:** `src/agent/planner.js`
- **Action:** Modify `buildDeterministicFallbackPlan` to include at least one `read_file` or `list_files` step to provide context for the next manual attempt.

## 2. Model Strategy (Ollama)

Based on the analysis of failures and resource usage on the Mac Mini:

| Action | Model | Reason |
| :--- | :--- | :--- |
| **DELETE** | `gemma4:e4b` | Unreliable JSON output and extremely slow (causes timeouts). |
| **KEEP** | `qwen2.5-coder:7b` | Best performing model in the current setup. |
| **ADD** | `llama3.2:3b` | Replaces `nemotron-mini` as the "Fast" model. Better reasoning for repairs. |
| **ADD** | `qwen2.5-coder:1.5b` | Ultra-fast model for routing and simple logic to keep the UI responsive. |
| **ADD** | `mistral-nemo` | (Optional) If 12B fits, it's a very strong alternative for Architecture tasks. |

## 3. Execution Order
1. Update `.env` with new model assignments.
2. Apply timeout and deployment gate code fixes.
3. Download new models via Ollama.
4. Restart LocalClaw and re-run the failed tasks.
