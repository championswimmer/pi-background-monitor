# Readable monitor IDs

- [x] Inspect monitor creation, indexing, persistence, tests, and Pi tool schema guidance.
- [x] Add optional bounded safe IDs to `bgmon_start`, reject collisions, preserve generated defaults and recovery.
- [x] Exercise custom and generated IDs, duplicate rejection, invalid IDs, shared access, and recovery; run project checks.

IDs are used in script filenames, so restrict them to 1–64 ASCII letters, digits, `_` and `-`. A failure would be a duplicate replacing an indexed monitor, an unsafe filename, or inability to recover a custom ID. Pi schema reference: installed `docs/extensions.md`, “Tool parameter schemas and TypeBox”.

Validation: `npm run check`, `npm run lint` (existing warnings), `npm test` (23 passed), and focused custom-ID test passed on Linux using the sibling checkout’s installed dependencies. macOS not tested locally.

Review follow-up: reject case-insensitive collisions within a server (script filenames derive from IDs). Investigate process-restart collisions with not-yet-recovered sessions; reservations require coordination beyond the existing private locator model.

Follow-up: keep exact user-supplied IDs, reserve the generated-ID namespace, and recover the caller before resolving readable IDs so cross-restart collisions fail closed. The index cannot reject names belonging to unrecovered sessions; document the limitation in AGENTS.md.
