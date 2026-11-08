# pi-background-monitor

A Pi extension for running long-lived Bash jobs in an isolated tmux server and observing selected progress without continually sending output into the model context.

**Status: early MVP.** Tested locally on Linux; macOS is supported by design and covered by the CI matrix, but has not been run locally. Jobs run in a dedicated tmux server per Pi session, not your default server. Starting a job returns immediately. Jobs survive Pi exit or reload until explicitly stopped (or the machine/tmux server goes away).

## Requirements and installation

- Linux or macOS; Node.js 22 or later; `/bin/bash`; tmux **3.2 or later** on `PATH`.
- Pi coding agent 1.5.0 or later.
- Linux example: install tmux from your distribution, e.g. `sudo apt install tmux` (check `tmux -V`). macOS: `brew install tmux`.

Install the package using Pi:

```sh
pi install git:github.com/championswimmer/pi-background-monitor
# or from a local checkout:
pi install ./pi-background-monitor
```

Reload Pi after installation. The extension does not start a server until the first job is started.

## Usage

Ask Pi to start a long-running task in the background, inspect its output, or watch for a condition. The extension exposes the following tools to the agent:

- `background_start` (`command`): run a Bash script in the current working directory; returns a job ID, private socket path, and a manual tmux attach command. Commands deliberately execute arbitrary shell code.
- `background_jobs`: list retained jobs and states.
- `background_inspect` (`id`): get a bounded, untrusted recent terminal snapshot and state.
- `background_watch` (`id`, `kind`): monitor a literal `contains` pattern, `changed` snapshot, or job `exit`. For example, request a `contains` watch for `READY`. Optional `intervalSeconds` (1–300, default 5), `ttlSeconds` (1–1800, default 300), `label`, and `once` (default true). Delivery defaults to `ui`; choose `nextTurn` to include a compact event in the next conversation turn or explicitly choose `wake` to start a follow-up turn when idle.
- `background_unwatch` (`id`): remove a watch ID.
- `background_stop` (`id`): send Ctrl-C, then close the pane after two seconds if still running.
- `background_forget` (`id`): remove a finished job. At most eight jobs and eight watches are retained.
- `background_server_stop`: explicitly stop all jobs in this session's dedicated server and remove its private metadata. `/background` displays status; `/background stop-server` stops it.

A watch sends **metadata only**, not job output or the command, in automatic notifications. A `wake` notification intentionally enters model context and can start an agent turn; ordinary polls do neither. Watches are best effort, expire, and do **not** survive Pi reload; no events are observed while Pi is closed. Recreate watches after reopening. Repeat watches require a transition and have a ten-second cooldown. Noninteractive sessions do not display UI-only notifications; choose a model-visible delivery explicitly if needed.

### Important snapshot limitation

This is a terminal **snapshot** monitor, not a complete output stream. Short-lived text can be overwritten or scroll out before the next poll; unchanged rows can recur, and alternate-screen terminal applications may behave differently. If guaranteed detection of every output line is required, this MVP is not sufficient. On-demand inspection retains at most 200 lines/16 KiB; tmux history is limited to 2,000 rows. Output is sanitized and remains untrusted data, not instructions. Inspecting output can still disclose secrets to the model.

## Lifecycle, recovery, and safety

The server socket and registry live in a private `/tmp/pbm-*` directory. Same-session reload/resume can reconnect on the same machine; a new or forked session does not adopt it. `/tree` does not rewind external processes. Pi shutdown detaches rather than stopping jobs; `/tmp` cleanup, reboot, or lost sockets can lose access. Save the attach command returned by `background_start` for manual recovery. The registry uses a conservative exclusive lock: if a crash leaves `lock` behind, first verify that no other Pi process is controlling this session, then remove that **specific** lock directory manually and resume. There is no automatic orphan cleanup.

Stopping a pane does not guarantee termination of daemonized or independently detached descendants. tmux is not a sandbox; jobs inherit the invoking user's privileges and environment. Custom background tools are separate execution/permission surfaces and may not be covered by policies that only intercept Pi's built-in Bash tool. Review commands before allowing them. The private socket and ownership token reduce accidental cross-server operations, not attacks by malicious processes running as the same user.

No web server is started. [ttyd](https://github.com/tsl0922/ttyd/blob/2922cb89f518bae4d0fcf4d757a7419638fc71fc/README.md) is a Linux/macOS browser terminal gateway, not needed to manage or observe tmux jobs. A future explicit read-only browser viewer could be useful, but would still expose terminal content and require careful binding, authentication, origin, and TLS controls; loopback alone is not authentication.

## Development

```sh
npm ci
npm run check
npm run lint
npm test
npm pack --dry-run
```

Integration tests use dedicated sockets and must never kill the user's default tmux server. CI specifies Linux and macOS. Research and the original implementation plan are in `.agents/plans/`; see [AGENTS.md](AGENTS.md). The plan is aspirational where it exceeds the actual behavior documented above. No open-source license has yet been selected.
