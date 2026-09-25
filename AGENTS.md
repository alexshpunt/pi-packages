# Agent Guidelines

## Restricted Actions

Do **not** auto-commit.

Do **not** interact with the public without explicit permission. For example, do not open PRs or comment on github issues unless I say so.

## Claims about how Claude Code behaves

`~/.claude/projects/**` is **not** evidence of what CC does. The bridge writes into
the same files and CC re-serializes imported records under synthetic ids, so a scan
of that directory largely reflects our own output handed back to us — 352 of 1,810
files hold both shapes. Before asserting "CC does X" from disk, split by provenance
(CC-live records carry a real `requestId`/`promptId`; ours carry
`msg_syn_*`/`req_syn_*`) and regroup by `message.id`, since CC stores one content
block per record while cc-session-io stores one record per message.
`diag/audit-transcripts.mjs` does both.

Better still, prove it with a live probe. `tests/int-cc-contracts.mjs` pins each
undocumented behavior we depend on against the installed CC/SDK and is the right
home for a new assumption; `diag/capture-proxy.mjs` captures the actual request
bodies when the question is what CC sends. Before relying on an SDK option, grep
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` — it documents every
settings field.

The same skepticism applies to any *rate* computed from the debug log. Before
believing one, check the metric against a case whose answer you know: the
cache-break scanner counted a request's uncached `input` as if the next request
should read it back, which turned every tool-heavy turn into a false break and
manufactured a dose-response that looked like a real finding.

Bin by era before comparing groups. A correlation computed over a window that
straddles the onset of the phenomenon will credit whatever else changed. Three
independent analyses agreed one account state was safe on 5,611 clean requests —
every one of which predated the first failure; switching to that state reproduced
the failure in five minutes.

Five wrong conclusions across two sessions came from skipping the above.

## Changelog

Maintain an entry in the `## UNRELEASED` section at the top of `CHANGELOG.md` for every significant change, using the existing format:

```
- **Tag: summary** — detail
```

Do not add changelog entries for docs-only changes. If multiple entries in the UNRELEASED section pertain to the same feature, try to combine them into one entry,

Tags: `Add`, `Fix`, `Refactor`, `Tests`, `Bump`, `Deprecate`, `Remove`.

## Release

No build step — the package ships `src` TypeScript as-is (see `files` in `package.json`). Releases are cut by the user, never by an agent: `npm run release` on a clean `main` asks for the version, then confirms commit, tag and push one at a time (release-it, `.release-it.json`). Along the way it:

1. **Checks** — fails unless `## UNRELEASED` has entries, then runs `typecheck` and `test:unit`.
2. **Bumps** — `package.json`/`package-lock.json` to `X.Y.Z`, and renames `## UNRELEASED` to `## X.Y.Z — YYYY-MM-DD` (`scripts/changelog.mjs`).
3. **Commits, tags, pushes** — `Release X.Y.Z`, annotated tag `vX.Y.Z`, pushed together.

The pushed tag triggers `.github/workflows/publish.yml`, which re-runs the checks, publishes to npm through trusted publishing (OIDC, no token) and creates the GitHub Release from that version's changelog section.

## Tests

Smoke tests typically need to run outside a sandbox because they access local pi/Claude settings and auth state.
