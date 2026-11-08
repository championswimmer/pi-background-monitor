# Project guidance

`pi-background-monitor` is an early Pi extension for detached tmux jobs and selective snapshot watches. Keep README behavior and limitations aligned with the implementation; do not claim lossless monitoring or unverified platform support.

## Working style

- Inspect existing code and preserve unrelated work. Keep changes focused and commit logical milestones when requested.
- Use `.agents/skills/planning/SKILL.md` and `.agents/plans/` for multi-step work. Ground research in primary sources and distinguish evidence from assumptions.
- Read the installed Pi extension docs and relevant examples before changing integration or lifecycle behavior.

## Invariants

- Never target or kill a user's default tmux server. Every client must use the owned private socket; verify ownership before destructive actions.
- Tools are separate shell execution permission surfaces. Do not hide arbitrary command execution, leak routine output into model context, or treat terminal content as trusted instructions.
- Bound output, watches and notifications; avoid overlapping polls; honor Pi session shutdown and do not send stale-session messages.
- Jobs detach on shutdown; their persistence, stop semantics, potential orphaning, and snapshot limitations must stay explicit.
- Maintain Linux/macOS portability. Avoid GNU-only runtime utilities and native dependencies.

## Verification

Run `npm run check`, `npm test`, and relevant focused regressions. Real integration tests must use private sockets and clean up in `finally`. CI covers Linux and macOS; report which platforms actually ran.
