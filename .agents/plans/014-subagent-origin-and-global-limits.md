# 014 — Subagent origin tagging and group-global limits

Status: **implemented in commit `12a58a5`; real-manager end-to-end verification pending.**

The implementation uses broker serialization rather than a separate reservation counter.
Automated integration tests simulate root and child bindings; they do not prove actual child
extension loading or notification delivery. On Linux with Node 26.13.0, `npm run check`,
`npm run lint` (18 existing warnings), `npm test` (107 tests), and `npm run format` passed.
The evidence and design below describe the original proposal; historical code references and
open questions are not necessarily current implementation details.

## Goal

When `pi-background-monitor` is loaded into subagent sessions (via `pi-subagent-manager`'s
**[lab] Subagent extensions** setting):

1. Each child has its own bgmon tools and its own watchers (notifications reach the child).
2. Every monitor is visible from the root session's single `/bgmon` view and `bgmon_inspect` list.
3. **Every monitor records which child started it**, stamped by the harness. The model never
   passes, sees as a parameter, or can forge an origin.
4. `maxOpen` / `maxTotal` are **global across the root session and all of its children**.
5. Preferably **no change to `pi-subagent-manager`**.

## Historical evidence (pre-implementation)

| Fact | Where |
| --- | --- |
| Broker is a process singleton on `globalThis[Symbol.for("pi-background-monitor:broker:v2")]`, so a child's separately loaded module still shares it. | `src/broker.ts:917-920` |
| `list` already aggregates across all owners; inspect/stop/forget work on any indexed id. | `src/broker.ts:278-284`, `:178-180` |
| Limits are per session: `owner.manager.jobs()` (that session only) vs `binding.limits()` (that session's settings). Only "64 indexed monitors" is global. | `src/broker.ts:233-243` |
| `bgmon_start` params are `command` + optional `id`; `jobs()` returns `id, created, command, status`, no origin. | `src/index.ts:107-117`, `src/manager.ts:231-240` |
| Each registered tool closes over its extension instance's `binding` (`get()`). | `src/index.ts:91-95` |
| The subagent manager creates each child session with `appendSessionInfo("<type> <path>")` and a custom entry `pi-subagent:thread:v1` = `{ rootId, threadPath, inheritedCount }`, written **before** extensions load. `rootId` is the root session's id. | `pi-subagent-manager/src/orch/runtime.ts:59, 287, 320-326` |
| Inherited conversation is copied as messages, not custom entries, so each child carries only its own ownership entry. | `runtime.ts:329-347` |
| With subagent extensions selected, reloaded tools shadow the bridged parent tools; without them `bgmon_*` runs in the parent. | `runtime.ts:486-522, 586` |

Assumption to verify first (Phase 0): `ctx.sessionManager.getEntries()` in the child's
`session_start` contains `pi-subagent:thread:v1`.

## Design

### 1. Tagging is harness-side

The tool handle is created per extension instance, and each child has its own instance, so the
origin comes from the instance's `Binding`, not from tool arguments.

- `bgmon_start` schema is **unchanged**. `fields(p, ["command", "id"])` still rejects unknown
  arguments, so a model cannot supply an origin.
- `create(ctx)` derives a `SessionIdentity` (§2) and stores it on the `Binding`.
- `broker.start(binding, ...)` records that identity on the owner. Only outputs gain an `origin`
  field.
- Limit: only works when bgmon is **loaded in the child**. In inherited-bridge mode the call
  executes in the parent, so origin is the parent's. Correct, but not child attribution. Document it.

### 2. Detecting "I am a child" without touching the subagent manager

In `create(ctx)`, scan `ctx.sessionManager.getEntries()` (already done for `SETTINGS` / `ENTRY`)
for `pi-subagent:thread:v1`:

```ts
type SessionIdentity = {
  group: string;   // rootId for children; own session id for a root/standalone session
  origin: string;  // threadPath, e.g. "/root/security-research"; "/root" for the root
  role: "root" | "subagent";
};
```

- Child: `group = rootId`, `origin = threadPath`, `role = "subagent"`.
- Root or standalone: `group = own session id`, `origin = "/root"`, `role = "root"`.
- Strict validation in a small `readSubagentIdentity()`; any mismatch returns `undefined` and falls
  back to root identity (untagged, per-session behavior). A test pins the entry shape.
- Optional: the manager's synchronous host probe
  (`pi.events.emit("pi-subagent-manager:diagnostic:probe", { respond })`) can detect a stale marker
  when a child transcript is reopened in a plain CLI. Not needed for v1.
- Fallback if the entry isn't visible at `session_start`: use `getSessionName()`
  (`"<type> <path>"`) for origin; group by the process-wide default. See open questions.

### 3. Group-global limits

A *group* is every session sharing a `rootId`.

- Broker adds `groups: Map<string, { rootBinding?: Binding; owners: Set<Owner>; reserved: number }>`.
- At `start`, sum `jobs()` across **all owners in the caller's group** for `maxTotal` (retained)
  and `maxOpen` (running).
- Numbers come from the **root binding's** `limits()` (what the human set in `/bgmon settings`).
  Children's own limits are ignored for group counting. With no root binding, use `DEFAULT_LIMITS`.
- Keying by `rootId` stops unrelated root sessions in one process from sharing a budget.
- Race: the check and start are not atomic across owners and concurrent children are realistic.
  Add a synchronous reservation (`reserved++` before the awaited start, `--` in `finally`) counted
  in both checks, unless Phase 0 shows `this.run(...)` serialization already covers it.
- Existing caps (64 indexed monitors, 64 retained per owner, 128 owners, 8 watches per session,
  64 total) stay.
- Error text names the scope: `Maximum 8 running jobs (shared by /root and its subagents)`.
- Lowering a limit never removes jobs (unchanged).

### 4. Visibility

- `Owner` gains `identity`, set at owner creation. It is immutable, so it survives the child
  session ending while its job keeps running.
- `broker.action("list")` and `inspect` decorate jobs with `origin` and `group`; `Manager` is
  unaware.
- `/bgmon` Monitors tab: origin column and a detail line. Settings tab copy becomes
  "Limits shared with subagents".
- IDs stay globally unique; collisions give the existing "Duplicate monitor identity". Optional
  later: auto-prefix readable ids with an origin slug.

### 5. Watches

Unchanged: watches are per binding, so child watchers notify the child. The root sees all jobs but
manages only its own watches.

## Changes by file

| File | Change |
| --- | --- |
| `src/identity.ts` (new) | `SessionIdentity`, `readSubagentIdentity()`, strict validation. |
| `src/index.ts` | Compute identity in `create(ctx)`, attach to `Binding`. No schema change. |
| `src/broker.ts` | `Binding.identity`, `Owner.identity`, `groups`, group counting in `start`, origin in `list`/`inspect`, group cleanup on leave. |
| `src/ui.ts` | Origin column/detail; settings copy. |
| `README.md` | Subagent usage section: lab setting, shared limits, origin tag, bridge-mode caveat. |
| `AGENTS.md` | Update limits and invariants after implementation. |
| `pi-subagent-manager` | **None required.** |

Optional later hardening (only if entry-sniffing proves fragile): the manager's probe response
could include `{ rootId, threadPath }` (`protocol: 2`) so bgmon reads identity from the live host.

## Phases

### Phase 0 — Verify assumptions (no code changes)
- [ ] Load bgmon as a selected subagent extension; log `getEntries()` at `session_start`; confirm
      `pi-subagent:thread:v1` with `rootId` and `threadPath`.
- [ ] Confirm a child's module copy shares the broker.
- [x] Confirm whether `broker.start` serialization already prevents the cross-owner count race.
- [ ] Confirm root session id equals child `rootId`, including nested children.

### Phase 1 — Identity
- [x] `src/identity.ts` plus tests: valid, malformed, absent, entry from another session.
- [x] Attach identity to `Binding`; no behavior change.

### Phase 2 — Origin on monitors
- [x] Store identity on `Owner`; add `origin` to `list`/`inspect`.
- [x] Tests: two bindings, one broker, list shows both origins; model-supplied `origin` rejected.

### Phase 3 — Group limits
- [x] Add `groups`, group-wide counting, root limits, reservation if needed.
- [x] Tests: root + 2 children share one `maxOpen`/`maxTotal`; concurrent starts can't exceed it;
      different roots don't share; a finished child's jobs stay counted until forgotten; no root
      binding falls back to defaults.

### Phase 4 — UI and docs
- [x] Origin column/detail; settings copy; `ui.test.ts` coverage.
- [x] README section; AGENTS.md updates.

### Phase 5 — Verification
- [x] `npm run check`, `npm run lint`, `npm test`, `npm run format` (Linux, Node 26.13.0).
- [ ] Manual end-to-end with the subagent manager: two children each start jobs; verify origin
      tags, shared cap, child watch notifications reach the child, root can see and stop all.
- [ ] Report which platforms ran (CI covers Linux and macOS).

## Open questions

1. Whose limits apply when bgmon is only in children? Proposed: defaults.
2. Nested children: confirm `rootId` is the true root so grandchildren join the same group.
3. Origin for recovered or historical jobs: persist in registry metadata, or accept "unknown"?
4. Child's jobs outliving it: proposed to keep counting until forgotten.
5. Stale marker in a plain CLI: use the host probe or accept it?
6. Per-child sub-caps (so one child can't use the whole budget): out of scope for v1.

## Risks

- Reading another extension's session-entry format is an implicit contract; mitigated by strict
  parsing, safe fallback and a pinning test.
- One busy child can starve the group budget; acceptable for v1.
- Origin is trustworthy against the model, not against malicious code running as the same user
  (same caveat as the tmux ownership note in AGENTS.md).
