# pi-background-monitor

A [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension for long-lived shell commands and selective snapshot watches, without continuously filling the conversation with logs.

## Install

Requires Pi 1.5.0 or later, Node.js 22+, Bash, and tmux 3.2+ on Linux or macOS. Install tmux with your package manager, then run:

```sh
pi install git:github.com/championswimmer/pi-background-monitor
```

Reload Pi after installation. For a local checkout use `pi install ./pi-background-monitor` from its parent directory.

## Use

Ask Pi to start, inspect, stop, or watch a background task. `background_start` executes a shell command; `background` manages monitors and watches with an action argument. `/background` shows monitors; `/background stop-server` stops all jobs in your session's server. The `server_stop` action with a monitor ID instead stops **all jobs in that monitor's owning server**.

Every job has a monitor identity. Extension instances in the same JavaScript process share an in-memory index: any can list, inspect, or stop an indexed monitor, and multiple sessions can independently watch it. Each session manages only its own watches. To receive notifications in a child session, that session must load the extension locally; an inherited tool bridge executes in its host session and its watches notify the host instead. Separate processes and worker threads do not share this index. On last session shutdown the index is dropped and jobs detach; only the original Pi session can recover its jobs from its saved locator. New or forked sessions cannot recover them from disk.

Jobs run in an owned private tmux server, not your default server, and continue after Pi exits. Stop them explicitly; detached child processes may survive. Save the returned attach command for manual recovery. Commands run with your privileges, not in a sandbox; permissions for Pi's built-in Bash tool may not cover `background_start`. Inspected output is untrusted and may contain secrets.

Watches are best-effort snapshots: transient or overwritten output may be missed. They expire, do not survive reload and cannot observe while Pi is closed. By default notifications are UI-only and not shown in noninteractive sessions; `nextTurn` delivers on the next turn, while `wake` may start a model turn. Automatic notifications include metadata, not output. A watch's interval and TTL can be updated. Limits are eight jobs per owner, 64 indexed monitors per process, eight watches per session and 64 watches total; inspection is bounded.

Recovery may fail after reboot, `/tmp` cleanup or socket loss; locks are never silently broken, and orphan cleanup is not automatic. `/tree` does not rewind processes. This is an early MVP, tested locally on Linux; macOS is covered by CI but has not been tested locally.
