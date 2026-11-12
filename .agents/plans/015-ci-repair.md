# CI repair

- [x] Inspect PR run failures and workflow.
- [x] Keep Linux on push and PR; gate macOS on successful push Linux job.
- [x] Bound scheduler-dependent test waits and handle missing dead-pane PID without weakening ownership checks.
- [ ] Push and observe permitted CI runs.

CI logs: Linux Node 22 tests cancelled on unreferenced scheduler waits. macOS used tmux 3.8, which hides `pane_pid` after exit. A pane-created hook is queued rather than an atomic respawn fence, and pane options survive respawn. Missing PID is therefore reported as source_unverified, never as an authenticated exit; no individual pane operation or proof is issued. EOF still finalizes capture. Exit watches fail visibly, and deletion remains blocked until verified server closure. Regression covers a dead replacement pane.

Local Linux Node 26.13.0: format, check and lint passed (19 existing lint warnings); full suite 106/106 on tmux 3.6 and 106/106 on locally built tmux 3.8. macOS and Node 22 require CI. The original untracked plan 014 is unrelated.
