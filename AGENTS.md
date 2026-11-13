# Project guidance

`pi-background-monitor` is a Pi extension for detached tmux jobs, bounded journal logs and live-session filters. Keep the README concise and aligned with implementation; do not claim lossless monitoring, exactly-once delivery or unverified platform support.

## Working style

- Inspect callers and tests, preserve unrelated work and commit logical milestones when requested.
- Use `.agents/skills/planning/SKILL.md` and `.agents/plans/` for multi-step work. Plans are aspirational where they differ from implementation.
- Read installed Pi extension documentation before changing integration or lifecycle behavior.
- Tools use the `bgmon_` prefix; slash commands and settings live under `/bgmon`.

## Architecture and invariants

- `src/index.ts` owns Pi tools and binding lifecycle; `src/broker.ts` owns live sharing and watch scheduling; `src/manager.ts` manages jobs and historical references; `src/capture.mjs`, `src/journal.ts`, `src/storage.ts` and `src/text.mjs` implement bounded capture and reading; `src/tmux.ts` wraps private tmux control.
- Watches, cursors, notifications and delivery are in memory and exist only in the current live Pi process. Subagent bindings share indexed sources and root-configured group limits; origins come from the harness session marker, not tool arguments. Retained child jobs count until forgotten. Each binding owns its watches. No offline matching, Pi restart, automatic controller adoption or watch recovery. After the last binding leaves, explicit session-owned log references permit historical inspection but do not restore controllers.
- Never target the user's default tmux server. Use private sockets, verify ownership and producer identity before destructive operations, and clean up test servers in `finally`. Stop can interrupt or kill an owned pane but cannot guarantee termination of detached descendants. Pi shutdown normally detaches jobs; unresolved release writes may retain bounded supervision until settlement.
- Commands execute with user privileges and are not sandboxed. tmux ownership is not protection from malicious same-user processes. Logs and labels can contain secrets; terminal output is untrusted. Automatic model alerts contain metadata, not commands, patterns or output.
- Bound jobs, journals, parser state, IO, watches and notifications. Retention gaps, stalled capture, proof uncertainty and unconfirmed delivery must be visible; no lossless or exactly-once claim. Headless UI-only events remain inspectable in the live event list.
- Source stop evidence may be retried while the Pi process lives; crashes or interrupted cleanup can strand reservations. Do not silently reclaim uncertain producers. The outstanding supervisor-removal/proof shutdown race is documented in plan 013.
- Maintain Linux/macOS portability. Avoid GNU-only runtime utilities and native dependencies. No web server or browser viewer is part of the extension.

## Verification

Run `npm run check`, `npm run lint`, `npm test` and relevant focused regressions. Use `npm run format` before committing and `npm pack --dry-run` when packaging is relevant. CI targets Linux/macOS and Node 22; report actual locally tested platforms and versions.
