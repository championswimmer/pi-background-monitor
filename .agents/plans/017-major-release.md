# Major release 1.0.0

## Research
- [x] Inspect open PRs, release workflow and published versions. PR #11 was the only open PR; npm latest was 0.1.0. The next major is 1.0.0.
- [x] Merge PR #11 after its Linux and macOS CI passed; fast-forward local main.

## Prepare
- [x] Bump package and lockfile versions to 1.0.0 on a release branch.
- [x] Run local checks: `npm run check`, `npm run lint` (18 existing warnings), `npm test` (107 passed), `npm pack --dry-run --ignore-scripts`, and `git diff --check` on Linux.
- [ ] Submit and merge the release PR using the repository workflow.

## Release
- [ ] Update local main, tag its merged commit `v1.0.0` and push the tag to trigger trusted npm publishing.
- [ ] Confirm release workflow and npm publication; create a GitHub release with generated notes.

Release workflow: `.github/workflows/release.yml`. Publication depends on GitHub Actions and npm trusted-publishing configuration.
