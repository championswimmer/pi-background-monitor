# bgmon interface split

## Goal and design

Replace the two overloaded public tools with four intention-focused tools:
`bgmon_start` executes Bash, `bgmon_inspect` lists or inspects monitors,
`bgmon_control` controls jobs and servers, and `bgmon_watch` manages independent
subscriptions. Distinguish monitor and watch identities and reject irrelevant or
missing action-specific arguments. Rename the slash command to `/bgmon`. There are
no settings yet; reserve `/bgmon` for future settings in AGENTS.md. Preserve the
existing broker API, shared-state protocol keys, persisted locator and private
socket/recovery semantics. No compatibility aliases.

Evidence: inspected `src/index.ts`, `src/broker.ts`, `tests/extension.test.ts`,
README, AGENTS.md, and installed Pi 1.5.0 `docs/extensions.md` registerTool and
registerCommand sections and `examples/extensions/commands.ts`.

## Phases

- [x] Inspect current integration, tests, planning skill and Pi API documentation.
- [x] Implement four tool declarations, action validation and `/bgmon` command.
- [x] Migrate real integration tests and add schema/validation/command regressions.
- [x] Update concise README reference and future settings convention in AGENTS.md.
- [x] Run format, typecheck, lint, tests, whitespace and package dry-run on Linux.
- [x] Independent review; no demonstrated correctness/security findings.
- [x] Commit and push implementation.

## Risks and checks

Ensure absent/empty IDs cannot accidentally inspect all monitors or stop the caller's
server; test action-specific misuse explicitly. Preserve recovery and real Pi loader
sharing tests. Shell execution remains explicit and separately permissioned. Linux
checks do not verify macOS. Implementation touches `src/index.ts`,
`tests/extension.test.ts`, `README.md`, and `AGENTS.md`; notification wording may
also change in `src/broker.ts` without altering durable keys.

## Verification log

Linux: format, typecheck, lint (nonfatal warnings), all 19 tests, diff check and
package dry-run pass. Initial suite hit an existing fixed-time watch race; bounded
polling now awaits the actual notification before asserting. Review is pending.

Independent reviewer `/root/bgmon-interface/review-interface` found no demonstrated
correctness or security defects. Architect independently reran check, lint, all 19
tests, diff check and package dry-run successfully on Linux. Lint warnings remain;
macOS was not tested locally. The initial timing failure and bounded-polling fix
are recorded above.
