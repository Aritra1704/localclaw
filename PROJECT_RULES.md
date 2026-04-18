# Project Rules

## Engineering

- Keep changes small, explicit, and readable.
- Prefer deterministic behavior over clever abstractions.
- Do not commit secrets, tokens, or local-only credentials.

## Testing

- Add or update a runnable verification path for meaningful changes.
- Fail fast when required runtime configuration is missing.
- Keep logs useful enough for a human operator to diagnose the latest step.

## Git Hygiene

- Do not commit OS junk such as `.DS_Store` or `._*`.
- Keep ignored local overrides in `PROJECT_CONTEXT.local.md` and `.opskit/settings.local.json`.

## Deployment

- Deployment remains approval-gated.
- Treat external actions as blocked until the operator confirms them.
