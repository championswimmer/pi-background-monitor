# Documentation cleanup

## Outcome
Keep the README concise and human-oriented, preserve detailed usage and safety information in packaged documentation, and make AGENTS.md a practical guide to working in this repository.

## Phases
- [x] Inspect current documentation, source layout, package contents and project instructions.
- [x] Move detailed usage, limits and safety material to docs; link it from a concise README and include docs in the npm package.
- [x] Expand AGENTS.md with accurate codebase and editing guidance while preserving existing invariants.
- [x] Validate links, package contents and documentation changes; record checks and remaining risks.

## Verification
- Linux, Node 26.13.0, tmux 3.6: `npm run check`, `npm run lint` (18 existing warnings), `npm run format`, `npm pack --dry-run` and `git diff --check` passed; local Markdown links resolve.
- `npm test`: 106/107 passed; a manager test observed `capture_unverified` instead of `exited`. Focused `npx tsx --test tests/manager.test.ts` subsequently passed 11/11. Cause not established; no runtime code was changed.
