# Tabbed monitor dialog

- [x] Inspect existing dialog, command routing, tests and installed Pi TUI/overlay documentation.
- [x] Unify `src/ui.ts` dialogs, route commands in `src/index.ts`, document keyboard behavior, and preserve settings state and list controls.
- [x] Add command and component regressions; run check, lint and tests on Linux.

Regression criteria: the requested initial tab is wrong, Tab cannot switch both ways, existing settings persistence or list selection/dismissal breaks, or narrow overlays overflow. Primary references: installed `docs/extensions.md` (custom UI and overlays), `docs/tui.md` (keyboard handling), and `examples/extensions/questionnaire.ts` (Tab handling). Interactive terminal rendering and macOS require separate verification.

Validation on Linux: `npm run format`, `npm run check`, `npm run lint` (29 existing warnings), and `npm test` (23 passed). Component harness covers initial tabs, bidirectional Tab switching, persistence, and data-error display. Interactive rendering and macOS remain unverified.
