# pi-background-monitor

[![npm version](https://img.shields.io/npm/v/pi-background-monitor)](https://www.npmjs.com/package/pi-background-monitor)
[![npm downloads](https://img.shields.io/npm/dm/pi-background-monitor)](https://www.npmjs.com/package/pi-background-monitor)

A [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension for long-lived shell commands and selective snapshot watches, without continuously filling the conversation with logs.

## Install

Requires Pi 1.5.0 or later, Node.js 22+, Bash, and tmux 3.2+ on Linux or macOS. Install tmux with your package manager, then run:

```sh
pi install npm:pi-background-monitor
```

Reload Pi after installation. Alternatively, install from Git with `pi install git:github.com/championswimmer/pi-background-monitor`, or from a local checkout with `pi install ./pi-background-monitor` from its parent directory.

## Use

Ask Pi to start, inspect, stop, or watch a background task. `/bgmon` or `/bgmon list` opens the monitors tab; `/bgmon settings` opens session limits. Press Tab to switch between tabs. In the monitors list, select a monitor and press Enter for a read-only output view; Esc returns to the list. The view refreshes every two seconds after each inspection, with arrow keys to scroll and End to follow the latest output. `/bgmon stop-server` stops all jobs in your session's server. `bgmon_control` can instead stop **all jobs in a monitor's owning server**.

Every job has a monitor identity. Extension instances in the same JavaScript process share an in-memory index: any can list, inspect, or stop an indexed monitor, and multiple sessions can independently watch it. Each session manages only its own watches. To receive notifications in a child session, that session must load the extension locally; an inherited tool bridge executes in its host session and its watches notify the host instead. Separate processes and worker threads do not share this index. On last session shutdown the index is dropped and jobs detach; only the original Pi session can recover its jobs from its saved locator. New or forked sessions cannot recover them from disk.

Jobs run in an owned private tmux server, not your default server, and continue after Pi exits. Stop them explicitly; detached child processes may survive. Save the returned attach command for manual recovery. Commands run with your privileges, not in a sandbox; permissions for Pi's built-in Bash tool may not cover `bgmon_start`. Inspected output is untrusted and may contain secrets. The output view uses the same bounded snapshot as `bgmon_inspect`, sampled independently; it does not send output to the model. The display wraps text, expands tabs and omits trailing blank rows. It can miss transient or overwritten text and is not an interactive terminal.

Watches are best-effort snapshots: transient or overwritten output may be missed. They expire, do not survive reload and cannot observe while Pi is closed. By default notifications are UI-only and not shown in noninteractive sessions; `nextTurn` delivers on the next turn, while `wake` may start a model turn. Automatic notifications include metadata, not output. A watch's interval and TTL can be updated.

### Tools

Agents have four focused tools:

- `bgmon_start`: `command` (required Bash script) starts a job. Optional `id` selects a unique monitor ID (1–64 ASCII letters, digits, `_` or `-`); otherwise one is generated. IDs within a server must also differ ignoring case; 24-character lowercase hex IDs are reserved for generated IDs.
- `bgmon_inspect`: optional monitor `id`; omit it to list monitors, or provide it for a bounded, untrusted output snapshot.
- `bgmon_control`: `action` is `stop`, `forget`, or `server_stop`. `id` is required except for `server_stop`, which stops the selected monitor's entire server or, without an ID, your session's server. `stop` interrupts a job; `forget` removes a stopped job.
- `bgmon_watch`: `action` is `add`, `list`, `update`, or `remove`. `add` requires `monitorId` and `kind` (`contains`, `changed`, or `exit`); `contains` also requires `pattern` (literal text, 1–256 characters). It returns a watch ID. `list` lists this session's watches; `update` and `remove` require `watchId`. Updates cannot change `monitorId`, `kind`, or `pattern`.

Watch add/update options: `label` (≤120 characters), `delivery` (`ui` default, `nextTurn`, or `wake`), `intervalSeconds` (1–300, default 5), `ttlSeconds` (1–1800, default 300; updates renew from now), and `once` (default true). Repeated watches need a state transition and a 10-second cooldown; exit watches always remove themselves.

The settings limit running jobs and total retained jobs owned by the session independently (defaults: 8 running and 16 retained; each can be set from 1 to 64 by typing a number and pressing Enter). Lowering a limit does not stop or remove existing jobs. Retained jobs include finished, cancelled, and lost jobs; forget them to free space. Settings persist with the original session. The dashboard shows this session’s watch intervals and expiry times; watches are not job timeouts. Command previews are retained in the private registry and may contain secrets; old monitors may not have previews.

Hard limits: 64 retained jobs per owner, 64 indexed monitors and 128 owners per process, 8 watches per session and 64 watches total. Inspection output is bounded.

Recovery may fail after reboot, `/tmp` cleanup or socket loss; locks are never silently broken, and orphan cleanup is not automatic. `/tree` does not rewind processes. This is an early MVP, tested locally on Linux; macOS is covered by CI but has not been tested locally.
