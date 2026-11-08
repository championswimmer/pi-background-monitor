# Prepare npm release

- [x] Inspect package, repository state, Pi package documentation, and registry availability.
- [x] Add npm discovery and repository metadata, declare the missing Pi host peer, and document npm installation; keep lockfile root metadata aligned.
- [x] Run typecheck, lint, tests, and npm pack dry-run; inspect the packed file list and entrypoint.
- [x] Record verification, registry/auth status, and remaining release decisions.

Files: `package.json`, `package-lock.json`, `README.md`, and this plan. Behavior: publish the existing TypeScript Pi extension with discoverable metadata and correct host peer declarations, without changing extension behavior. Disproof: failed checks, a missing packed entrypoint/import, incorrect Pi install syntax, or an inconsistent lockfile.

Sources: installed `@earendil-works/pi-coding-agent` 1.5.0 `docs/packages.md` and `docs/extensions.md`.

On Linux (Node 26.13.0, npm 11.20.0, tmux 3.6): `npm run check` passed; `npm run lint` passed with 29 existing warnings; `npm test` passed 32 tests; `npm pack --dry-run --json` included the manifest, README, all seven source files and the Pi extension entrypoint; manifest and lockfile root dependency fields match; `git diff --check` passed. macOS and an installed npm package were not tested. The npm registry returned E404 for the name (not a guarantee of availability); `npm whoami` returned E401. License terms have not been selected in this repository; do not invent them. The maintainer must confirm the desired license and authenticate before publishing.
