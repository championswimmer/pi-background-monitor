# pi-background-monitor

[![npm version](https://img.shields.io/npm/v/pi-background-monitor)](https://www.npmjs.com/package/pi-background-monitor)

A [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension for running long-lived commands in the background, inspecting their logs and receiving selective notifications.

## Install

Requires Pi 1.5.0+, Node.js 22+, Bash and tmux 3.2+ on Linux or macOS. Install tmux with your package manager, then:

```sh
pi install npm:pi-background-monitor
```

Reload Pi after installation. A full Pi restart is recommended when upgrading from an older loaded extension. Local and Git installs also work with `pi install`.

## Use

Ask Pi to start, inspect, stop or watch a background command. Run `/bgmon` to open the dashboard, select a job and press Enter to view its read-only log. Use `/bgmon settings` to adjust shared group limits, or `/bgmon stop-server` to stop your session's private server.

Save the `attach` command and `logRef` returned when starting a job if you may need manual tmux access or historical logs. Jobs normally survive Pi shutdown, but reopening Pi does not automatically reconnect controllers or resume watches. The `logRef` allows read-only historical inspection, not controller recovery.

## Safety

Commands run with your privileges, not in a sandbox, and stopping a job may leave detached descendants running. Logs can contain secrets and persist beyond the conversation; output is untrusted. Logs and notifications are bounded and may have gaps or be delayed.

See the [usage and operational reference](docs/reference.md) for tools, watches, subagents, limits and safety details.
