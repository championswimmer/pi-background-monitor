# Documentation audiences

- [x] Inspect existing documentation, package metadata, and implementation for accurate installation and behavior.
- [x] Make README concise and user-focused; move useful implementation and development guidance to AGENTS.md.
- [x] Run formatting, type checking, linting, tests, and package verification; review the diff.

Check: README commands and claims must match package metadata and implementation; agent guidance must preserve important architecture, safety, and lifecycle constraints. Runtime behavior is unchanged. Linux is the available local platform; macOS remains a CI-only check.

Validation on Linux: `npm run format` (no changes), `npm run check`, `npm run lint` (20 existing non-null assertion warnings), `npm test` (10 passed), and `npm pack --dry-run` all succeeded. macOS was not run locally.
