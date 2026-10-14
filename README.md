# pi-packages

Pi packages (extensions and their resources) in one Turborepo workspace.

## Layout

| Folder | Holds | Published |
| --- | --- | --- |
| `apps/` | Pi packages: what users install into Pi | Each to npm, on its own version |
| `packages/` | Code and configuration the apps share | Private unless an app needs it at runtime |

| Package | Description |
| --- | --- |
| [`apps/pi-claude-compact`](apps/pi-claude-compact) | Claude Code's context compaction, rebuilt for Pi |
| [`packages/typescript-config`](packages/typescript-config) | Shared `tsconfig` base |

## Develop

Requires Node.js 22.19 or later and pnpm 10.

```bash
pnpm install
pnpm check                          # typecheck and lint every package, cached by Turborepo
pnpm --filter @buyong/pi-claude-compact typecheck
pi -e ./apps/pi-claude-compact      # load an app in Pi for one session
```

## Rules for apps

- Distribute through npm. `pi install git:` installs a repository root, so it cannot install one app from this workspace.
- Declare the Pi host packages (`@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, `typebox`) in `peerDependencies` with `"*"`, and in `devDependencies` with `catalog:`. Never in `dependencies`: a second copy splits Pi's classes and registries.
- Pi loads each installed package with its own module root. A shared package from `packages/` is a separate copy in every app that uses it, so it can hold types, constants, and pure functions, not shared state. Apps that coordinate at runtime do it through `globalThis[Symbol.for(...)]`.
- Pi runs the TypeScript sources directly. A shared package that an app imports at runtime must be published with it or bundled into it; decide which before adding the first one.
