# npm release workflow

## Research
- [x] Inspect package scripts, CI and sibling Pi release workflows under `~/Development/Pi` (the requested lowercase path does not exist on this filesystem).
- [x] Follow `pi-gh-footer/.github/workflows/release.yml`: tag-triggered npm trusted publishing, version and main-ancestry checks, and prerelease dist-tag selection.

## Implementation
- [x] Add `.github/workflows/release.yml`; run this project's check, lint and tests with tmux installed before publishing.
- [x] Document npm trusted-publisher configuration in the workflow.

## Validation
- [x] Check workflow structure and version/tag handling, and run available project checks and `npm pack --dry-run`.
- [x] Record results and remaining risks.

On Linux, `npm ci --ignore-scripts`, `npm run check`, `npm run lint` (31 existing warnings), `npm test` (35 tests), `npm run format` (no changes), and `npm pack --dry-run --ignore-scripts` passed. Ruby YAML parsing and sample stable/prerelease dist-tag selection also passed. GitHub Actions and OIDC publishing are untested locally and require a configured npm trusted publisher.
