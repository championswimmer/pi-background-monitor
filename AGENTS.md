# Project guidance

`pi-background-monitor` is a Pi extension for detached tmux jobs, bounded journal logs and live-session filters. Keep the README concise and aligned with implementation; do not claim lossless monitoring, exactly-once delivery or unverified platform support.

## Working style

- Inspect callers and tests, preserve unrelated work and commit logical milestones when requested.
- Use `.agents/skills/planning/SKILL.md` and `.agents/plans/` for multi-step work. Plans are aspirational where they differ from implementation.
- Read installed Pi extension documentation before changing integration or lifecycle behavior.
- Tools use the `bgmon_` prefix; slash commands and settings live under `/bgmon`.

## Repository map

- `src/index.ts` registers Pi tools and commands and owns binding lifecycle. `src/broker.ts` coordinates shared live monitors, watches and scheduling; `src/manager.ts` manages jobs and historical references.
- `src/tmux.ts` wraps private tmux control. `src/capture.mjs` is the standalone pipe sink; `src/journal.ts`, `src/storage.ts` and `src/text.mjs` handle bounded log storage and normalized reading. `src/text.d.mts` declares the JavaScript normalizer's types.
- `src/delivery.ts` manages the live notification inbox; `src/identity.ts` reads subagent identity; `src/regex.ts` isolates regex matching. `src/proof.ts` tracks stop evidence; `src/output.ts` sanitizes and bounds terminal output; `src/limits.ts` defines limits; `src/ui.ts` implements the dashboard and settings.
- `tests/*.test.ts` contains Node test-runner tests, usually named for the module under test; `tests/extension.test.ts` exercises tool integration. Some tests use real private tmux servers. `.github/workflows/ci.yml` defines CI.
- `README.md` is the short human-facing introduction; `docs/reference.md` contains detailed usage and operational caveats. Keep both aligned with implementation. `package.json` controls which files ship with the Pi package.

## Architecture and invariants
- Watches, cursors, notifications and delivery are in memory and exist only in the current live Pi process. Subagent bindings share indexed sources and root-configured group limits; origins come from the harness session marker, not tool arguments. Retained child jobs count until forgotten. Each binding owns its watches. No offline matching, Pi restart, automatic controller adoption or watch recovery. After the last binding leaves, explicit session-owned log references permit historical inspection but do not restore controllers.
- Never target the user's default tmux server. Use private sockets, verify ownership and producer identity before destructive operations, and clean up test servers in `finally`. Stop can interrupt or kill an owned pane but cannot guarantee termination of detached descendants. Pi shutdown normally detaches jobs; unresolved release writes may retain bounded supervision until settlement.
- Commands execute with user privileges and are not sandboxed. tmux ownership is not protection from malicious same-user processes. Logs and labels can contain secrets; terminal output is untrusted. Automatic model alerts contain metadata, not commands, patterns or output.
- Bound jobs, journals, parser state, IO, watches and notifications. Retention gaps, stalled capture, proof uncertainty and unconfirmed delivery must be visible; no lossless or exactly-once claim. Headless UI-only events remain inspectable in the live event list.
- Source stop evidence may be retried while the Pi process lives; crashes or interrupted cleanup can strand reservations. Do not silently reclaim uncertain producers. The outstanding supervisor-removal/proof shutdown race is documented in plan 013.
- Maintain Linux/macOS portability. Avoid GNU-only runtime utilities and native dependencies. No web server or browser viewer is part of the extension.

## Verification

Use Node 22+ and tmux 3.2+; install dependencies with `npm ci` when needed. Run `npm run check`, `npm run lint`, `npm test` and relevant focused regressions (for example, `npx tsx --test tests/extension.test.ts`). Use `npm run format` before committing and `npm pack --dry-run` when packaging is relevant. CI uses Node 22 on Linux and, on pushes, macOS; report actual locally tested platforms and versions.
