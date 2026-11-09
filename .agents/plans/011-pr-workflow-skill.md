# Add pull request workflow skill

Files: `.agents/skills/pr-workflow/SKILL.md` and this plan. Behavior: instruct contributors to commit on a branch, open a pull request instead of pushing directly to main, and self-merge it so pull requests can support changelog generation. Disproof: missing skill metadata, an ambiguous or incomplete workflow, a direct push to main, or a failed required check.

- [x] Inspect project guidance, existing skill convention, and repository state.
- [x] Add the focused repository workflow skill.
- [x] Run applicable checks and record results and limitations.
- [ ] Commit on a branch, push it, raise a pull request, and self-merge if permitted.

On Linux, with existing dependencies from the sibling checkout: `npm run format` made no changes; `npm run check` passed; `npm run lint` passed with 29 existing warnings; `npm test` passed all 32 tests. `git diff --check` passed. macOS was not tested. The checks cover the extension, not whether changelog generation consumes the resulting PR.
