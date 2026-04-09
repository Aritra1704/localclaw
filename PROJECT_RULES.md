# Project Rules

## Engineering

- Prefer deterministic behavior over clever shortcuts.
- Fail fast when required config for external systems is missing.
- Keep planner, executor, publisher, and deployer boundaries explicit.

## Testing

- Add a regression test for each production bug that is easy to encode.
- Keep unit tests fast enough to run locally on every meaningful change.
- Surface operator-visible failures with actionable messages.

## Git Hygiene

- Never commit `.DS_Store`, `._*`, `.Spotlight-V100`, or `.Trashes`.
- Keep local-only overrides out of git.
- Treat generated repo contract files as part of the product, not optional extras.

## Deployment

- External deploys remain approval-gated.
- The MVP deploy path targets one dedicated Railway service.
- A publish target must match the configured Railway service name for Phase 4.
