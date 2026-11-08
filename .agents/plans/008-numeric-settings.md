# Numeric monitor settings

- [x] Inspect current limits, persistence, manager recovery, tests, and installed Pi custom UI/Input docs.
- [x] Replace cycling with direct numeric entry and Enter validation in `src/ui.ts`; extend manager's recovery/start hard ceiling to 64; update README.
- [x] Add dialog, validation, persistence and manager ceiling regressions; run check, lint and tests.

Regression criteria: typing and Enter fails to save either field; invalid values save or silently clamp; limits above 8 cannot start or recover; defaults differ from 8 running and 16 retained. Primary references: installed `docs/extensions.md` custom UI/overlay section and `examples/extensions/overlay-qa-tests.ts` Input handling. Interactive rendering and macOS are separate checks.

Linux validation: `npm run format`, `npm run check`, `npm run lint` (29 pre-existing warnings), `npm test` (24 passed). Tests cover invalid inputs, saving 1 and 64, defaults, and recovery of nine jobs. Interactive terminal rendering, macOS, and the full 64-job boundary were not exercised.
