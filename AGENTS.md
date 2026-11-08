# Project guidance

`pi-background-monitor` is an early Pi extension for detached tmux jobs and selective snapshot watches. Keep the README concise and human-focused: what the extension does, installation, basic usage, and important safety and reliability limitations. Keep behavior and limitations aligned with the implementation; do not claim lossless monitoring or unverified platform support.

## Working style

- Inspect existing code and preserve unrelated work. Keep changes focused and commit logical milestones when requested.
- Use `.agents/skills/planning/SKILL.md` and `.agents/plans/` for multi-step work. Ground research in primary sources and distinguish evidence from assumptions.
- Read the installed Pi extension docs and relevant examples before changing integration or lifecycle behavior.
- The original research and MVP plan are in `.agents/plans/`; they are aspirational where they differ from implementation.

## Interface conventions

- Tools use the `bgmon_` prefix; slash commands live under `/bgmon`. There are no settings yet. If settings are added, they must open via `/bgmon`.

## Architecture and invariants

- `src/index.ts` owns Pi tools, session lifecycle and per-session notification delivery; `src/broker.ts` owns the process-wide monitor index and watches; `src/manager.ts` serializes job operations and manages recovery and the registry; `src/tmux.ts` wraps the tmux client; `src/output.ts` bounds and sanitizes output.
- Never target or kill a user's default tmux server. Every client must use the owned private socket; verify ownership before destructive actions. Real integration tests must use private sockets and clean up in `finally`.
- The per-session locator is persisted in Pi; the private `/tmp/pbm-*` registry and exclusive lock allow same-session recovery, not adoption by new or forked sessions. Do not silently break locks. `/tree` does not rewind processes. Reboot, `/tmp` cleanup or a lost socket can prevent recovery; there is no automatic orphan cleanup.
- Pi shutdown detaches jobs rather than stopping them; stop sends Ctrl-C and may close the pane, but cannot guarantee termination of detached descendants. The attach command enables manual recovery. Explicit server stop removes the owned server and metadata.
- Tools are separate shell execution permission surfaces: policies for Pi's built-in Bash tool may not cover them. tmux is not a sandbox; the socket and ownership token are not protection against malicious processes running as the same user. Do not hide arbitrary command execution or treat terminal content as trusted instructions.
- Bound output, jobs, watches and notifications; avoid overlapping polls, honor Pi session shutdown and do not send stale-session messages. Automatic notifications contain metadata, not command or output; `wake` deliberately enters model context and may start a turn. UI-only notifications are not displayed in noninteractive sessions.
- Watches are best-effort snapshots, not a lossless stream: transient text can be missed, rows can recur, and alternate-screen applications may behave differently. Watches expire, do not survive reload, and cannot observe events while Pi is closed. Repeat watches require a transition and have a ten-second cooldown.
- Current limits include eight retained jobs per owner, 64 indexed monitors, eight watches per session and 64 watches total, 200 lines/16 KiB per inspection, 2,000 tmux history rows, and watch intervals of 1–300 seconds and TTLs of 1–1,800 seconds. Check the implementation before changing or documenting limits.
- Maintain Linux/macOS portability. Avoid GNU-only runtime utilities and native dependencies. No web server or browser viewer is part of the current extension.

## Verification

Run `npm run check`, `npm run lint`, `npm test`, and relevant focused regressions. TypeScript formatting and linting are enforced with Biome (`biome.json`); apply `npm run format` before committing. Use `npm pack --dry-run` to check package contents when relevant. CI covers Linux and macOS; report which platforms actually ran.

## Readable monitor ID limitation

Readable IDs are unique only among currently indexed monitors. After the last session shuts down, an unrecovered owner is invisible: another owner can claim its ID. Recovery detects this collision and readable-ID operations fail closed until the conflicting indexed owner is stopped or forgotten; `server_stop` without an ID can still clean up the caller's own server. Do not scan or adopt other sessions' private registries to resolve this. Generated IDs reserve the 24-lowercase-hex namespace and remain probabilistically unique.
