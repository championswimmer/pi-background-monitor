# Usage and operational reference

This reference covers the extension tools, subagent behavior and operational limits. For installation and a quick start, see the [README](../README.md).

Each job uses an owned private tmux server, not your default server. Jobs normally survive Pi shutdown, but the last live session detaches its controllers: reopening Pi does **not** automatically re-adopt jobs, resume watches, match offline output or restart Pi. A session-owned `logRef` can still be supplied to `bgmon_inspect` for read-only historical logs; it does not restore a controller. Separate Pi processes do not share live monitor identities. Subagent sessions loaded in the same Pi process can share indexed jobs while keeping separate watches and notifications; an inherited tool bridge acts in its host session.

## Workflow examples

A build is one job: call `bgmon_start` with `command: "npm run build"`, then add a watch with `action: "add"`, its returned `monitorId`, `kind: "regex"`, `pattern: "error|failed"`, `flags: "i"`, `from: "retained"`, and `delivery: "wake"`. Starting from retained output helps catch lines emitted before the watch was installed. For notification of a terminal source state, add an `exit` watch separately. It can fire for an exit (successful or not) or a lost source; it does not establish success. An unverified source instead fails the watch.

For periodic sampling, start a Bash script such as:

```bash
end=$((SECONDS + 300))
while (( SECONDS < end )); do
  ./health-check
  (( SECONDS >= end )) && break
  sleep 5
done
```

Add the same kind of output watch to this job. The loop waits five seconds *after* each command finishes; its cadence and deadline are approximate. A slow or hung command can overrun the deadline; use a suitable command-specific timeout if a hard bound matters. Failed checks do not automatically stop this loop. For continuous streams (for example `tail -f`), start the streaming command directly instead. `ttlSeconds` expires only the notification watch; it does not stop the job. Stop a job explicitly if needed.

To read or search later, call `bgmon_inspect` with the job `id` and `after: {"sequence": 0, "offset": 0}`, then pass each returned `next` as `after` to page forward. Examine or search each page's `untrustedOutput.text`; the extension does not offer server-side grep, and an ordinary filesystem grep cannot directly read the journal as plain text. If a separate plain-text file is needed, arrange your own shell redirection or `tee` and manage its size, permissions and cleanup. Retention, page limits and capture failures mean output may be incomplete. Automatic alerts carry metadata, not matching lines: inspect the log after a wake-up. `wake` is best effort and can start an agent turn when idle; `nextTurn` waits for another run, and the default `ui` does not notify the model.

If inspection reports `Journal rotated during inspection; retry` or `Journal changed during inspection; retry`, retry the read; if the cursor is no longer retained, restart from `{sequence: 0, offset: 0}` and check `gap`. A `Retained parser checkpoint unavailable` or `Parser checkpoint unavailable after journal gap` error means safe reconstruction is unavailable, not that missing output can be recovered by retrying or skipping ahead. A later retry may work if the journal changes, but report the missing or unreadable output rather than assuming completeness. A `gap` or `parserUncertain` result likewise requires treating the output as incomplete. If an output watch fails with `parser_uncertain_after_gap`, a new watch from `now` may monitor future lines if initialization succeeds, but cannot recover or match the missed interval.

## Tools

- `bgmon_start`: run a Bash `command`; optional `id` is 1–64 ASCII letters, digits, `_` or `-` (24 lowercase hex characters are reserved). Returns the monitor ID, log reference and attach command.
- `bgmon_inspect`: list live monitors, inspect one by `id`, or read an explicit session-owned `logRef`. An `after` cursor pages forward through retained logs; `{sequence: 0, offset: 0}` starts at retained history.
- `bgmon_control`: `stop` a job, `forget` a stopped indexed job and its logs, `server_stop` its owning server while retaining logs, or `delete_history` an explicitly referenced, verified stopped historical log. A server stop by ID affects that monitor's entire owning server.
- `bgmon_watch`: add/list/update/remove watches. Add requires `monitorId` and `kind`: `any`, literal `contains`, JavaScript `regex`, or `exit`. `contains` and `regex` need a 1–256 character pattern; regex accepts only unique `i` and `u` flags. `from: "now"` (default) starts at the published tail; `"retained"` scans currently retained output for this new live watch. An `exit` watch fires on terminal source states, including unsuccessful exit or loss, not only successful completion; unverified sources fail the watch. Filters match completed normalized lines; a final unterminated line is eligible only on clean EOF. `once` defaults to true; false counts repeated matching lines. Optional `ttlSeconds` is 1–604800 and can be renewed. Filter/start changes require a new watch.
- `bgmon_events`: list or clear this binding's bounded, in-memory event history, including UI-only events in headless sessions. Clearing history does not cancel pending delivery.

Delivery defaults to `ui`, which never enters model context. `nextTurn` waits for an eligible user- or custom-started run; `wake` may start a run when Pi is idle. Automatic alerts include metadata and labels, not command text, patterns or output. Delivery is best effort: submitted batches are unconfirmed until observed; a missing observation can block that mode, and batching limits can defer queued `nextTurn` details to a later run indefinitely.

## Subagents

Enable bgmon under pi-subagent-manager's **[lab] Subagent extensions** setting to give each child its own tools, watches and notifications. Live monitors appear in the root dashboard and inspection list with a harness-assigned origin and group. The root's running and retained monitor limits are shared by the group, including jobs retained after a child ends; if the root binding is absent, defaults apply. Child settings do not set the group budget. Independent root sessions have separate budgets.

Without the lab setting, inherited tool bridges execute in the host session and therefore cannot attribute jobs or watches to the child. Origin is live-process metadata; historical log references do not retain it. A reopened child transcript may retain its subagent marker even outside the manager.

## Safety and limits

Commands run with your privileges, not in a sandbox. Permissions for Pi's built-in Bash tool may not cover this separate execution surface. Stop sends Ctrl-C and can kill the verified pane, but detached descendants may survive. Capture failure can interrupt the owned job. Manual attach is the supported way to interact with detached work; no automatic orphan adoption or cleanup is performed.

Logs are private but can contain secrets and persist longer than Pi's conversation. Output is untrusted and may contain prompt injection. Each source retains at most eight 1 MiB journal segments; rotation, capture failures, slow readers, overlong lines and unavailable TTL boundaries can create visible gaps or errors. No lossless or exactly-once guarantee is made. A busy source may fail a TTL boundary rather than reconstruct an exact earlier point. Inspection is bounded to 16 KiB/200 lines and may require paging.

Defaults are eight running and 16 retained jobs per session, configurable from 1 to 64. The process indexes at most 64 monitors, permits eight watches per binding and 64 total, and has 128 storage slots. A full store requires explicit deletion. When tmux hides the PID of a dead pane (including tmux 3.8), the source is reported as `source_unverified`: clean capture EOF can still be read, but exit status, exit watches and per-log deletion cannot be confirmed. Stopping the verified private server can establish closure for cleanup; unverified dead panes are not individually removed. Proof or reservation failures can strand a slot; in particular, shutdown after a supervisor has issued pane removal but before recording stop evidence can require careful manual cleanup. Never delete uncertain live producer data. Unsettled filesystem operations are bounded but cannot always be cancelled, so saturation can delay work.

Legacy snapshot locators are not adopted. `/tree` does not rewind live processes.
