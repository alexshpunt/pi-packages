# AGENTS.md

<!-- agents-md-generator: v1; doc-type: single_repo -->

## 1. Overview

This private package provides separate TypeScript baselines for source-loaded Pi apps and compiled Node libraries. It contains configuration, not executable code or shared runtime state.

## 2. Ownership Map

### Stable Ownership Boundaries

- **Source loading.** `base.json` combines bundler module resolution, `.ts` import support, and `noEmit`. Ollama and Devin inherit it. Check each consumer's input selection and Devin's additional `erasableSyntaxOnly` constraint when changing this preset.
- **Compiled Node ESM.** `node-library.json` combines NodeNext modules/resolution, the ES2023 target, declaration output, and source maps. Individual Codex extensions and Redact supply `rootDir: src` and `outDir: dist`. Verify consumer type checks together with their emitted entry points and archive paths.

## 3. Core Behaviors & Patterns

- The two presets are independent; neither extends the other. Do not copy source-only `noEmit`/`allowImportingTsExtensions` into the emitting preset or impose NodeNext on every source-loaded app.
- Consumers own `include`, root directories, and output locations. Ollama explicitly selects `src`, `scripts`, and `test`. Adding a folder does not make it part of type checking automatically.
- Not every workspace package consumes these presets. Bridge uses its own `tsconfig.json`; the Codex aggregate delegates type checks to components. Do not describe a preset change as affecting every app.

## 4. Conventions

- Extend the explicit path `@repo/typescript-config/base.json` or `@repo/typescript-config/node-library.json`; there is no runtime entry or alias-resolution service.
- Keep the manifest's `files` aligned with the two JSON files. This is a `private: true` development dependency, not an app runtime dependency.

## 5. Working Agreements

Apply the [root working agreements](../../AGENTS.md). This package declares no type-check script. Validate changes through affected consumers' `typecheck` scripts, or the root `pnpm typecheck` when the change crosses packages.
