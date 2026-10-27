# pi-packages

**English** | [한국어](README.ko.md)

Extensions for the [Pi coding agent](https://pi.dev), plus the masking library two of them use, developed in one Turborepo workspace. Each package is installed, versioned, and released on its own. Pi users can pick a package below; contributors start at [Develop](#develop).

## Choose a package

These apps install into Pi. Each README states its requirements, setup, and first use.

| Package | npm name | Description |
| --- | --- | --- |
| [`apps/pi-claude-bridge`](apps/pi-claude-bridge) | `@buyong/pi-claude-bridge` | Claude models in Pi through Claude Code and the Agent SDK |
| [`apps/pi-devin`](apps/pi-devin) | `@buyong/pi-devin` | Unofficial provider for Devin models with a Devin account |
| [`apps/pi-ollama-cloud`](apps/pi-ollama-cloud) | `@buyong/pi-ollama-cloud` | Ollama Cloud provider, web tools, and usage reports |
| [`apps/pi-refuseless`](apps/pi-refuseless) | `@buyong/pi-refuseless` | Refuseless provider: API-key login and the models your key can use |
| [`apps/pi-codex`](apps/pi-codex) | `@buyong/pi-codex` | The four Codex extensions below and the `imagegen` skill in one bundle |
| [`apps/pi-codex-auto-review`](apps/pi-codex-auto-review) | `@buyong/pi-codex-auto-review` | Execution approval review inspired by Codex's "Approve for me" |
| [`apps/pi-codex-computer-use`](apps/pi-codex-computer-use) | `@buyong/pi-codex-computer-use` | Codex Computer Use and Browser Use through the Codex Desktop runtime |
| [`apps/pi-codex-fast-mode`](apps/pi-codex-fast-mode) | `@buyong/pi-codex-fast-mode` | OpenAI Fast and Ultrafast service tiers |
| [`apps/pi-codex-image-gen`](apps/pi-codex-image-gen) | `@buyong/pi-codex-image-gen` | Codex-compatible `image_gen` tool and `imagegen` skill |
| [`apps/pi-redact`](apps/pi-redact) | `@buyong/pi-redact` | Masks credentials in tool results and every model request before they reach a language model |

Install an app by its npm name, for example:

```sh
pi install npm:@buyong/pi-codex
```

`pi install git:` installs a repository root, so it cannot install a single app from this workspace.

The shared packages are not Pi packages; do not install them with `pi install`.

| Package | npm name | Description |
| --- | --- | --- |
| [`packages/redact`](packages/redact) | `@buyong/redact` | Credential, private-key, and opt-in PII masking library for Node.js code; `pi-codex-auto-review` and `pi-redact` install it from npm |
| [`packages/typescript-config`](packages/typescript-config) | Not published | Shared `tsconfig` bases for this workspace |

## Repository layout

| Folder | Contents | Published to npm |
| --- | --- | --- |
| `apps/` | Pi packages that users install into Pi | Each package on its own version |
| `packages/` | Code and configuration the apps share | Only when an app installs the package from npm at runtime (currently `redact`) |

## Develop

Requires Node.js 22.19 or later and pnpm 10. Packages that ship compiled `dist/` output (the pi-codex family, `pi-redact`, and `redact`) must be built before you test them or load them from source.

```bash
pnpm install
pnpm check                          # typecheck and lint every package, cached by Turborepo
pnpm build                          # compile the packages that ship dist/ (pi-codex family, pi-redact, redact)
pnpm --filter @buyong/pi-ollama-cloud typecheck
pi -e ./apps/pi-ollama-cloud        # load an app in Pi for one session
```

`pnpm check` builds the workspace dependencies that a type check needs before checking a package. When you run one package's script directly, build that package and its workspace dependencies first with `pnpm --filter "<package>..." build`; for example, the type checks and tests of `pi-codex-auto-review` and `pi-redact` use the built `@buyong/redact`. Shared CI runs the same build before type checks.

## Shared CI and per-package releases

`.github/workflows/pi-packages.yml` runs CI and npm publishing for the public packages: non-private `apps/*` packages with a `pi` manifest, and non-private `packages/*` packages (currently `redact`). On pull requests and pushes to `main`, it type-checks, runs the declared lint and unit tests, and packs each changed public package. A change to the lock file, the catalog, shared code, shared check settings, or the workflow verifies every public package. A manual run only verifies; it never publishes.

### Before you release

- Release from `main` tracking `origin/main`, with clean tracked files and a clean Git index.
- The package's `package.json` needs a `repository.url` that points at this repository, and the package needs an npm Trusted Publisher set to `buYoung/pi-packages` with the workflow file name `pi-packages.yml`.
- Release dependencies first: `@buyong/redact` before `@buyong/pi-codex-auto-review` and `@buyong/pi-redact`, and changed Codex components before `@buyong/pi-codex` (see [Codex package maintenance](#codex-package-maintenance)).
- To draft missing changelog entries, `pnpm release` needs the `claude` CLI from Claude Code, signed in. If it is missing or the draft fails, both changelog files stay as they are, and the release can continue only when their unreleased sections already pair (see step 2).

### Release with `pnpm release`

1. Run `pnpm release` at the repository root and choose one package.
2. `claude -p` (Sonnet, medium effort) drafts changelog entries from the commits since the package's last release tag. After you confirm, they are added to the unreleased sections of `CHANGELOG.md` (English) and `CHANGELOG.ko.md` (Korean). Existing entries stay as they are; only missing changes are added. You can choose a version only when the two unreleased sections pair: every entry sits under `### New`, `### Improved`, `### Fixed`, or `### Removed` (in Korean, `### 새로워진 것`, `### 달라진 것`, `### 해결된 것`, or `### 제거된 것`), and both files have the same subsections with the same number of entries in each.
3. Choose the version, then confirm the commit, the tag, and the push one by one. If you decline or cancel, the remaining steps stop and local changes already made stay in place.

Coding agents and other callers without a terminal can preview the same plan with `pnpm release:dry-run --app <folder name> --version <version|patch|minor|…>`, where the folder name is the last path part, such as `pi-codex` or `redact`. It changes no files, Git state, or remotes, and prints JSON with readiness (`ready`), blocking reasons (`blockers`), and the commit, tag, and push commands it would run. Add `--checks` to also run the package's pre-release checks. The shared flow lives in `scripts/release/`, and per-package settings live in each package's `.release-it.json`.

### What a release tag publishes

Pushing a `<folder name>-v<version>` tag verifies, packs, and publishes only that package. Because tags use folder names, folder names must be unique across `apps/` and `packages/`. An app that installs or bundles another public package through a `workspace:` dependency is checked again when that package changes. Publishing requires a version that matches the tag, an entry for that version in both `CHANGELOG.md` and `CHANGELOG.ko.md` (the GitHub Release body includes both languages), and the `repository.url` and Trusted Publisher described above.

## Codex package maintenance

`@buyong/pi-codex`, `@buyong/pi-codex-auto-review`, `@buyong/pi-codex-computer-use`, `@buyong/pi-codex-fast-mode`, `@buyong/pi-codex-image-gen`, and `@buyong/redact` keep their existing npm names and independent versions. Their files were moved from `buYoung/pi-codex-auto-review` without Git history, and each package keeps its Apache-2.0 license and NOTICE.

- These packages compile TypeScript with `tsc` into `dist/` and publish that output; [Develop](#develop) describes the build order.
- `@buyong/pi-codex-auto-review` and `@buyong/pi-redact` install `@buyong/redact` from npm. Release a new `redact` version first; `pnpm release` and the dry run stop if that version is not on npm.
- `@buyong/pi-codex` bundles the other four extensions through `bundleDependencies`, using the workspace code at the `pi-codex` release tag. Release changed components first, then the bundle. pnpm packs `bundleDependencies` only with hoisted linking, so shared CI packs this package alone with `pnpm pack --config.node-linker=hoisted`.
- npm Trusted Publishers registered from the previous repository point at `buYoung/pi-codex-auto-review` and `npm-package.yml`. Before a package's first release from this repository, change its Trusted Publisher to `buYoung/pi-packages` and `pi-packages.yml`.
- The Docker and Windows checks and evidence-saving scripts for `pi-codex-auto-review` remain in the previous repository (`buYoung/pi-codex-auto-review`). `test:unit` in this repository covers unit and integration checks on the current OS only. Step-by-step verification records are in the `auto-review`, `computer-use`, `image-gen`, `pi-guard`, and `reviewer-redact` folders under [`docs/verification/`](docs/verification) at the repository root.

## pi-claude-bridge maintenance

`@buyong/pi-claude-bridge` (`apps/pi-claude-bridge`) keeps its existing npm name and independent version. No upstream remote or automatic sync is configured. When an upstream change is needed, pull it by hand with the [upstream update guide](apps/pi-claude-bridge/docs/upstream.md) (Korean).

## pi-ollama-cloud maintenance

`@buyong/pi-ollama-cloud` also keeps its existing npm name and independent version. The full Git history of `buYoung/pi-ollama-cloud` was merged into `apps/pi-ollama-cloud`. For installation and switching from a Git installation, see the [app README](apps/pi-ollama-cloud/README.md); for generated data updates and releases, see the [maintenance guide](apps/pi-ollama-cloud/docs/maintaining.md) (Korean).

Shared CI adds a latest-Pi compatibility check and a live-service check for this app. The live-service key is registered as `OLLAMA_CLOUD_API_KEY` and is not passed to pull requests. A `pi-ollama-cloud-v*` release tag requires the key and the live-service check. Only the former standalone GitHub repository (`buYoung/pi-ollama-cloud`) is retired; the npm package is not deprecated.

## Rules for apps

- Distribute through npm; `pi install git:` cannot install one app from this workspace (see [Choose a package](#choose-a-package)).
- Declare the Pi host packages (`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`) in `peerDependencies` with `"*"`, and in `devDependencies` with `catalog:`. Never put them in `dependencies`: a second copy splits Pi's classes and registries.
- Pi loads each installed package with its own module root. A shared package from `packages/` is a separate copy in every app that uses it, so it can hold types, constants, and pure functions, but not shared state. Apps that coordinate at runtime do it through `globalThis[Symbol.for(...)]`.
- Pi runs the TypeScript sources directly. The pi-codex family, `pi-redact`, and `redact` are the exception: they publish `tsc` output from `dist/` (see [Develop](#develop) for building them).
- A shared package that an app imports at runtime must either be published to npm on its own or bundled into the app's archive; decide which before adding a new shared package. `redact` is published on its own and released before the apps that install it.

## License

The repository root is under the MIT License ([`LICENSE`](LICENSE)). Each package carries its own `LICENSE`, and some also carry a `NOTICE`:

- MIT: `pi-claude-bridge`, `pi-devin`, `pi-ollama-cloud`, `pi-refuseless`, and `typescript-config`.
- Apache-2.0: `pi-codex`, `pi-codex-auto-review`, `pi-codex-computer-use`, `pi-codex-fast-mode`, `pi-codex-image-gen`, `pi-redact`, and `redact`.
