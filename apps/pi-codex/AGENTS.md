# AGENTS.md

<!-- agents-md-generator: v1; doc-type: single_repo -->

## 1. Overview

This package installs four Codex extensions and the image-generation skill as one distribution. It owns packaging and resource discovery, not the extensions' runtime behavior.

## 2. Ownership Map

### Stable Ownership Boundaries

- **Bundle membership.** Change `dependencies`, `bundleDependencies`, `pi.extensions`, and `pi.skills` together in `package.json`. Resources resolve inside this package's physical `node_modules`; they must not point at sibling workspace directories. Verify the component and entry-point checks in `../../scripts/codex/check-package.mjs`.
- **Dependency materialization.** `scripts/prepare-package.mjs` turns workspace links into distributable copies, including transitive runtime dependencies such as `@buyong/redact`. Workspace packages come from their archives; registry packages contribute their publishable files. Follow version validation and forbidden-file checks through the final bundle.

## 3. Core Behaviors & Patterns

- `stageDependency()` prefers a workspace package, then resolves through ancestor `node_modules` directories. It validates names and requested version ranges, reuses matching versions, and rejects conflicting versions of the same name. Recursion follows `dependencies`, not peers or development dependencies.
- Workspace archives pass through their own `prepack` lifecycle and contain resolved workspace/catalog dependency ranges. Registry file discovery suppresses lifecycle scripts. Do not package duplicate Pi host dependencies, development sources, native binaries, or OpenAI's private runtime.
- Preparation uses unique staging and archive directories. Only after preparation finishes does it remove the old `node_modules` tree and rename staging into place. `finally` removes temporary directories, but failure after deleting the old tree does not restore it.
- A prepared bundle is a snapshot. Later changes to a component do not modify its copied files. The checker requires the four component declarations, exact bundle membership, matching workspace versions, and no unresolved workspace/catalog ranges. Check the archive rather than inferring its contents from workspace resolution.
- Individual components retain ownership of authentication, settings, commands, and failures. Installing this bundle does not install Desktop's automation runtime, grant account access, or turn ordinary extension loading into Auto Review's guarded startup. Avoid loading the same extension through both the bundle and an individual installation.

## 4. Conventions

- Declare Pi resources relative to the installed package, for example `./node_modules/@buyong/pi-codex-image-gen/skills`.
- The workspace uses isolated dependency linking, but packaging `bundleDependencies` needs the hoisted arrangement prepared for this bundle. Keep that exception at the packaging boundary rather than changing component runtime imports.
- This package has no TypeScript feature implementation. Its type-check script delegates to components; add feature logic to the responsible app, not the preparation script.

## 5. Working Agreements

Apply the [root working agreements](../../AGENTS.md). Run this package's `pnpm typecheck` after component-contract changes. Type checks and verification of the physical bundle's files and versions establish different properties.
