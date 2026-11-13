# 016: Prune redundant tests

- [x] Audit all test files against end-to-end coverage, keeping security, boundary, failure, and regression cases.
- [x] Remove tests that duplicate higher-level behavior or only exercise obvious implementation details; leave production behavior unchanged.
- [x] Run `npm run check`, `npm run lint`, and `npm test`; record results and residual risks.

Scope: `tests/*.test.ts` and this plan. A failure in the retained suite or loss of unique critical coverage would disprove the pruning choices.

Verification: Linux, Node v26.13.0, tmux 3.6. `npm run check` passed; `npm run lint` passed with 19 pre-existing warnings; `npm test` passed 103 tests. Node 22 and macOS not exercised. Three redundant executed tests removed; critical boundary, failure, ownership, and race scenarios remain.

Follow-up audit: removed the redundant single-binding wake test (the shared-bindings integration covers wake delivery and redaction) and the obsolete-locator test (it adds an unused entry after session start). Removed brittle exact schema/property ordering and decorative border/highlight assertions while retaining routing, tab behavior, sizing, and validation coverage. Re-run all checks after these changes.

Follow-up checks: `npm run check` passed; `npm run lint` passed with 18 existing warnings; `npm test` passed 101 tests on Linux/Node 26.13.0/tmux 3.6. Node 22 and macOS remain untested.
