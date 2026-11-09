# Regex snapshot watches

## Goal and choices

Add a `regex` watch using raw JavaScript regex source and optional unique `imsu`
flags. `contains` remains a case-sensitive literal search. Explain both kinds in
`bgmon_watch`'s schema and description, and in the selected-tool-aware system
prompt. Preserve existing bounded, sanitized snapshot and delivery semantics.

Native regex on the shared event loop can freeze Pi through catastrophic
backtracking. A small lazy shared Node worker compiles and tests patterns, caches
up to 64, and is terminated on timeout. A rotating per-tick budget limits the
impact of slow watches. A failed watch is removed with a metadata-only notice.
No native addon, external regex dependency, shell dialect, or worker file is
needed. Regex semantics are JavaScript's, not a linear-time guarantee, and worker
isolation does not protect the whole process from all memory exhaustion.

## Phases

- [x] Read project guidance, source, tests, installed Pi integration docs/examples,
      and existing plans; identify timeout, lifecycle and prompt requirements.
- [x] Implement isolated matching, validation, watch polling and lifecycle; keep
      the existing literal predicate unchanged. Deactivate sessions before queued
      cleanup to prevent an in-flight add resurrecting a watch.
- [x] Document tool arguments, update prompt selection and README, and add focused
      tests of syntax/flags, match notifications, timeouts and recovery.
- [x] Run format, check, lint, all tests and package dry-run; review diff.
- [ ] Commit and push as requested.

## Verification and limitations

Implementation and tests must prove that a pathological expression times out
without blocking the parent, a subsequent expression succeeds, and notifications
do not include matched output. Pi watches remain best-effort snapshots, not a
log stream; they can miss transient text, expire and do not survive reload. A
full Pi restart is needed when an older in-process broker is already loaded.
Local environment is Linux/Node 26; Node 22 and macOS remain CI/release checks,
not locally verified. No claims of full memory isolation or lossless alerts.

Local results: `npm run format`, `npm run check`, `npm run lint` (warnings),
`npm test` (35 passed), focused regex tests (3 passed), `git diff --check`, and
`npm pack --dry-run` passed on Linux/Node 26.13.0. The packaged files include
`src/regex.ts`. No Node 22 or macOS run was available locally.
