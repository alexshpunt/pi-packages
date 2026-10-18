# Agent Guidelines

## Restricted Actions

Do **not** auto-commit.

Do **not** interact with the public without explicit permission. For example, do not open PRs or comment on github issues unless I say so.

## Claims about how Claude Code behaves

`~/.claude/projects/**` is **not** evidence of what CC does -- the bridge writes there too, and CC re-serializes imported records under synthetic ids. Split by provenance (CC-live: real `requestId`/`promptId`; ours: `msg_syn_*`/`req_syn_*`) and regroup by `message.id` (`diag/audit-transcripts.mjs` does both).

Better: prove it with a live probe. `tests/int-cc-contracts.mjs` pins undocumented behavior against the installed CC/SDK; `diag/capture-proxy.mjs` captures request bodies. Before relying on an SDK option, grep `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` first.

Validate any *rate* from the debug log on a case whose answer you know. Bin by era before comparing groups -- a window straddling the onset credits whatever else changed.

Five wrong conclusions across two sessions came from skipping the above.

## Changelog

Maintain an entry in the `## UNRELEASED` section at the top of `CHANGELOG.md` for every significant change, using the existing format:

```
- **Tag: summary** — detail
```

Do not add changelog entries for docs-only changes. Combine multiple UNRELEASED entries about the same feature into one.

Tags: `Add`, `Fix`, `Refactor`, `Tests`, `Bump`, `Deprecate`, `Remove`.

## Release

No build step — the package ships `src` TypeScript as-is (see `files` in `package.json`). Releases are cut by the user, never by an agent: `pnpm --filter @buyong/pi-claude-bridge release` from the monorepo root on a clean tracked/index `main` asks for the version, then confirms commit, tag and push one at a time (release-it, `.release-it.json`). The branch must track `origin/main`. Along the way it:

1. **Checks** — fails unless `## UNRELEASED` has entries, then runs `typecheck` and `test:unit`.
2. **Bumps** — the app's `package.json` to `X.Y.Z`, and renames `## UNRELEASED` to `## X.Y.Z — YYYY-MM-DD` (`scripts/changelog.mjs`). Do not create a package-lock; the root `pnpm-lock.yaml` owns dependency resolution and does not store the app's own version.
3. **Commits, tags, pushes** — use the monorepo commit format and annotated tag `pi-claude-bridge-vX.Y.Z`; push only `main` and that tag atomically, never all historical tags.

The pushed tag triggers the repository-root `.github/workflows/pi-packages.yml`, which re-runs the checks, packs with pnpm to resolve catalog references, publishes the tarball to npm through trusted publishing (OIDC, no token), and creates the GitHub Release from that version's changelog section.

Do not configure an upstream remote or automatic synchronization without an explicit request. Follow `docs/upstream.md` only when the user asks to import upstream changes.

## Tests

Smoke tests typically need to run outside a sandbox because they access local pi/Claude settings and auth state.
