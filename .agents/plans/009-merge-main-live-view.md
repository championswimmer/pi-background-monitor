# Merge main into live monitor view

- [x] Fetch main and identify merge conflicts, preserving both features.
- [x] Resolve `tests/extension.test.ts` by keeping both sets of tests; verify output view against both generated and readable monitor IDs.
- [x] Run format, typecheck, lint, full tests and inspect diff on Linux; commit merge and push the PR branch.

Linux: `npm run format`, `npm run check`, `npm run lint` (29 pre-existing warnings), and `npm test` (30 passed). Before the merge the most recent PR and main CI runs both passed; no separate failing test was reproduced. macOS and visual TUI rendering were not tested locally.
