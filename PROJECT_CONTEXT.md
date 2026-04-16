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
- Phase 11: complete (MCP Server Integration: Filesystem, GitHub, task/runtime DB access, RAG, chat, projects, skills, and reflection are standardized behind internal MCP servers)
- Phase 12: planned (Cognitive Memory: Knowledge Graph & Advanced RAG)

## Current Focus

- Begin Phase 12 planning for Knowledge Graph and advanced memory primitives on top of the now-standardized internal MCP boundary.
- Keep publish, verification, deploy approval, and specialized review behavior stable while Phase 12 capabilities are added.
- Keep external MCP daemons out of scope until a concrete need emerges for process isolation, multi-client sharing, or remote tool hosting.
- Use the Control Center Web Dashboard `http://localhost:5173` to monitor runtime health, approvals, and memory-related follow-up work.

## Deferred Backlog

- Evaluate standalone external MCP daemons for filesystem, PostgreSQL, and GitHub only after the internal MCP boundary is fully migrated and there is a concrete need for process isolation, multi-client sharing, or remote tool hosting.

## Local Overrides

Use `PROJECT_CONTEXT.local.md` for machine-specific or operator-only notes that must stay uncommitted.
