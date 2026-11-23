# pi-background-monitor

[![npm version](https://img.shields.io/npm/v/pi-background-monitor)](https://www.npmjs.com/package/pi-background-monitor)

A [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension for running long-lived commands in the background, inspecting their logs and receiving selective notifications.

## Install

Requires Pi 1.5.0+, Node.js 22+, Bash and tmux 3.2+ on Linux or macOS. Install tmux with your package manager, then:

```sh
pi install npm:pi-background-monitor
```

Reload Pi after installation. A full Pi restart is recommended when upgrading from an older loaded extension. For local source checkouts, run `npm install && npm run build` before `pi install .` (or load directly with `pi -e ./src/index.ts`).

## Use

Ask Pi in plain language, for example:

- **Build:** “Run `npm run build` in the background. Wake up if the output matches `error|failed`, and check the log later.”
- **Repeated check:** “Run my health-check command every 5 seconds for about 5 minutes. Wake up if its output contains `unhealthy`, and keep the output for me to inspect.” Pi can run a timed shell loop for this; a continuously running command such as `tail -f` needs no loop.

Pi can page through retained output and read or search the returned pages (there is no server-side grep), or you can use `/bgmon` to select a job and view its read-only log. Output and notifications are bounded, so older lines can be lost. Watches last only while Pi is running; wake-ups are best effort. For exact loop, filter and paging examples, see the [reference](docs/reference.md#workflow-examples).

Use `/bgmon settings` to adjust shared group limits, or `/bgmon stop-server` to stop your session's private server.

Save the `attach` command and `logRef` returned when starting a job if you may need manual tmux access or historical logs. Jobs normally survive Pi shutdown, but reopening Pi does not automatically reconnect controllers or resume watches. The `logRef` allows read-only historical inspection, not controller recovery.

## Tools

| Tool | Arguments | Use when |
| --- | --- | --- |
| `bgmon_start` | `command`; optional `id` | Start one long-running command: a build, test suite, server or `tail -f`. |
| `bgmon_inspect` | none to list; `id` or `logRef` to read; optional `after` cursor to page forward | See what is running, read a job's output, or page through retained history. |
| `bgmon_watch` | `action` (`add`, `list`, `update`, `remove`); `add` needs `monitorId` and `kind` (`any`, `contains`, `regex`, `exit`); `contains`/`regex` need `pattern`; optional `flags`, `from`, `delivery`, `label`, `ttlSeconds`, `once`; `update`/`remove` need `watchId` | Get called back when output matches or a job stops, instead of polling. |
| `bgmon_control` | `action` (`stop`, `forget`, `server_stop`, `delete_history`); `id` (needed for `stop`/`forget`, optional for `server_stop`); `logRef` for `delete_history` | Stop a job or free its logs. |
| `bgmon_events` | `action` (`list`, `clear`) | Review or clear this session's recorded alert history. |

Most arguments are optional and depend on the chosen action. See the [reference](docs/reference.md#tools) for exact rules and limits.

## Safety

Commands run with your privileges, not in a sandbox, and stopping a job may leave detached descendants running. Logs can contain secrets and persist beyond the conversation; output is untrusted. Logs and notifications are bounded and may have gaps or be delayed.

See the [usage and operational reference](docs/reference.md) for tools, watches, subagents, limits and safety details.
