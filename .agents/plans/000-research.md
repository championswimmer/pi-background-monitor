# Background monitoring: research and initial plan

Status: research and planning only; no extension has been implemented. Sources were inspected on 2026-11-08. Claude documentation is live and may change; Codex, tmux, ttyd, and node-pty links below are pinned revisions. The Pi API observations refer to the installed Pi coding-agent 1.5.0 `docs/extensions.md`; check the target Pi version before implementing.

## What existing tools do

### Claude Code

The documented [Monitor tool](https://code.claude.com/docs/en/tools-reference.md#monitor-tool) runs a watcher script asynchronously. Each emitted line becomes an event, allowing Claude to interject while the conversation continues. Watches default to five minutes and are limited to 30 minutes (10 minutes in single-prompt noninteractive mode); cancellation, session exit, and the originating subagent's termination affect watcher lifetime. Monitor commands follow Bash permission rules.

[Background Bash](https://code.claude.com/docs/en/interactive-mode.md#background-bash-commands) is separate: it returns a task ID immediately, writes output to a file for later retrieval, and permits new prompts while the command runs. The documentation describes exit cleanup and a 5 GB output limit. [Asynchronous hooks](https://code.claude.com/docs/en/hooks.md) provide a different, exit-triggered mechanism: `asyncRewake` can wake Claude on exit code 2 with stderr, or stdout if stderr is empty.

**Design inference:** separate a verbose producer from a selective watcher; send compact watcher events to the agent rather than the entire log. This is a proposed pattern, not a claim about Claude's internal implementation.

### OpenAI Codex

At commit [`748ab55`](https://github.com/openai/codex/tree/748ab55ca7de0b647d9a7a9d9a8e70e00f28666d), terminal tools expose session IDs, TTY mode, yield time, and maximum output-token parameters; an empty `write_stdin` call polls and nonempty input is sent to the session ([definitions](https://github.com/openai/codex/blob/748ab55ca7de0b647d9a7a9d9a8e70e00f28666d/codex-rs/core/src/tools/handlers/unified_exec.rs#L30-L80), [poll handler](https://github.com/openai/codex/blob/748ab55ca7de0b647d9a7a9d9a8e70e00f28666d/codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs#L140-L155)). Its process handling uses bounded pending and head/tail transcript buffers, deadlines and response token limits, and per-event streaming limits ([buffers](https://github.com/openai/codex/blob/748ab55ca7de0b647d9a7a9d9a8e70e00f28666d/codex-rs/core/src/unified_exec/process.rs#L44-L62), [collection](https://github.com/openai/codex/blob/748ab55ca7de0b647d9a7a9d9a8e70e00f28666d/codex-rs/core/src/unified_exec/process_manager.rs#L1047-L1060), [streaming](https://github.com/openai/codex/blob/748ab55ca7de0b647d9a7a9d9a8e70e00f28666d/codex-rs/core/src/unified_exec/async_watcher.rs#L37-L42)). [Session state](https://github.com/openai/codex/blob/748ab55ca7de0b647d9a7a9d9a8e70e00f28666d/codex-rs/core/src/context/world_state/command_sessions.rs#L124-L140) distinguishes running jobs from exited jobs whose results remain to be collected.

These sources support bounded polling and internal streaming; they do **not** establish that arbitrary output patterns autonomously wake the model like Claude Monitor. Stable job IDs, bounded incremental reads and retained exit status are useful design implications.

## Process and terminal options

- **Node child process, proposed first backend:** `spawn` can return control promptly while the extension continuously drains stdout and stderr into bounded buffers. Appropriate for non-interactive jobs; not a rendered terminal screen or a persistence solution after Pi exits.
- **tmux, optional future backend:** detached terminal sessions can support PTY-dependent programs and survival beyond Pi. Its manual documents [`capture-pane -p`](https://github.com/tmux/tmux/blob/a73616d781f2af13085691c741cfb0780d365328/tmux.1#L2911-L2923), [`pipe-pane`](https://github.com/tmux/tmux/blob/a73616d781f2af13085691c741cfb0780d365328/tmux.1#L3903-L3938), and [`remain-on-exit`](https://github.com/tmux/tmux/blob/a73616d781f2af13085691c741cfb0780d365328/tmux.1#L6550-L6567). Session naming, ownership, reattachment and cleanup require explicit policy.
- **node-pty:** [PTY reads/writes and Windows ConPTY](https://github.com/microsoft/node-pty/blob/35c28c7d68a192699e70b1e6a142908bdccd9212/README.md), but native build dependencies and terminal emulation are needed for rendered screen snapshots.
- **ttyd:** a [web terminal](https://github.com/tsl0922/ttyd/blob/2922cb89f518bae4d0fcf4d757a7419638fc71fc/README.md), read-only by default unless writable mode is enabled, with authentication and TLS options. It is an optional browser-view layer, not a necessary local process manager; network exposure adds risk.

A periodic screen snapshot can miss transient lines and repeatedly see unchanged rows. Match output as a stream where feasible; use bounded snapshots for on-demand inspection, and deduplicate and rate-limit resulting notifications.

## Pi integration and proposed direction

Installed Pi 1.5.0 `docs/extensions.md`, “Long-lived resources and shutdown,” requires lazy resource startup and idempotent `session_shutdown` cleanup; shutdown also occurs on reload and session replacement. Its `pi.sendMessage()` documentation says custom messages enter LLM context; `steer`, `followUp`, and `nextTurn` control delivery, and `triggerTurn: true` can start an idle agent for the first two modes. UI-only status should not use model-visible messages unnecessarily. Its `pi.exec()` waits for a command result, buffers up to 256 MiB by default, and terminates the process when that limit is exceeded; awaiting it for a long job would hold the tool call open.

**Proposed MVP, not implemented:**

1. Start a non-interactive child process on demand and promptly return a stable job ID; continuously drain its output independently of model turns.
2. Maintain explicitly bounded retained output and a bounded on-demand status/tail response, with clear truncation indication and exit status. Do not pass routine output to the model.
3. Match configured conditions against the output stream or run a bounded watcher; emit only concise, rate-limited, deduplicated events. Decide whether each event may interrupt, wait, or start an idle turn; use `pi.sendMessage()` only for events intended for model context.
4. Provide cancellation and session-scoped cleanup by default, including a defined process-tree termination policy. Persistent terminal jobs, reattachment, and stdin are later design decisions, not assumed MVP behavior.

## Safety and unresolved questions

Output is untrusted and may contain prompt injection, terminal control sequences, and secrets. Define sanitization and explicit trust boundaries; never treat output as instructions. Avoid automatic secret disclosure in event summaries, bound bytes and event rates, and make shell execution and autonomous notifications explicit. Decide how to prevent runaway watchers and manage permissions, runtime limits, and storage retention.

Open decisions include pattern matching versus arbitrary watcher scripts; watcher isolation and permissions; maximum buffer, event size and frequency; log retention and truncation; stdout/stderr ordering and partial lines; process groups and platform support; event delivery and user consent; session ownership across reload, resume, crash or Pi exit; whether and how to support stdin, PTYs and durable reattachment; and how to handle repeated events and missed output.

## Work plan

- [x] Inspect sibling extension conventions and bootstrap documentation.
- [x] Research Claude, Codex, persistent terminals and Pi extension integration.
- [ ] Resolve the MVP's lifecycle, permissions, notification and resource-limit decisions.
- [ ] Design and implement the smallest nonblocking backend and selective watcher.
- [ ] Add focused tests for background return, stream draining, bounds, matching, notification delivery, process exit/cancellation and session cleanup; test platform-specific behavior separately.
- [ ] Document actual installation and usage only after implementation exists.
