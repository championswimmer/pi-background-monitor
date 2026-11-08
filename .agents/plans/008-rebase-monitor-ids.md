# Rebase readable monitor IDs

- [x] Fetch current main and inspect both branches and working state.
- [x] Rebase the monitor ID change, preserving main's dialog behavior and ID functionality when resolving conflicts.
- [x] Run formatting, type checking, lint, and tests; inspect final diff.
- [x] Update PR branch with a lease-protected push.

Validation: failures in the existing dialog or readable-ID tests would indicate an incorrect resolution. Linux checks do not establish macOS support.

Linux: `npm run format`, `npm run check`, `npm run lint` (29 warnings), and `npm test` (25 passed). Dependencies were reused from the main worktree with a matching lockfile. macOS was not tested.
