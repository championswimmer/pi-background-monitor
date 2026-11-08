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
- [ ] Implement four tool declarations, action validation and `/bgmon` command.
- [ ] Migrate real integration tests and add schema/validation/command regressions.
- [ ] Update concise README reference and future settings convention in AGENTS.md.
- [ ] Run format, typecheck, lint, tests, whitespace and package dry-run on Linux.
- [ ] Independent review, fix findings, commit and push implementation.

## Risks and checks

Ensure absent/empty IDs cannot accidentally inspect all monitors or stop the caller's
server; test action-specific misuse explicitly. Preserve recovery and real Pi loader
sharing tests. Shell execution remains explicit and separately permissioned. Linux
checks do not verify macOS. Implementation touches `src/index.ts`,
`tests/extension.test.ts`, `README.md`, and `AGENTS.md`; notification wording may
also change in `src/broker.ts` without altering durable keys.
