# pi-background-monitor

A [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that runs long-lived shell commands in the background and lets Pi check their output or watch for changes without continuously filling the conversation with logs.

## Install

Requires Pi 1.5.0 or later, Node.js 22+, Bash, and tmux 3.2+ on Linux or macOS. Install tmux with your package manager (for example, `sudo apt install tmux` on Debian/Ubuntu or `brew install tmux` on macOS), then run:

```sh
pi install git:github.com/championswimmer/pi-background-monitor
```

Reload Pi after installation. To install from a local checkout instead, run `pi install ./pi-background-monitor` from its parent directory.

## Use

Ask Pi to start a background task, inspect it, or watch for text, a change, or an exit. Use `/background` to see status and `/background stop-server` to stop the session's background server.

Jobs run in a dedicated tmux server, not your default one, and continue after Pi exits. Stop jobs explicitly when finished; detached child processes may survive even then. Save the attach command returned when starting a job for manual recovery. Jobs run with your normal privileges, not in a sandbox; permissions configured only for Pi’s built-in Bash tool may not cover these background tools.

Watches use periodic terminal snapshots, so short-lived or overwritten output can be missed. They expire and do not survive a Pi reload. Output you ask Pi to inspect may contain secrets. By default, watch notifications appear in the UI; ask for a model-visible notification if Pi needs to respond automatically.

This is an early MVP, tested locally on Linux. macOS is covered by CI but has not been tested locally.
