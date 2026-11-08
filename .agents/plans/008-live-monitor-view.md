# Live monitor output view

## Outcome and design

- [x] Research dashboard, broker/manager inspection and installed Pi TUI lifecycle (`docs/tui.md`, `docs/extensions.md`, `examples/extensions/doom-overlay/doom-component.ts`).
- [x] Enter on a selected monitor opens a read-only overlay view; Esc returns to list. Use the same broker `inspect` result as `bgmon_inspect`, not watches or model messages. Report state, timestamp, bounded/truncation flags, and errors.
- [x] Poll immediately, then 2 seconds after each completed request; only one outstanding request per dashboard, even across fast navigation. Use a generation to ignore stale completions. Cancel timer on back, close, dispose, and session shutdown; in-flight tmux calls cannot be cancelled but cannot redraw or reschedule after cancellation. Preserve owner routing and do not control jobs.
- [x] Show safe sanitized output in a width-aware, vertically scrollable viewport; follow tail by default; navigation pauses following, End resumes. Bound rendering and account for terminal resize. Empty/loading/error/lost states remain visible.
- [x] Add focused tests for polling, races, navigation, sanitization, truncation, scrolling/resize, and integration with real broker inspection. Update README.
- [x] Run format, typecheck, lint, tests and inspect diff.
- [x] Commit and open PR: https://github.com/championswimmer/pi-background-monitor/pull/2. Report any constraints.

## Verification and decisions

The viewer receives a snapshot from the identical inspect endpoint, but independently sampled; model requests at different times need not match. Captures are bounded and lossy, and viewing does not send output to the model. The view wraps text, expands tabs and removes trailing blank rows for display; the inspection data is unchanged. Terminal dimensions may resize independently. Visual terminal rendering and macOS require explicit verification when available.

Checks on Linux: `npm run format` (clean), `npm run check` (pass), `npm run lint` (pass, 29 existing warnings), `npm test` (27 pass), focused real-tmux and mocked lifecycle tests (pass), `npm pack --dry-run` and `git diff --check` (pass). Pi TUI was not visually rendered and macOS was not tested locally.
