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

- External deploys remain approval-gated.
- The MVP deploy path targets one dedicated Railway service.
- A publish target must match the configured Railway service name for Phase 4.
- Before invoking any external tool or service that requires a specific resource identifier (e.g., model name, API key, endpoint), the agent must verify the existence and correct format of that identifier against the known, configured environment state or schema.
