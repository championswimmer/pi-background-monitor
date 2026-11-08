# Project guidance

This repository is for `pi-background-monitor`, a planned Pi extension for asynchronous long-running jobs and selective progress monitoring. It is currently research and planning only; do not describe proposed functionality as implemented.

## Working style

- Inspect existing files and preserve unrelated work before making changes.
- Keep changes focused, document design decisions and tradeoffs, and keep the README aligned with actual behavior.
- For multi-step work, use the `planning` skill in `.agents/skills/planning/` and track plans in `.agents/plans/`.
- Ground research in primary sources where possible; record links, version or date, and distinguish observations from assumptions.
- Before implementing Pi integration, inspect the installed Pi extension documentation and relevant examples; do not assume APIs or lifecycle semantics.

## Design priorities

- Background execution must not block the agent while the job runs.
- Keep routine output out of model context; bound previews and surface relevant events deliberately.
- Consider process ownership, cancellation, cleanup, session switching, output retention and limits, and untrusted output/security in the design.
- Treat terminal, persistence, notification, and platform choices as open until researched and validated.

## Verification

Add focused tests or reproducible checks for behavior changes, including lifecycle and output limits. Record the commands actually run and any untested behavior. There is no build or test suite yet.
