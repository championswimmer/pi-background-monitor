# pi-background-monitor

A planned [Pi coding-agent](https://github.com/badlogic/pi-mono) extension for running long-lived jobs in the background and monitoring their progress without flooding the model's context.

> **Status: research and planning.** There is no extension, installable package, or working command yet.

## Motivation

Long-running tasks such as builds, test suites, and servers can produce large amounts of output and take longer than an agent should wait on a single tool call. The goal is for Pi to start work asynchronously, continue with other tasks, and check on or react to meaningful changes without repeatedly sending the entire output to the model.

## Intended capabilities

These are goals, not implemented features:

- Start and track background jobs without holding the agent's turn open.
- Inspect a bounded, recent output window and job status on demand.
- Observe output periodically and surface selected events or changes rather than the full stream.
- Manage job lifecycle safely, including completion, failure, and cancellation.

## Research and design

We are investigating background execution and monitoring in Claude Code and Codex, and persistent process/terminal approaches such as tmux, PTYs, and ttyd. Backend choice, event delivery, resource limits, security, and behavior across Pi session changes are still open questions. See the [research and initial plan](.agents/plans/000-research.md) for sources, tradeoffs, and open questions.

## Development

This repository is in its initial research stage; setup and test commands will be documented once an implementation exists. See [AGENTS.md](AGENTS.md) for contributor guidance.
