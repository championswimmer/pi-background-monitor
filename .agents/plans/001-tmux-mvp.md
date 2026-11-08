# 001 — Dedicated tmux-server MVP

Status: approved direction (tmux), implementation plan only. Written 2026-11-08; nothing in this document is implemented yet. Supersedes the Node-child-process backend recommendation in `000-research.md`. The user requests dedicated tmux servers, Linux/macOS support, further ttyd research, and incremental commits.

## Decision

Build a TypeScript Pi extension with **one private, dedicated tmux server per Pi session**, a single tmux session named `jobs`, and one window/pane per job. Pi invokes short-lived tmux clients; the job runs in the server independently of the model/tool call. Observe bounded terminal snapshots on demand and with lightweight polling watches. Never feed routine output into the model.

The first release deliberately provides **snapshot monitoring, not lossless log streaming**. A literal condition can be missed if output scrolls away or is overwritten before the next sample. Document this prominently in tool descriptions and README. This is sufficient for periodically observing an output window; reliable stream matching is a separate enhancement, not a hidden guarantee.

Jobs survive controller shutdown/reload by default. Session-scoped timers, locks and clients do not. Reattach only to the same Pi session's verified server. Explicit job-stop and server-stop operations terminate managed terminal jobs; tmux is not a sandbox or a guarantee of killing arbitrary daemonized descendants.

### Alternatives

| Option | Cost/risk/operability | Decision |
| --- | --- | --- |
| One private server per Pi session | Small shared controller, isolated settings/socket, easy attach and whole-server stop | Select |
| One server per job | Stronger fault/cleanup isolation but many server processes and sockets | Defer unless measured need |
| Windows in user's existing/default server | Less setup but affects unrelated sessions/config and unsafe whole-server cleanup | Reject |
| Node pipes only | Simple logs but no real terminal or detached server | Superseded by user direction |
| tmux control mode / `pipe-pane` | Reliable live output possible, but protocol, framing, backpressure and reconnect work | Optional later phase |
| ttyd | Browser UI, extra process/network/security surface; no monitoring capability Pi needs | Optional later browser adapter, pending parallel research |

## Inspected boundaries and evidence

The repository currently contains only README, AGENTS, a planning skill and `000-research.md`; no code, package, build or tests exist. Siblings use TypeScript, `pi.extensions` manifests, host-provided Pi/typebox peer dependencies and Node test runners. Use `src/index.ts` loading directly, as in `../pi-subagent-manager/package.json`, rather than requiring a production build.

Read the installed Pi coding-agent **1.5.0** `docs/extensions.md` in full (3,347 lines), `docs/packages.md`, `docs/tmux.md`, and the file-trigger/todo examples. Important constraints:

- Factories can run without a session: no background startup there. Start lazily; `session_shutdown` cleanup must be idempotent.
- Shutdown happens on quit, reload, new, resume and fork; captured old `pi`/`ctx` objects must not be reused after replacement.
- `pi.sendMessage()` enters model context. `followUp` waits for the agent's natural boundary; `triggerTurn: true` can wake an idle agent. `nextTurn` neither interrupts nor wakes.
- UI status belongs in `ctx.ui.setStatus`, not repeated custom model messages. `pi.appendEntry()` persists non-model-visible data.
- Tools are parallel by default: serialize controller mutations internally, including timer reconciliation and start/stop races.
- Custom tools are separate permission surfaces. A permission extension matching only built-in `bash` does not automatically approve/block these commands.

The installed tmux is **3.6 on Linux**. Inspected its manual (`/usr/share/man/man1/tmux.1.gz`): `-L` chooses a separate named server; `-S` chooses an explicit socket path and overrides `-L`; `-f` supplies server configuration; `remain-on-exit` retains exited panes; `pane_dead`, `pane_dead_status` and `pane_dead_signal` describe completion. Multi-argument `new-session`/`new-window` commands are available in this manual. Implement against **tmux >=3.2**, and verify the exact commands in Linux/macOS CI rather than assuming 3.6-only features work everywhere.

Primary source references (inspected in preceding research, 2026-11-08):

- [tmux manual, pinned](https://github.com/tmux/tmux/blob/a73616d781f2af13085691c741cfb0780d365328/tmux.1) — server socket selection, new-session/new-window, capture-pane, remain-on-exit and formats.
- [ttyd README, pinned](https://github.com/tsl0922/ttyd/blob/2922cb89f518bae4d0fcf4d757a7419638fc71fc/README.md) — web terminal, Linux/macOS build/install and network options; integrate the parallel research's exact safe flags before implementing a browser adapter.
- Pi API documentation: installed package `@earendil-works/pi-coding-agent@1.5.0/docs/extensions.md` and `docs/packages.md`; source project [earendil-works/pi](https://github.com/earendil-works/pi). Installed documentation is the versioned API evidence, not an assertion about arbitrary future Pi versions.
- Claude Monitor and Codex source citations remain in `000-research.md`.

## Concrete contracts

### Server identity, startup and persistence

1. Only support `linux` and `darwin` in MVP. Require Node >=22 and `tmux >=3.2` on PATH. Probe lazily; return actionable install/version diagnostics without affecting Pi startup. No automatic package-manager installs.
2. Prefer **`tmux -S <private-socket>`**, not a generic `-L` name. Create a short randomized directory using Node `mkdtemp` under `/tmp`, mode 0700, with socket `s`; keep the resulting socket path below 90 UTF-8 bytes for macOS Unix-domain path limits. Do not use macOS's potentially long `os.tmpdir()` blindly. No caller-supplied socket path. `-L` would also isolate the server but gives less explicit control over its private metadata directory.
3. Write a static, private server config before first launch: `remain-on-exit on`, `history-limit 2000`, `default-shell /bin/bash`, no automatic rename, fixed 120x40 terminal dimensions, manual window sizing, and `@pbm_owner <random-token>`. Do not load user's tmux config; test whether the target tmux still reads system configuration and ensure required settings are explicitly overridden. Do not claim isolation from malicious system-wide administrator config.
4. Launch the first job with `new-session -d -s jobs -n <generated-name> -x 120 -y 40`; later jobs use `new-window -d`. Use `-P -F` to obtain stable generated pane/window IDs. Set retention/history **before** starting even a very fast command, so `exit 7` is not lost to a race.
5. Every client, including status, attach instructions and kill, MUST explicitly specify this socket. Spawn with argument arrays and `shell: false`; remove inherited `TMUX`/`TMUX_PANE` from client environment. Never invoke an unscoped `kill-server`.
6. A private, versioned JSON registry contains owner Pi session ID, token, socket, generated job IDs, pane IDs, timestamps, notification/watch settings and bounded final snapshots. Atomic temp+rename writes; validate all restored fields and cap registry size (256 KiB). Private job scripts are capped at 64 KiB each. The session receives one non-model custom entry containing a locator and owner session ID. Persist the locator before job launch; a crash before successful start must leave recoverable metadata, not a secretly adopted default server.
7. Lazy recovery reads locators only for the exact current `sessionManager.getSessionId()`, then checks private directory ownership/mode, no symlink substitutions, registry schema, socket type/path and matching `@pbm_owner`. Do not create a fresh server while probing a missing one. Missing server -> jobs `lost`, no fabricated exit code. A mismatched or malformed server -> fail closed, never kill it.
8. Prevent two Pi processes controlling the same registry: acquire a directory lock with PID and random instance token. A live PID means busy; a dead PID permits serialized stale-lock recovery. Treat `EPERM` as live, tolerate PID reuse conservatively, and use token-checked release. Include concurrent lock-acquisition/stale-recovery tests; do not implement an unsafe unconditional remove/recreate race. If stale recovery cannot be made small and safe, return an actionable manual-recovery error instead.
9. `/tree` does not rewind external processes. Use the matching session locator from all session entries (not branch reconstruction); disclose this difference from pure branchable tool state. New/fork session IDs do not adopt the previous session's server. Same-session reload/resume can reconnect. No automatic cross-session adoption or scanning/killing every `pbm-*` server.
10. Shutdown: invalidate generation first, cancel all timers, await/abort pending short clients, release lock and clear UI. Leave tmux jobs/registry intact; do not emit old-session notifications. Resume polling only while that session has an active controller. No monitoring or model wake-ups while Pi is closed. On reconnect report a bounded status summary; historical output triggers are not replayed.
11. `server_stop` requires a separate explicit operation; reverify owner token, stop the server, then remove only this owned private directory. An absent server is idempotent success. If shutdown fails, retain metadata and report it. Do not recursively delete arbitrary paths supplied by restored data. Normal Pi shutdown does not imply server stop.

Persistence is **same-machine, same-user, same-tmux-server**, not reboot durability. `/tmp` cleanup, reboot and missing sockets can lose access. Abrupt crashes may leave jobs running: attach/stop commands and socket locator must be available to the user for manual recovery. No automatic orphan reaper in MVP.

### Job lifecycle and cancellation

States: `starting -> running -> exited | cancelled | lost`; startup errors roll back only the new job. A numeric exit status exists only when tmux reports it; preserve signal metadata separately. Stable generated IDs are unrelated to command text/titles.

- Command is intentional arbitrary **Bash** supplied by caller; resolve cwd from `ctx.cwd`, verify it is a directory, and cap length. Write it verbatim to a mode-0600 generated script in the private directory. Use direct tmux exec arguments `/bin/bash --noprofile --norc <script-path>`; never interpolate cwd, labels or command into tmux command syntax. Do not wrap the user's script in added shell control-flow that changes its exit semantics. Linux Bash and macOS `/bin/bash` 3.2 are both supported; generated scripts require no GNU-only features.
- Register public tools for start, bounded inspect/list, watch/unwatch, stop/forget and explicit whole-server stop. Mutations are serialized in the manager. Return promptly after startup and metadata persistence, not after job completion. Startup abort must undo a newly created pane/job, but aborting the original tool after successful return must not kill the background job.
- Keep at most **8 retained jobs**, including exited panes; require explicit `forget` to free a slot rather than silently killing/replacing another job. Maximum 8 active watches total. Cap command/title/pattern/label sizes and validate in execution too (tool_call hooks can mutate arguments after schema validation).
- Normal cancellation: capture bounded final screen, send `C-c`, wait at most 2 seconds while reconciling state, then kill that pane if still running. Record `cancelled` without inventing a command exit status. Scope every target by verified stored pane ID. A missing pane becomes `lost` unless already finalized. Never derive a `kill(-pid)` target from untrusted terminal text.
- Closing the PTY/tmux pane normally signals terminal jobs, but deliberately detached/daemonized descendants can escape; document this limitation. This is not a sandbox. Do not promise universal process-tree termination on either OS.
- `forget` only accepts terminal jobs (or requires explicit stop first), removes their pane/script/registry record and is idempotent. Whole-server stop is the only operation that intentionally affects all retained jobs in that server.

### Bounded observation and selective reactions

Use `capture-pane -p` without `-e` (no intentional ANSI output), optionally `-J` for wrapped logical lines, with a bounded recent history range (default 200 rows, maximum 500). Offer current normal screen and an explicit alternate-screen observation option if supported/tested; do not claim a TUI's alternate screen is in ordinary scrollback.

Bounds apply at **every stage**, not only final formatting:

- tmux history: 2,000 rows per pane and fixed dimensions (row retention is not an exact tmux-memory byte guarantee).
- Client helper: continuously drain stdout/stderr, retain at most 64 KiB, timeout after 5 seconds and kill only that client on timeout. Truncating output must not kill the underlying job/server. Cap stderr too. No unbounded `exec` buffers.
- Inspection: maximum **16 KiB and 200 lines**, whichever comes first; caller may request less. Safe UTF-8 boundaries, explicit truncation flag, timestamp and whether screen/history/alternate was observed. No full raw output file is promised or silently written.
- Cached final snapshot: max 16 KiB/job. Stream/control characters (including OSC, ESC, C0/C1 except newline/tab), malformed Unicode and excessive line lengths are sanitized before rendering, hashing or matching. Keep terminal output inside an explicitly labelled untrusted-data block; never interpret it as instructions.

Watches are bounded data conditions, not arbitrary shell watcher scripts in the first release:

- `contains` with a nonempty literal string (max 256 characters), `changed` for a hash change after the initial baseline, or `exit` for state transition. Optional user/caller label max 120 characters. No JavaScript regular expressions (avoid event-loop ReDoS).
- Poll interval 5 seconds default, accepted range 1–300 seconds; TTL 5 minutes default, range 1 second–30 minutes; once=true default, explicit repeat mode with at least 10-second cooldown. No overlapping polls: one controller scheduler batches pane state checks and only captures watched panes that need it. Slow polls coalesce instead of queueing up work.
- `contains` samples bounded visible/recent output; a pattern left on screen fires once. For repeat mode require false->true transition plus cooldown. `changed` establishes baseline without immediately firing. Completed watches expire/stop automatically; cancelled/lost jobs finalize watches. A terminal transition is delivered at most once per active controller observation. Suppressed/expired counts are available on inspect, not flooded as messages.
- Delivery is explicit: `ui` (no model context), `nextTurn`, or `wake`. Default `ui`; the model/user opts into `wake` to react asynchronously. `wake` uses `pi.sendMessage(..., { deliverAs: 'followUp', triggerTurn: true })`; never `sendUserMessage` masquerading as human input. No default steering/interruption.
- Payloads include generated job/watch IDs, event kind, timestamp, trusted configured label and status/exit code. **Do not automatically include terminal excerpts or full command strings**: the agent can request inspection if needed. Labels are caller-authored but still sanitize them for terminal rendering.
- Coalesce into at most one model-visible message per 10 seconds/controller, capped at 2 KiB/message, with a bounded 16-event pending queue. Deduplicate per watch and aggregate excess counts. Finite TTL/once defaults prevent self-sustaining wake loops. Persist relevant fired/disarmed states, not every sample or timer tick. All delivery checks session generation and active ownership immediately before sending.
- Periodic polling itself does not invoke the LLM. Timers are unref'ed and cleared on shutdown. Poll failures have bounded backoff; a dead/missing server transitions jobs once, without an endless error loop.

### Pi surface

Suggested tool names: `background_start`, `background_jobs`, `background_inspect`, `background_watch`, `background_unwatch`, `background_stop`, `background_forget`, `background_server_stop`. Keep input schemas small and descriptions honest about snapshot misses, limits, Bash execution, persistence and optional model wake-ups. Return `details` on every path and use a consistent result shape. Start result contains ID/status/socket and a shell-quoted manual attach command, not initial output.

Add `/background` for user-facing list/status and explicit stop-server/help subcommands. UI footer can show `background: 2 running, 1 watch`; no custom interactive TUI is required. In non-UI modes, tools still work and return structured errors; no confirmation dialog may block them. Permissions policy: tools are intentional execution surfaces, advertise correct mutating/destructive annotations, document their names for approval extensions; do not claim built-in Bash permission parity. No project-local config or arbitrary stdin API in MVP.

## Files/components

- `package.json`, lockfile, `tsconfig.json`, `.gitignore`: ESM TS, `pi.extensions: ['./src/index.ts']`, host peer deps, TypeScript/tsx/Node types for development; `check` and `test` scripts. No native module dependency.
- `src/index.ts`: tool/command registration and session lifecycle; no factory side effects.
- `src/tmux.ts`: scoped short-client runner, dependency probe, fixed server config, direct argv launch/capture/state/kill primitives.
- `src/storage.ts`: private directory, validation, atomic registry, conservative controller locking and locator persistence types.
- `src/manager.ts`: serialized job lifecycle, ownership/recovery and bounded data surfaces.
- `src/watch.ts`: pure condition/deadline/dedup/rate-limit logic, scheduler adapter and event shapes.
- `src/output.ts`: UTF-8/byte/line bounds, terminal sanitization and safe quoting for human attach instructions.
- `tests/*.test.ts`: pure units, fake Pi lifecycle/injection and real tmux integration.
- `.github/workflows/ci.yml`: Linux/macOS matrix; README and AGENTS updated to actual behavior at each milestone.

Implementers may combine files where smaller, but keep tmux/process code independent from Pi APIs for testability. Avoid inventing a general backend/plugin framework for one backend.

## Ordered implementation and commits

### Phase 0 — Research/design (this commit)

- [x] Inspect repository, sibling conventions, full Pi extension docs and installed tmux manual.
- [x] Specify architecture, resource/security boundaries, persistence and snapshot limitations.
- [ ] Parent integrates parallel ttyd/Linux/macOS research findings; keep browser adapter out of core unless evidence changes the decision.
- [ ] Resolve license separately with user; do not invent one merely to populate package.json.

Acceptance: this plan committed before code handoff; no implementation claims added to README.

### Phase 1 — Package, pure helpers, real tmux substrate

- [ ] Add package/check/test scaffolding, output sanitation/bounds, tmux client helper and private store.
- [ ] Implement lazy probe and a verified private server with one job, retained exit status, scoped capture, and scoped explicit cleanup.
- [ ] Unit tests: quoting (spaces, quotes, newlines, semicolons, dollar and `#{...}`), bounds, Unicode, OSC/CSI, schema validation and registry limits.
- [ ] Real tmux tests: immediate `exit 7` retained; long-running command start returns before completion; scoped server cannot modify a sentinel server; cwd/script path with spaces and shell metacharacters; startup failure rollback and timeout only kills client.

Validate `npm run check` and focused tests. Commit this tested substrate with plan checkbox updates; do not add README usage for tools not wired yet.

### Phase 2 — Controller lifecycle, recovery and Pi tools

- [ ] Implement all lifecycle operations, retained-job cap, conservative lock, locators and token verification.
- [ ] Wire Pi tools, `/background`, footer and idempotent generation-safe shutdown.
- [ ] Tests: simultaneous starts/stop/start-shutdown; no side effects at factory load; reload detaches without stopping job; reattach same session; new/fork refuses adoption; missing/mismatched socket cannot trigger unrelated kill; invalid registry and symlink defenses; two controllers conflict; crash/restart and manual recovery diagnostics.
- [ ] Explicit stop tests include a command ignoring Ctrl+C; assert pane termination without claiming daemon descendants are reaped.

Validate check + all units/integration + fake-Pi tests; commit an honestly documented background-job/inspection milestone.

### Phase 3 — Watches and asynchronous notifications

- [ ] Add bounded polling, literal/change/exit conditions, TTL/cooldown/once, and explicit ui/nextTurn/wake delivery.
- [ ] Fake clocks test baseline, duplicate unchanged rows, repeated transitions, expiration, finalization, suppressions/queue bounds, no overlapping polls and no calls after generation changes.
- [ ] Fake Pi proves only selected <=2 KiB summaries enter model context; ordinary snapshots/ticks remain local; wake uses followUp+triggerTurn; nextTurn never triggers.
- [ ] Real tmux test watches a delayed `READY` marker and exit; demonstrate (and document) a transient screen update can be missed. Model remains free to execute another mocked tool while job waits.

Validate the entire suite; commit functional monitor milestone and update plan checkboxes.

### Phase 4 — Linux/macOS CI and usable documentation

- [ ] CI matrix `ubuntu-latest` and `macos-latest`: install tmux (`apt-get`/Homebrew respectively), print Node/OS/tmux versions, `npm ci`, check and full tests. Tests create their own sockets and always clean them in `finally`/after hooks, with best-effort signal cleanup. Never kill a runner's default tmux server.
- [ ] Test `/bin/bash`-only command paths, socket path length, BSD/macOS filesystem behavior, dependency missing/old tmux errors, alt-screen behavior and retained exit signals. No `timeout`, `flock`, `/proc`, GNU `readlink -f`, `sed -i`, `ps --...`, or Linux-only assumptions in runtime code.
- [ ] README: Linux/macOS prerequisites/install commands; local/git Pi installation; start/inspect/watch examples; async/context behavior; best-effort snapshot caveat; detach/resume/stop/manual attach recovery; output/resource limits, security and escaped descendants. State actual tested versions.
- [ ] Update AGENTS structure/commands and check `npm pack --dry-run` includes extension sources but excludes `.agents`, tests, private logs and credentials.
- [ ] Push completed commits; inspect GitHub Actions for **both** OS results. If macOS CI cannot be run, say "designed for macOS; unverified" rather than claiming it was tested.

Acceptance: both platform jobs pass; reviewer checks wrong-server risk, command injection, stale messages, growth bounds, persistence and cancellation; fixes receive regression tests and their own commit.

## Optional follow-ups, not prerequisites

1. Reliable `pipe-pane` stream events: attach sink before command starts via explicit launch handshake; bounded rotating storage or continuously drained bounded transport; independent stream matcher; loss/overflow markers; PTY control parsing and reconnect gaps. Do not write unbounded `cat >> log` files.
2. ttyd browser view: explicit user start/stop only; verified private tmux target; loopback bind, read-only tmux attachment **and** ttyd input restrictions, origin/auth policy, no model-disclosed credentials, no automatic browser launch or public exposure. Browser closure must not terminate jobs. Revisit exact flags only after research and real smoke tests on both platforms.
3. Arbitrary observer scripts, stdin, selectable detach-vs-stop policy, durable user-chosen storage, stronger orphan discovery, retention TTL and per-job servers only after concrete demand.

## Assumptions and material risks

- User's "entire tmux servers" means isolated owned servers rather than modifying their existing terminal server.
- Snapshot-based monitoring is an intentionally smaller first step; it does not satisfy applications requiring guaranteed observation of every output line. If that is a hard requirement, move the pipe-pane follow-up ahead of release.
- Default persistence trades convenience for orphan-resource risk. Every start result and shutdown help must disclose survival, and explicit stop must be easy.
- Pi's same-user permissions and tmux socket access are not a security isolation boundary from malicious jobs running as that user. Tokens prevent accidental wrong-target operations, not hostile same-user takeover.
- Credentials inherited by the server/jobs can appear in job output; automatic notifications intentionally omit excerpts. On-demand output is still sensitive untrusted data.
- The tmux >=3.2 floor, multi-argument launch details, fixed-size behavior, alternate-screen capture and system-config behavior require CI validation; fail explicitly or raise the minimum version if unsupported, never silently use an unsafe shell fallback.
