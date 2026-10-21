# AGENTS.md

<!-- agents-md-generator: v1; doc-type: monorepo_root -->

## 1. Overview

This monorepo develops independently installable Pi extensions and supporting libraries. Use this document for cross-package decisions and each package's `AGENTS.md` for its internal behavior and verification boundaries.

## 2. Ownership Map

### Stable Ownership Boundaries

- **Installation and runtime files.** Start with the affected package's `package.json`, especially `pi`, `files`, exports, and runtime dependencies. Claude Bridge, Claude Compact, Devin, and Ollama ship TypeScript sources; individual Codex extensions and Redact ship compiled `dist/` files. Manifest paths are relative to the installed package, not the workspace. Check the actual archive for entry points, imported files, and bundled resources; a working workspace import does not establish installability.
- **Codex distribution.** `apps/pi-codex/package.json` selects four extensions and the image-generation skill. Its `scripts/prepare-package.mjs` creates physical dependency copies; behavior still belongs to the individual apps. Editing a sibling package does not update an already prepared copy. `scripts/codex/check-package.mjs` checks component selection, versions, entry points, and forbidden archive contents.
- **Redaction.** `packages/redact` owns the host-independent masking API. `apps/pi-codex-auto-review/src/review/redaction.ts` owns which review-bound copies are masked and which legacy protections supplement that API. Keep dependencies directed from the consumer to the library. Changes affect both independently installed Auto Review and the copy distributed through the Codex bundle.
- **Claude session coordination.** Compact's `controller.ts` notifies Bridge's `src/session/mirror-store.ts` after rewriting a session. Their shared `claude-bridge:markRebuildHooks` symbol contains a `Set` of `(piSession, event)` callbacks. Invalidate only the identified session; separately loaded packages do not share ordinary module state. Check the Compact notification site together with Bridge's cross-session and rewrite verification.
- **Host dependencies and compiler settings.** `pnpm-workspace.yaml` owns shared development versions; Devin uses its separate `catalog:devin`. Pi-provided `pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, and `typebox` belong in wildcard peers plus development dependencies where needed, not duplicated runtime copies. `packages/typescript-config` provides separate source-loading and compiled Node ESM presets. Check each consumer's `include`, output paths, and import conventions; Bridge maintains its own configuration.
- **Release infrastructure.** `scripts/pi-apps.mjs` identifies public Pi apps and public shared packages. `scripts/release/` owns release planning, checks, and interactive decisions; package `.release-it.json` files attach package-specific checks and changelog hooks. Folder names used in release tags must be unique across apps and packages. Check dependency ordering, archive versions, and corresponding English/Korean changelog entries when changing this infrastructure. Do not duplicate release selection logic inside an app.

## 3. Working Agreements

- Use the user's requested language. Otherwise follow the repository's language conventions. Keep identifiers, technical terms, exact logs, and code examples intact unless the task changes them.
- Before editing, trace affected callers through shared logic to the final consumer. Check related usages and established patterns rather than reasoning from one file alone.
- Repair the underlying defect with the narrowest complete change. Report relevant behavior changes, side effects, and public API compatibility risks.
- Resolve material questions about scope, behavior, or tradeoffs with the user. Do not add an approval stage to an already explicit implementation request.
- Write or update tests when you judge them necessary to verify the requested change or prevent regressions; a separate test-writing request is not required. If a feature's requirements or expected behavior are ambiguous, ask the user before writing or changing tests for that feature.
- Add lint rules or formatter configuration only when explicitly requested. Do not broaden a documentation task into tooling changes.
- After code changes, use the relevant package's type check or the root `pnpm typecheck` for cross-package changes. Keep package-specific verification guidance in package-level documents. Distinguish checks actually run from unverified runtime behavior.
- Keep new functions and modules focused on one responsibility and close to their consumers. Introduce external dependencies only when necessary and explain the reason.
