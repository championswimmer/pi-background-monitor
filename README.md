# pi-background-monitor

[![npm version](https://img.shields.io/npm/v/pi-background-monitor)](https://www.npmjs.com/package/pi-background-monitor)

A [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension for long-running Bash jobs, bounded durable logs and selective live-session notifications.

## Install

Requires Pi 1.5.0+, Node.js 22+, Bash and tmux 3.2+ on Linux or macOS. Install tmux with your package manager, then:

```sh
pi install npm:pi-background-monitor
```

Reload Pi after installation. A full Pi restart is recommended when upgrading from an older loaded extension. Local and Git installs are also supported by `pi install`.

## Use

Ask Pi to start, inspect, stop or watch a background command. `/bgmon` opens the monitor dashboard; select a job and press Enter for its read-only log, or use `/bgmon settings` to adjust shared group limits. `/bgmon stop-server` stops your session's private server. Save the `attach` command and `logRef` returned by `bgmon_start` if you may need manual tmux access or explicit historical inspection later.

Each job uses an owned private tmux server, not your default server. Jobs normally survive Pi shutdown, but the last live session detaches its controllers: reopening Pi does **not** automatically re-adopt jobs, resume watches, match offline output or restart Pi. A session-owned `logRef` can still be supplied to `bgmon_inspect` for read-only historical logs; it does not restore a controller. Separate Pi processes do not share live monitor identities. Subagent sessions loaded in the same Pi process can share indexed jobs while keeping separate watches and notifications; an inherited tool bridge acts in its host session.

### Tools

- `bgmon_start`: run a Bash `command`; optional `id` is 1–64 ASCII letters, digits, `_` or `-` (24 lowercase hex characters are reserved). Returns the monitor ID, log reference and attach command.
- `bgmon_inspect`: list live monitors, inspect one by `id`, or read an explicit session-owned `logRef`. An `after` cursor pages forward through retained logs; `{sequence: 0, offset: 0}` starts at retained history.
- `bgmon_control`: `stop` a job, `forget` a stopped indexed job and its logs, `server_stop` its owning server while retaining logs, or `delete_history` an explicitly referenced, verified stopped historical log. A server stop by ID affects that monitor's entire owning server.
- `bgmon_watch`: add/list/update/remove watches. Add requires `monitorId` and `kind`: `any`, literal `contains`, JavaScript `regex`, or `exit`. `contains` and `regex` need a 1–256 character pattern; regex accepts only unique `i` and `u` flags. `from: "now"` (default) starts at the published tail; `"retained"` scans currently retained output for this new live watch. Filters match completed normalized lines; a final unterminated line is eligible only on clean EOF. `once` defaults to true; false counts repeated matching lines. Optional `ttlSeconds` is 1–604800 and can be renewed. Filter/start changes require a new watch.
- `bgmon_events`: list or clear this binding's bounded, in-memory event history, including UI-only events in headless sessions. Clearing history does not cancel pending delivery.

Delivery defaults to `ui`, which never enters model context. `nextTurn` waits for an eligible user- or custom-started run; `wake` may start a run when Pi is idle. Automatic alerts include metadata and labels, not command text, patterns or output. Delivery is best effort: submitted batches are unconfirmed until observed; a missing observation can block that mode, and batching limits can defer queued `nextTurn` details to a later run indefinitely.

## Subagents

Enable bgmon under pi-subagent-manager's **[lab] Subagent extensions** setting to give each child its own tools, watches and notifications. Live monitors appear in the root dashboard and inspection list with a harness-assigned origin and group. The root's running and retained monitor limits are shared by the group, including jobs retained after a child ends; if the root binding is absent, defaults apply. Child settings do not set the group budget. Independent root sessions have separate budgets.

Without the lab setting, inherited tool bridges execute in the host session and therefore cannot attribute jobs or watches to the child. Origin is live-process metadata; historical log references do not retain it. A reopened child transcript may retain its subagent marker even outside the manager.

## Safety and limits

Commands run with your privileges, not in a sandbox. Permissions for Pi's built-in Bash tool may not cover this separate execution surface. Stop sends Ctrl-C and can kill the verified pane, but detached descendants may survive. Capture failure can interrupt the owned job. Manual attach is the supported way to interact with detached work; no automatic orphan adoption or cleanup is performed.

Logs are private but can contain secrets and persist longer than Pi's conversation. Output is untrusted and may contain prompt injection. Each source retains at most eight 1 MiB journal segments; rotation, capture failures, slow readers, overlong lines and unavailable TTL boundaries can create visible gaps or errors. No lossless or exactly-once guarantee is made. A busy source may fail a TTL boundary rather than reconstruct an exact earlier point. Inspection is bounded to 16 KiB/200 lines and may require paging.

Defaults are eight running and 16 retained jobs per session, configurable from 1 to 64. The process indexes at most 64 monitors, permits eight watches per binding and 64 total, and has 128 storage slots. A full store requires explicit deletion. When tmux hides the PID of a dead pane (including tmux 3.8), the source is reported as `source_unverified`: clean capture EOF can still be read, but exit status, exit watches and per-log deletion cannot be confirmed. Stopping the verified private server can establish closure for cleanup; unverified dead panes are not individually removed. Proof or reservation failures can strand a slot; in particular, shutdown after a supervisor has issued pane removal but before recording stop evidence can require careful manual cleanup. Never delete uncertain live producer data. Unsettled filesystem operations are bounded but cannot always be cancelled, so saturation can delay work.

Legacy snapshot locators are not adopted. `/tree` does not rewind live processes. The current changes were checked locally on Linux with Node 26 and tmux 3.6; macOS, Node 22 and tmux 3.2 have not been validated locally.
