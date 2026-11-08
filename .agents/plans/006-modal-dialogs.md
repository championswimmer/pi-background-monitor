# Bordered modal dialogs

- [x] Inspect current UI, callers, tests, and installed Pi overlay documentation/example.
- [x] Change `src/ui.ts` settings and browser to centered, bordered `ctx.ui.custom` overlays while preserving input and settings persistence; constrain rendering to terminal dimensions.
- [x] Add focused UI harness regressions and run check, lint, and tests.

A regression would be either dialog not requesting overlay mode, losing its border at normal or narrow sizes, overflowing the terminal, or breaking selection, dismissal, and saved settings. Visual rendering requires an interactive terminal and will be reported separately.

Primary reference: installed `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` (Overlay Mode) and `examples/extensions/overlay-test.ts`.

Validation: Linux: `npm run check`, `npm run lint` (29 existing warnings), `npm test` (22 passed). Component harness checks borders, sizing, overlay mode, dismissal and settings persistence; interactive visual rendering and macOS were not verified.
