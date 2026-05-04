<!-- localclaw:autodoc:architecture:start -->
## Autodoc Architecture

Auto-maintained architecture snapshot for task `7be2802d-4961-451e-a2cc-45851d7aa433`.

### Task Intent

[task_contract_v1]

Objective
build a detailed architecture stating all the steps how do i build a autonomous coder, who acts as a developer and builds apps for me 24/7?

Project
- name: localclaw
- priority: medium
- publish: no
- deploy: no

In Scope
- Analyze the requested work
- Prepare a safe implementation plan
- Make only changes required by the approved task

Out Of Scope
- Unrelated refactors
- Unapproved deployment
- Bypassing approval gates

Constraints
- Use the selected project path only
- Keep changes reviewable
- Ask for approval before execution

Success Criteria
- Plan is explicit and executable
- Tests or verification steps are identified
- Operator approval is required before execution

Notes
Drafted from chat session ae09588c-20fb-4a55-931d-e68a1829040c

### Top-Level Modules

- `localclaw-backend/`
- `localclaw-frontend/`

### Notable Source Files

- `localclaw-backend/package.json`
- `localclaw-backend/src/app.js`
- `localclaw-backend/src/codegen.js`
- `localclaw-frontend/src/App.js`

### Node Entry Points

- no explicit entry point declared
<!-- localclaw:autodoc:architecture:end -->
