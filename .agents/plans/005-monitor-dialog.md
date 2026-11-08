# Monitor dialogs and session limits

- [x] Inspect extension architecture, sibling dialogs and installed Pi integration docs.
- [x] Implement session-persisted limits (running and retained, each 1–8; retain process-wide safety caps), command previews and a readable dashboard/settings UI with completion.
- [x] Add focused tests for limits, persistence, recovery, UI routing and completion; run check, lint and tests.

Files: src/index.ts, src/broker.ts, src/manager.ts, new UI/settings module, tests and README. A regression would be starts exceeding either configured limit, recovery rejecting older registries, terminal escapes leaking into UI, or changing shared-index caps. Existing jobs are retained when limits are lowered. Watches are independent subscriptions; their interval and expiration are displayed for the current session, not interpreted as job timeouts.

Validation: `npm run check`, `npm run lint` (existing warnings), `npm test` (22 passed), `npm pack --dry-run` and focused settings test passed on Linux. TUI was tested through a component harness, not visually rendered. macOS not tested locally. The selected monitor shows up to three watch details and a count of any remaining watches; the watch tool lists all.
