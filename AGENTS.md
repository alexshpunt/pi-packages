# Agent Guidelines

## Changelog

Add an entry to an `## UNRELEASED` section at the top of `CHANGELOG.md` for
every change, using the existing format:

```
- **Tag: summary** — detail
```

Tags: `Add`, `Fix`, `Refactor`, `Docs`, `Tests`, `Bump`, `Deprecate`, `Remove`.

Do **not** auto-commit.

## Tests

Smoke tests typically need to run outside a sandbox because they access local pi/Claude settings and auth state.
