# Shared monitor broker and compact tool interface

## Outcome and decision

Provide process-wide monitor identities that any loaded extension runtime can inspect,
control, and subscribe to, without importing or depending on an agent orchestrator.
Keep command execution explicit and reduce eight tool declarations to two.

**Recommended:** a versioned `globalThis[Symbol.for(...)]` broker with a central
monitor Map and per-owner serialized tmux Manager backends. A subscriber is a live
extension runtime, not a subagent-manager thread name. Runtime-local Pi APIs deliver
notifications; only backend state and polling coordination are shared.

Alternatives: factory-local/module-local state cannot reliably span independent
extension loads. Pi event buses are child-local in the inspected orchestrator.
An IPC daemon could span processes but adds protocol, authentication, installation,
and cleanup costs not required here. No cross-process sharing is claimed.

## Evidence inspected

- Existing `src/index.ts`, `src/manager.ts`, `src/tmux.ts`, tests, README, AGENTS.md.
- Installed `@earendil-works/pi-coding-agent` 1.5.0 `docs/extensions.md` factory,
  lifecycle and shutdown sections; `examples/extensions/event-bus.ts` and
  `file-trigger.ts`. Resource startup must be deferred; shutdown must be idempotent.
- `../pi-subagent-manager/src/orch/runtime.ts`: same-process SDK sessions with
  separate child event buses and optionally reloaded extension factories.
- `../pi-subagent-manager/src/orch/inherited-tools.ts`: inherited execution bridges
  use main-session context; they cannot convey an invented child identity.
- `../pi-subagent-manager/docs/subagent-extension-limitations.md`: child-local
  extension precedence, noninteractive UI, inherited-bridge limitations.

## Phases

- [x] Inspect architecture, safety invariants, planning skill and installed Pi docs.
- [x] Decide generic sharing/lifetime boundaries and compare alternatives.
- [ ] Implement shared broker, identity index and compact tools.
  - One central Map keyed by returned monitor/job ID; bounded process-wide capacity.
  - Serialized operations per owner backend retain private socket/lock protections.
  - Lazy same-session recovery indexes retained jobs; no fork/new locator adoption.
  - Creator shutdown removes its subscriptions, not others' monitors.
  - Backend persistence binds only to a live owning session; never append to stale Pi.
  - Last runtime shutdown clears live state/releases locks without terminating jobs.
- [ ] Implement independent bounded subscriptions, watch listing/removal/update.
  - Shared nonoverlapping polls, independent matching state and delivery queues.
  - Existing TTL, interval, snapshot and repeat cooldown semantics remain bounded.
  - Shutdown/generation guards prevent stale delivery; notifications contain metadata.
- [ ] Document two tools, identity/control semantics, same-process boundary and
  orchestrator-neutral child-local versus inherited-bridge behavior.
- [ ] Validate separate factories/loader instances, cross-runtime access and watches,
  creator/last-runtime shutdown, recovery, watch updates/removal and safety regressions.
- [ ] Independent reviewer pass; repair demonstrated issues and rerun checks.
- [ ] Commit implementation and review fixes as logical milestones; push each.

## Tool decision

`background_start` remains the visible arbitrary-shell execution surface.
`background` dispatches list/inspect/stop/forget/server_stop/watch/watches/
update_watch/unwatch through a documented action argument. No legacy declarations
remain. Watch identities are distinct from monitor identities; only the subscribing
runtime manages its watch. Multiple runtimes may independently watch one monitor.
Server stop explicitly affects all jobs belonging to the selected monitor's owner
(or the caller's owner when no monitor ID is supplied).

## Acceptance and verification

Run `npm run format`, `npm run check`, `npm run lint`, `npm test`, focused new
regressions, and `npm pack --dry-run`. All real tmux tests use private sockets and
finally cleanup. Inspect actual output and changed files before recording success.
Run Linux locally; macOS remains CI-only. Verify the working tree before each
commit, preserve unrelated changes, and report exact commit/push outcomes.

## Risks and assumptions

- Process sharing is intentional trusted-extension coordination, not a security
  boundary; knowing an ID allows control. No subprocess or worker IPC is provided.
- Inherited root tool bridges create root-owned watches; child-local notification
  delivery requires a local extension factory. No safe public caller identity is
  present in the inherited bridge, so do not guess from transcript markers.
- A backend can outlive its owning runtime while other runtimes remain; inactive
  owner persistence must be suppressed and rebound if that same session returns.
- Reload compatibility uses a versioned global key; unsupported broker protocol
  changes must not silently join incompatible state.
- Snapshots are lossy; shutdown detaches; detached descendants may survive stop.

## Progress / verification log

Initial design and delegation recorded before implementation. Implementation is
owned by coder `shared-monitor-implementation`; plan/commit coordination belongs
to architect. No changes to the sibling orchestrator are required.
