# 013 — Durable logs and live-session filtered triggers

Status: **implementation in progress**. Revised 2026-11-11 against checkout `2a63820d` / package 0.1.0. The user permits wholesale replacement of snapshot monitoring, with **no backward-compatibility requirement**.

## Outcome, scope and recommendation

Keep privately owned tmux jobs and manual attachment. Replace terminal-snapshot observation with **one bounded, persistent output journal per job**, installed before the user command starts. Inspection, UI and filters all read this journal; delete the production `capture-pane` observation path.

**Monitoring exists only within one continuously running Pi process.** Main and subagent sessions in that process can own jobs and independently subscribe to known jobs. Watch definitions, read cursors, per-watch parser state, hit summaries and delivery queues are **in memory only**. The journal stores bounded *source* parser checkpoints at published segment boundaries so fresh watches can initialize safely after rotation; those checkpoints contain no subscription or notification state. When a session binding ends, its watches and pending notifications end. Nothing reconstructs or automatically restarts them on reload, session resumption or process restart.

**Durable means retained log data**, not durable monitors or delivery. Historical logs may be inspected later through validated log references, even without a live tmux socket. That does not re-register an old monitor, restore its watches, evaluate offline matches, replay pending alerts, wake/restart Pi, or recover a controller. Existing detached tmux behavior need not be removed; capture may continue with the job, but its behavior while Pi is absent is not a monitoring guarantee or an acceptance requirement.

A trigger is `ui`, `nextTurn`, or `wake` delivery to an already-live subscriber. `wake` may start a model turn in that running session; it does not launch or resume a Pi process. No configured shell command or arbitrary JavaScript executes on a match.

### Decisions and rejected alternatives

| Option | Cost, risk, operability and reversibility | Decision |
| --- | --- | --- |
| Save successive `capture-pane` snapshots | Cheap, but transient/overwritten/scrolled output still disappears; duplicate inference remains ambiguous | Reject: does not meet filtered-log requirements |
| Replace tmux with Node pipe-based jobs | Simpler direct capture, but changes TTY semantics, cancellation and manual attach | Reject for this iteration: retain the current execution model |
| Gated `pipe-pane` sink + journal + in-memory Pi matcher | One sink/startup handshake per job; preserves tmux, isolates capture writes, and keeps matching/session lifecycle simple | **Choose** |
| Persist watch/parser/cursor/outbox state; replay after Pi restart | Adds subscription identity, checkpoint transactions, recovery races and delivery reconciliation | **Drop: explicitly outside scope** |
| Always-on filter daemon, offline trigger recorder, Pi restart service | Adds service/control protocol and another lifecycle owner | **Drop: explicitly outside scope** |
| SQLite/native PTY/general backend framework | New dependencies/platform surface without a current requirement | Reject initially; use bounded files |

No adapters, old-registry migration, snapshot fallback, dual-write or compatibility schemas. Stop old-version jobs explicitly before upgrading; unsupported locators must fail clearly, not be adopted or deleted. Preserve the existing private-server security boundary, not the old observation/recovery implementation.

## Inspected boundaries and evidence

- `src/tmux.ts`: private socket/token, direct Bash argv, retained exit panes, `capture-pane -S -200`; current launch occurs before the pane ID is returned. Attaching a sink afterward without a gate races early output.
- `src/manager.ts`: serialized commands, `/tmp` registry, controller lock and same-session recovery. Refactor persistent metadata down to job/log facts and validated historical references; do not extend recovery to watchers or new live controllers.
- `src/broker.ts`: process-wide job index, per-binding watches, shared scheduler and cleanup. Retain this ownership shape; replace snapshot predicates and per-watch sampling.
- `src/index.ts`: Pi lifecycle and notification routing; `src/ui.ts`: read-only snapshot viewer; `src/regex.ts`: isolated timed JS-regex worker; `src/output.ts`: output bounding/sanitization. Reuse isolation and display bounds, not snapshot semantics.
- Existing manager, tmux, extension, regex and UI tests: retain ownership, sharing, cleanup and stale-session safety coverage; replace snapshot/recovery expectations where this plan deliberately changes the contract.
- `AGENTS.md`, `.agents/skills/planning/SKILL.md`, `.agents/plans/001-tmux-mvp.md`: private tmux ownership, bounded resources, Linux/macOS and no native dependencies remain relevant. Implementation must update guidance that describes replaced behavior.
- Installed Pi **1.5.0** `docs/extensions.md`: `session_start`/`session_shutdown` cover startup, quit, reload, new, resume and fork; `message_end` includes custom messages; `sendMessage` supports next-turn and follow-up delivery. A binding is shorter-lived than the OS process. Queued messages need not be persisted when submission returns; this design requires no persistence acknowledgement or startup reconciliation.
- Local tmux **3.6** manual, plus [tmux 3.2 manual](https://github.com/tmux/tmux/blob/3.2/tmux.1), `pipe-pane`: only subsequent pane output enters the pipe, and there is one pipe command per pane. Validate readiness/EOF behavior against supported Linux/macOS versions; this is not evidence of a bounded tmux-side queue or lossless capture under failure.

Sources/code inspected for this proposal on 2026-11-11. No capture prototype or runtime tests have been run. Competitor delivery guarantees are not prerequisites for this design.

## Architecture and contracts

### 1. One output source; separate data and live-session state

```text
Bash in owned tmux pane --merged PTY bytes--> gated Node capture sink
                                                  |
                                      bounded durable journal
                                                  |
                                      reader + text normalizer
                                        /                 \
                              inspect / UI        live Pi filter scheduler
                                                         |
                                          bounded in-memory hit/event queue
                                                         |
                                          live subscriber delivery adapter
```

The sink is the sole journal writer. Manager writes job/control metadata; broker owns the live index, watches and scheduling. Index by immutable random `(ownerId, streamId)`; readable IDs are aliases and cannot retarget a watch when reused. No watcher, cursor, parser state, pending trigger or delivery acknowledgement is written to disk or Pi session entries.

PTY stdout/stderr are merged; there is no stderr selector. Capture records observed pane bytes, not bytes an application never flushed, and not a reconstructed terminal screen. CR rewrites and full-screen applications have explicit text semantics below; manual attach remains the terminal view.

### 2. Durable storage, ownership and historical access

- Store logs under absolute `${XDG_STATE_HOME}/pi-background-monitor`, otherwise `~/.local/state/pi-background-monitor`; do not rely on `/tmp` for retained data. Directories 0700, files 0600; reject symlinks, unexpected uid/type/mode, invalid schemas, oversize metadata and paths escaping the root.
- Keep short private socket/control paths under `/tmp/pbm-*`. Every tmux operation uses the owned socket; verify token/ownership before destructive actions. Never touch the user's default server. tmux/files are not a sandbox against malicious same-user processes.
- Persist only bounded owner/job facts, source identity, capture metadata and a **log reference** associated with the exact session. A new live process creates fresh owner/controller state rather than resurrecting old live monitors. Reading an old reference does not acquire its controller lock, scan/adopt other owners, or create timers/watchers.
- Later historical access is explicit through `bgmon_inspect` using the exact session's validated log references. Return bounded log text and recorded/unknown status; a running-state record from an earlier process is stale metadata, not a live observation. No automatic indexing on startup. Do not build a machine-wide history-discovery or recovery service.
- Preserve in-process sharing of known jobs across main/subagent bindings. Owner-binding shutdown removes its subscriptions but must not invalidate a sibling's independent subscription to an indexed job; retain the manager while active bindings need it. End a subscriber's delivery authority when that binding ends. Cross-process subagents and cross-process discovery are not supported by this plan.
- Copy the dependency-free capture runtime and shared text normalizer into the private job directory; execute the content-addressed runtime with the absolute current Node executable. They must not depend on Pi's TS loader, mutable package files or peer modules during a job.

Illustrative layout:

```text
state-root/
  owners/<ownerId>/owner.json
  owners/<ownerId>/runtime/<hash>.mjs
  owners/<ownerId>/jobs/<streamId>/command.sh
  owners/<ownerId>/jobs/<streamId>/segments/<firstSeq>.jsonl
  owners/<ownerId>/jobs/<streamId>/capture.json
  slots/<slot>/reservation.json  # bounded storage accounting only
```

There are **no subscriber directories, watch checkpoints or durable outboxes**.

### 3. Capture setup and failure semantics

1. Reserve a storage slot, create private metadata/script/runtime, and record the historical log reference. Create a pane running a quiet, finite-timeout **gate launcher**, not the user command.
2. Install `pipe-pane -O` into the Node sink. Use generated bridge-script paths and correct shell quoting; do not interpolate command text, cwd or tmux-format-like user paths into a tmux shell command. Never use `-I`.
3. Sink opens the journal, publishes an initial header and nonce-checked readiness marker. Manager checks readiness and `pane_pipe`, then releases the gate to execute `/bin/bash --noprofile --norc command.sh`. A failed/timed-out startup cleans only that new pane/reservation; no unlogged user command starts.
4. Frame raw bytes in order, with version, stream ID, monotonic safe-integer sequence, observation timestamp, source byte range, kind and base64 payload. Cap raw payload at 16 KiB and encoded frame length. Command output cannot supply journal metadata.
5. Serialize writes and publish a commit watermark only after the corresponding frames are synced. Readers consume only complete validated frames through the published watermark. Atomic `capture.json` holds first retained sequence, committed tail, source parser checkpoints for both, and capture health. This does not promise power-loss-proof storage.
6. Treat output EOF, pane exit and pipe failure separately. Reconcile verified tmux status with a bounded final drain (five seconds); record authentic exit code/signal when known, otherwise explicit incomplete/unknown state, never invented exit zero. Heartbeat/pipe/status checks expose vanished or stuck capture.
7. On sink failure, disk/write timeout or queue exhaustion, fail visibly and request stop of **only the verified owned pane**; retain captured data. Do not silently attach a replacement sink and pretend continuity. If storage cannot record an error, live health checks report uncertainty. Detached descendants may survive stop.
8. `stop` uses the existing bounded Ctrl-C/escalation policy and final drain. `server_stop` stops execution but retains logs. `forget` explicitly removes a nonrunning job's retained data/reservation and marks dependent live watches `source_removed`. Historical cleanup requires proven ownership and must refuse a still-live/uncertain capture source. An explicit delete request may verify an old owned tmux pane is dead, atomically remove that dead pane to drain its pipe, and then reclaim its log; this does not adopt a live controller or restore monitoring. No automatic orphan adoption/deletion.

Startup gating is mandatory: a snapshot cannot backfill missed initial bytes accurately. The sink is a capture implementation detail, **not a filter daemon or Pi supervisor**. On binding/process teardown, detach without introducing any wait-for-return, matching, restart or alert-recovery protocol.

### 4. Practical resource bounds and retention

Centralize constants in `src/limits.ts` and test them:

| Resource | Initial contract |
| --- | --- |
| Encoded journal | Eight segments × 1 MiB per source; roll before a frame exceeds a segment |
| Retained sources | 64 indexed per Pi process / 64 per owner; at most 128 storage slots across the state root |
| Watches | Eight per active binding, 64 total in the live process |
| Capture write queue | 1 MiB encoded per sink; one write/sync chain; bounded diagnostics |
| Scheduler slice | At most 256 KiB bytes / 200 frames / 200 lines, whichever first; round-robin and yield. The 200 ms time budget is soft: an in-flight regex may overrun it. Watch I/O and initialization share at most 16 operations process-wide, four per owner and two per installed watch until they actually settle; saturation is visible and can delay additional watches |
| Logical line | 64 KiB normalized UTF-8; bounded decoder/control state |
| Inspection | 16 KiB / 200 rendered lines, with continuation/truncation/gap markers |
| Live event storage | 128 detailed events per binding plus one bounded coalesced summary per watch |
| Model delivery | ≤2 KiB batch, at most one batch per ten seconds and one outstanding submitted batch per delivery mode/binding |

Storage slots are simple atomic exclusive reservations so repeated sessions cannot accumulate unlimited logs. They account for capacity only, not discovery/adoption. Refuse creation with explicit cleanup instructions when full. Do not silently reclaim old owners. An abrupt crash between reservation and publication of its reference, or midway through deletion, can strand a slot; without out-of-scope restart recovery, an operator must verify no Pi or owned tmux process still uses the data before manually cleaning the corresponding reservation. Bound scripts, manifests and runtime copies as well; account for temporary files during commit/rotation. These are logical payload bounds, not exact filesystem allocation/free-space guarantees.

Rolling retention does not pin segments for slow readers. Delete only complete oldest segments; readers tolerate concurrent eviction and report a visible `history_gap` with known/unknown lost range. Reset partial-line state and skip to the next delimiter after a gap; never manufacture a cross-gap match. This applies to **live slow subscribers**, not offline catch-up. Exited retained logs remain until explicit forget within the slot cap.

Do not build an unbounded async write chain or assume tmux has a proven byte-bounded pipe queue. Phase 1 must validate the chosen stress/failure envelope; if it cannot support the documented behavior, revise the substrate rather than add a hidden snapshot fallback.

### 5. Filter and watch semantics

- Use one incremental UTF-8 decoder/stateful sanitizer implementation for viewing and filtering, stripping OSC/CSI/C0/C1 controls even across frame boundaries. Bound a control token at 4 KiB; expose parser overflow/reset warnings. Malformed UTF-8 uses replacement characters.
- LF and standalone CR delimit logical lines; CRLF is one delimiter. Progress updates are separate text events, not terminal screen emulation. Evaluate only completed lines, including final unterminated text on **clean** EOF. A live no-newline prompt is inspectable but does not trigger yet.
- Filters: `any`, literal `contains` (1–256 characters), JS `regex` (1–256 characters; optional unique `i`/`u` flags). Case-sensitive by default; per-line, not multiline. Validate on add. Use isolated, memory/time-bounded regex worker batches with a process-wide fairness budget; timeout fails only the affected watch visibly.
- If a line exceeds 64 KiB, fail the affected output watch with `line_too_long` rather than silently split regex inputs. Logs remain available as bounded fragments.
- Each completed matching line counts once per watch cursor. Repeated identical lines are distinct hits; drop snapshot false→true edges and polling cooldowns. `once=true` fires on the first eligible hit; repeated watches count all hits and coalesce delivery without discarding the count.
- Keep `exit` as a lifecycle watch, distinguishing exit/cancel/lost/capture failure. Drop snapshot `changed`; use `any` for output activity.
- `from: "now" | "retained"`, default `now`, selects a fresh watch's initial position. `now` samples the published cursor (uncommitted bytes can appear later). `retained` explicitly scans currently retained data for this newly created live watch, including completed sources; it is not restoration of an old watch. Report a missing prefix. Skip an already-partial starting line rather than invent a complete match; test frame/line boundaries.
- Optional `ttlSeconds` (1 second–7 days); absent means until fired, source complete or removed. Use a live monotonic deadline. At expiry sample the published tail, process through that finite boundary, then expire; do not extend the boundary indefinitely for a busy source. After each metadata rename, capture writes a separate stream/tail-matched proof with a monotonic clock sampled after publication. If admission fails, the proof is unavailable/mismatched, a boundary stalls, or its clock is newer than the deadline, fail visibly rather than silently include later output. Consequently busy-source TTLs can fail even when some pre-deadline backlog exists; exact boundary reconstruction is not promised. This relies on Node's cross-process monotonic clock being comparable on the supported platform; verify on Linux/macOS. Exit watches only fire on an exit observed before the deadline. No persisted watch deadlines or closed-session eligibility rules.
- Drain final committed output before completing unmatched watches as `completed_no_match`. Expose active/fired/expired/completed_no_match/failed/source_removed, progress/lag, hit counts, last error and integrity gaps. Removed watches need not retain tombstones beyond the bounded event list.

### 6. In-memory evaluation, delivery and lifecycle

- Broker schedules readers against journal commits; one serialized evaluation mutation per binding. Reuse source reads where practical but do not share mutable parser/cursor state across watches with different positions. Resume bounded batches inside a frame without duplicating hits.
- Advance a watch's in-memory cursor and merge hit effects into its in-memory event queue in the same serialized operation. No filesystem transaction/checkpoint is needed. A process/session shutdown can discard both; this is intentional, not a recovery bug.
- Event metadata includes runtime-unique event/watch/source IDs, positions, counts, status/gaps and sanitized label. **Do not automatically send commands, filter patterns or output excerpts into model context.** Explicit inspection is how an agent reads untrusted output, which may contain secrets or prompt injection.
- Coalesce excess detail into bounded per-watch summaries with exact counts/ranges and a visible `details_coalesced` marker; bound counters. Retain inspectable delivery/error state during the live binding. `bgmon_events` lists/clears these in-memory events, including headless UI-only events; nothing is a durable inbox.
- `wake` submits `followUp` + `triggerTurn: true`; `nextTurn` queues without starting a turn; `ui` never enters model context. At most one submitted-but-not-observed batch per mode/binding avoids unbounded Pi queues. Identify the custom batch at `message_end` to free the live delivery slot (observation, **not durable acknowledgement**). Stage the in-flight ID before submission to handle synchronous callbacks. Submission failure leaves bounded pending/error state for a later live retry, not restart recovery. No startup scan of Pi messages.
- UI toasts are best effort; headless `ui` events remain in the bounded live event list. Do not claim exactly-once delivery or model actions. Delivery coalescing does not change recorded hit counts.
- `session_shutdown` invalidates the binding generation first, cancels its watches/queues/dashboard callbacks and waits boundedly for in-flight work. It must not remove another binding's watches. New/resume/fork/reload starts with **zero watches and pending alerts**, even in the same OS process; stale async completions cannot call old `pi`/`ctx`.
- The process-wide broker retains a known source/manager while other live bindings use it, even if its original subagent exits. Last binding departure releases live scheduler/workers/managers and detaches jobs. No timers survive solely to wait for a session to return. `/tree` does not rewind processes or live watch positions.

## Public surface and affected files

Replace schemas outright:

- `bgmon_start`: command plus stream identity, capture health, log reference/cursor and attach command; one execution mode.
- `bgmon_inspect`: bounded journal tail or forward `after` cursor; first/tail/next, gaps/truncation, capture health and known job status. Explicit historical reads are read-only and do not register a monitor.
- `bgmon_watch`: add/list/update/remove; output filter or exit, `from`, once, optional TTL, delivery, label. No sampling interval, `changed`, snapshot regex flags or edge/cooldown semantics. Filter/start changes require a fresh watch.
- `bgmon_events`: bounded live list/clear, not persistent ack/recovery machinery.
- `bgmon_control`: stop/forget/server_stop with log retention semantics. No controller recovery/adoption commands in this change.
- `/bgmon`: journal viewer, watch health/lag/gaps, live event status, storage and explicit cleanup. No web server or separate settings entry point.

Suggested implementation map (no general provider layer):

- **New** `src/capture.mjs` (self-contained sink), `src/journal.ts` (frames/reader/cursors), `src/storage.ts` (paths/permissions/slots/log metadata), `src/text.ts` (normalizer), `src/watch.ts` (pure filter/live state).
- **Rewrite** `src/broker.ts` (live sharing/scheduler), `src/manager.ts` (capture-aware lifecycle and historical log references; remove monitor recovery), `src/tmux.ts` (gate/pipe/status/control), `src/index.ts` (schemas/live delivery/lifecycle), `src/ui.ts` (journal/live event views).
- **Adapt** regex/output/limits, related tests, packaging, README, AGENTS and CI. Display bounds and filter-input bounds remain distinct.

## Ordered implementation and validation

### Phase 0 — Accepted scope and design

- [x] Inspect repository, planning guidance and installed Pi lifecycle evidence.
- [x] Incorporate user clarification: a continuous live process, main/subagents, durable data only; remove offline/restart/watch recovery requirements.
- [x] Choose a single observation path and define retained-log inspection separately from live monitoring.

Acceptance: this plan proposes implementation only. No monitor/session recovery, persistent delivery protocol or second observation backend is required.

### Phase 1 — Prove startup capture and failure behavior

- [x] Prototype private-server gate + pipe sink and focused integration tests before rewriting public tools.
- [ ] Verify first/last output, zero-output command, quick exit 7, byte order, readiness, pipe presence and bounded EOF/status finalization.
- [ ] Inject missing/dead sink before release and sink/tmux/write failure afterward; test private-target fail-stop/rollback, never snapshot fallback.
- [ ] Check tmux 3.2/current Linux/macOS behavior, Bash 3.2-compatible gate, quoting/format-like paths, and capture independence from mutable package files.

Acceptance: no user command executes before readiness; `FIRST` and `LAST` are captured with true status. Internal write queue stays bounded under the tested envelope. Default-server sentinel remains untouched. Stop/revise if tmux buffering/EOF cannot meet the stated envelope.

### Phase 2 — Journal storage and one observation path

Depends on Phase 1.

- [x] Implement private persistent log store, bounded slots/metadata/runtime, frame publication, rotation, safe concurrent reads and explicit gaps/incomplete state.
- [x] Replace inspect/UI snapshot reads and final-output caches with journal pagination. Separate live controllers from explicit read-only historical references; remove automatic controller/monitor recovery.
- [ ] Unit/fault tests: Unicode/binary, truncated/corrupt frames and metadata, sequence gaps, partial writes, rotation during reads, missing socket, path/symlink/uid/mode rejection, full storage and cleanup refusal for uncertain running sources.
- [ ] Verify completed logs remain readable without a socket or registering live monitors; repeat live-process sessions cannot bypass the storage-slot cap. Concurrent reservation tests use isolated test roots.

Acceptance: every production output reader uses the journal; per-source and root logical storage bounds hold; explicit historical inspection creates no watches/timers/controllers and touches only validated owned data.

### Phase 3 — Live filters and fair scheduling

Depends on Phase 2.

- [x] Implement incremental normalization, any/contains/regex/exit, one-shot/repeat counts, fresh start positions, monotonic TTL boundary and completion/failure handling.
- [x] Add bounded round-robin scheduling and coalesced match counts. Remove snapshot predicates and per-watch sampling intervals; bounded event-list/delivery coalescing remains Phase 4.
- [ ] Test split byte/frame/UTF-8/control boundaries, CR/LF/CRLF, final unterminated line, live no-newline prompt, repeated identical lines, overlong lines/control sequences, worker timeout/isolation/fairness and source failure/removal.
- [ ] Test from-now boundary in a partial line, retained scans on completed jobs, expiry with a busy backlog, rotation during a slow live read, mid-line gap reset, accurate coalesced counts and counter limits.

Acceptance: print an error once followed by >200 lines/16 KiB **while Pi remains running**; the filter finds it from retained journal records. Batching does not change hit counts; gaps/errors are visible. No test requires reopening Pi to recover a watch.

### Phase 4 — Main/subagent delivery and lifecycle

Depends on Phase 3.

- [ ] Wire schemas, `/bgmon`, live event list, bounded delivery and binding-generation guards.
- [ ] Fake Pi tests: wake/nextTurn/UI semantics, one in-flight batch per mode, delayed/missing message observation, synchronous callbacks, submission failure, queue coalescing and metadata-only alerts.
- [ ] Multiple bindings in one process: independent watches/cursors/delivery on one source; original subagent exits while parent/sibling continues; subscriber exit cancels only its watches; no callbacks to dead bindings.
- [ ] Test reload/new/resume/fork starts empty rather than restoring watches/alerts; historical inspection never creates them. Alias reuse cannot retarget watches; last-binding teardown removes timers/workers and detaches jobs.

Acceptance: alerts reach only live subscribed bindings. No monitor starts/restarts/resumes Pi. There are no subscriber checkpoint/outbox files, Pi-message persistence scans, offline match scheduling or automatic monitor recovery paths.

### Phase 5 — Reliability, portability and release readiness

Depends on Phase 4.

- [ ] Stress configured jobs/watches, high-rate output, slow readers, large/no-newline input, repeated regex failures, storage pressure and long unconsumed nextTurn queues. Assert internal bounds; measure/report RSS and latency without claiming an absolute OS/tmux memory guarantee.
- [ ] Test owned sink/server failure and Ctrl-C-resistant/detached descendants; verify diagnostics and bounded best-effort cleanup. Fault tests do not require Pi process restart/recovery.
- [ ] Run Linux/macOS CI on Node 22 and actual supported tmux versions. No native modules, `/proc`, GNU-only runtime utilities or default-server operations. Use private sockets/roots with `finally` cleanup.
- [ ] Update README/AGENTS to describe live-session-only watches, durable bounded historical logs, failure/retention limits, secrets, manual attach, deletion, unsupported old locators and no automatic orphan cleanup.
- [ ] Run `npm run check`, `npm run lint`, `npm test`, focused tests, `npm run format`, and `npm pack --dry-run`; inspect package contents and smoke-test installed runtime availability. Report actual platforms/results.

Acceptance: implemented behavior, tests and docs agree. Review focuses on ownership, startup races, hidden growth, line/cursor boundaries, stale subagent delivery and silent loss. Implementation/commit/push requires its own authorization; the current user authorized publishing this plan only.

## Optional refinements — not requirements

- Partial-line readiness triggers with explicit prefix/dedup semantics; multiline/Boolean filters with separately bounded input.
- User-selected retention/age cleanup, external sources and interactive input/PTY takeover, all through the same journal model where appropriate.
- Automatic restart, offline matching, persistent watches/alerts and Pi lifecycle supervision are **not refinements of this task**; they require a separately requested design.

## Material risks and verification record

- `pipe-pane` has tmux-dependent buffering/EOF behavior. Gating prevents the initial race, not all failure loss. Missing/stalled capture must be visible; retention and slow-reader gaps remain possible. On tested tmux 3.6 a retained dead pane keeps its pipe open; the live supervisor records exit status and removes that owned pane before bounded drain. The gate acknowledges an exec attempt, not execution of the application; if acknowledgement is unavailable after release the pane must stay tracked with an unknown launch result.
- Fail-stop on storage/queue failure can interrupt valuable work and cannot guarantee killing detached descendants. State this prominently; verify only the private owned pane is targeted. A closed capture pipe alone does not prove its producer stopped: deletion must require both a closed capture and a validated record of verified pane/server stop. Pre-release startup failures may be rolled back as unstarted; missing or uncertain evidence must not be silently reclaimed.
- Durable logs retain secrets longer than snapshots; private permissions, explicit deletion and metadata-only automatic alerts are mandatory. Same-user malicious processes remain outside the security boundary.
- This plan assumes subagents share the running Pi process/broker. Independent Pi processes are not silently supported; a future requirement would change sharing, not justify adding recovery now.
- Log sync/publication improves committed-read consistency but does not guarantee power-loss-proof storage. No exactly-once delivery/actions claim. In-memory events intentionally disappear on binding/process teardown. Node cannot forcibly cancel every in-flight filesystem operation or guarantee a hard deadline against a hung kernel/filesystem. Watch reads are polled outside the manager mutation queue and retain a globally bounded slot until settlement; a fully saturated pool visibly delays other watches. Timed-out publication is explicitly uncertain and retains known exit status in live memory.
- Phases 1–3: Linux/tmux 3.6/Node 26 checks and 81 tests passed, including capture faults, private ownership, filtered journal delivery, parser checkpoints, retention, deadlines and IO fairness. Independent reviews prompted lifecycle, integrity and availability fixes. Bounded event/delivery queues and release validation remain outstanding. macOS, tmux 3.2 and Node 22 have not been run.
