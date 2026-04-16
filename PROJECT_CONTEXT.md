# Project Context

## Objective

LocalClaw is a local-first autonomous engineering platform that plans work, executes controlled file/tool actions, publishes to GitHub, and gates Railway deploys behind operator approval.

## Current Checkpoint

- Phase 0: complete
- Phase 1: complete
- Phase 2: complete
- Phase 3: complete
- Phase 4: complete
- Phase 5: complete
- Phase 6: complete
- Phase 7A: complete
- Phase 7B: complete
- Phase 7C: complete
- Phase 8: complete (V2 Upgrade: Multi-Agent Routing, Reflection Engine, Web Dashboard, Auto-Tooling Sandbox)
- Phase 9: complete (Hardening, Sandbox Escalation & Production Field Safety)
- Phase 10: complete (Specialized Agent Expansion: Security, Docs, & Deps)
- Phase 11: in progress (MCP Server Integration: Standardized Tooling & DB Access)
- Phase 12: planned (Cognitive Memory: Knowledge Graph & Advanced RAG)

## Current Focus

- Standardize filesystem, retrieval-oriented PostgreSQL access, and GitHub repository operations behind internal MCP-style servers.
- Keep publish, verification, and specialized review behavior stable while those boundaries are being swapped underneath the runtime.
- Keep external MCP daemons out of scope until the internal MCP boundary is complete and the process split is justified by real operator needs.
- Use the Control Center Web Dashboard `http://localhost:5173` to monitor approvals, follow-up tasks, and runtime health during the Phase 11 transition.

## Deferred Backlog

- Evaluate standalone external MCP daemons for filesystem, PostgreSQL, and GitHub only after the internal MCP boundary is fully migrated and there is a concrete need for process isolation, multi-client sharing, or remote tool hosting.

## Local Overrides

Use `PROJECT_CONTEXT.local.md` for machine-specific or operator-only notes that must stay uncommitted.
