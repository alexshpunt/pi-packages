# AGENTS.md

<!-- agents-md-generator: v1; doc-type: single_repo -->

## 1. Overview

This package installs the four Pi extensions and the image-generation skill together. It contains distribution metadata and staged dependencies, not a separate runtime implementation.

## 2. Ownership Map

### Stable Ownership Boundaries

- **Component selection and loading**: Start in `package.json` for the `workspace:*` component dependencies, `bundleDependencies`, `pi.extensions`, and `pi.skills`. The four extension paths resolve inside this package's physical `node_modules`; the skill path belongs to the image-generation dependency. Keep these paths aligned with the individual packages, and do not load the same extension both individually and through the aggregate. The aggregate assertions in `../../scripts/codex/check-package.mjs` verify the component references, entry paths, and bundled files.
- **Dependency staging**: Start in `scripts/prepare-package.mjs` for changes to the aggregate's contents. It constructs a physical tree, including transitive runtime dependencies such as `@buyong/redact`, rather than packaging pnpm's symlinks: workspace packages are extracted from their own `pnpm pack` archives so their manifests carry resolved versions, and registry packages are copied from npm's publishable file set. Preserve version-range checks and the rejection of conflicting versions of the same dependency. The required-file and forbidden-content assertions in `../../scripts/codex/check-package.mjs` are the verification boundary.

## 3. Core Behaviors & Patterns

- **Snapshot, not source linkage**: Pi loads staged copies of the original extension entry points. Editing a sibling workspace does not update these copies automatically. Commands, settings, and feature eligibility remain owned by each component; the bundle provides neither Codex Desktop nor account access and does not make ordinary extension loading fail closed.
- **Bounded dependency traversal**: `stageDependency` resolves upward through `node_modules` and follows pnpm's links. It checks the resolved package name and range (`workspace:*` accepts the linked version), deduplicates identical versions, and recursively visits `dependencies`, not peer or development dependencies. Packing a workspace dependency runs its `prepack`; registry dependencies are copied with lifecycle scripts disabled.
- **Staging lifetime**: All dependencies are prepared in a unique `.package-*` directory before the existing aggregate `node_modules` is removed and staging is renamed into place. `finally` removes leftover staging. This is not a rollback guarantee: failure after removing the old tree can leave no usable staged dependencies.
- **Distribution checks**: The checker requires `workspace:*` for the four components, bundled versions equal to the workspace versions, no `workspace:`/`catalog:` ranges left in bundled manifests, and the declared bundle list to match the four extensions. It checks bundled component/redactor artifacts and excludes Pi host packages, source/development trees, native binaries, and private OpenAI runtime files. Do not add runtime behavior here to work around a component's prerequisite or failure.

## 4. Conventions

- Keep `pi` paths relative to the aggregate package, for example `./node_modules/@buyong/pi-codex-image-gen/skills`; do not point them at sibling `src` or `dist` directories.
- pnpm packs `bundleDependencies` only with hoisted linking, so pack this package with `pnpm pack --config.node-linker=hoisted`; the workspace keeps isolated linking. `prepack` rebuilds the components, stages the bundle, and runs the checker.
- Feature logic and package-specific working rules live in sibling packages. This package has no local TypeScript source; its `typecheck` runs the bundled components' type checks.

## 5. Working Agreements

Follow [the root working agreements](../../AGENTS.md).
