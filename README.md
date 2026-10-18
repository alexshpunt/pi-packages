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
| [`apps/pi-claude-bridge`](apps/pi-claude-bridge) | Claude Code provider and AskClaude tool for Pi |
| [`packages/typescript-config`](packages/typescript-config) | Shared `tsconfig` base |

## Develop

Requires Node.js 22.19 or later and pnpm 10.

```bash
pnpm install
pnpm check                          # typecheck and lint every package, cached by Turborepo
pnpm --filter @buyong/pi-claude-compact typecheck
pi -e ./apps/pi-claude-compact      # load an app in Pi for one session
```

## 공통 CI와 패키지별 배포

`.github/workflows/pi-packages.yml` 하나가 CI와 npm 배포를 담당합니다. PR과 `main` push에서는 변경된 공개 Pi 앱을 검증하며, 잠금 파일·catalog·공용 코드·workflow 변경 시에는 모든 공개 Pi 앱을 검증합니다. 수동 실행도 검증만 하며 배포하지 않습니다.

`<앱 폴더명>-v<버전>` 태그 push는 해당 앱 하나만 검증·패키징·배포합니다. 대상은 `apps/*/package.json`의 `pi`가 있고 `private`이 아닌 패키지에서 선택합니다. 배포하려면 태그와 일치하는 버전, 해당 버전의 `CHANGELOG.md` 항목, 이 저장소를 가리키는 `repository.url`, 그리고 패키지별 npm Trusted Publisher 설정이 필요합니다. 각 npm 패키지는 동일한 `buYoung/pi-packages`와 workflow 파일명 `pi-packages.yml`을 지정합니다.

## bridge 유지보수

`@buyong/pi-claude-bridge`는 기존 npm 이름과 독립 버전을 유지합니다. 저장소 루트에서 `pnpm --filter @buyong/pi-claude-bridge release`로 버전을 선택하고 커밋·태그·push를 각각 승인합니다. `pi-claude-bridge-v*` 태그가 공통 workflow에서 bridge의 npm 배포와 GitHub Release만 실행합니다.

upstream remote나 자동 동기화는 설정하지 않습니다. 원본 변경이 필요할 때 [upstream 갱신 가이드](apps/pi-claude-bridge/docs/upstream.md)를 따라 수동으로 가져옵니다.

## Rules for apps

- Distribute through npm. `pi install git:` installs a repository root, so it cannot install one app from this workspace.
- Declare the Pi host packages (`@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, `typebox`) in `peerDependencies` with `"*"`, and in `devDependencies` with `catalog:`. Never in `dependencies`: a second copy splits Pi's classes and registries.
- Pi loads each installed package with its own module root. A shared package from `packages/` is a separate copy in every app that uses it, so it can hold types, constants, and pure functions, not shared state. Apps that coordinate at runtime do it through `globalThis[Symbol.for(...)]`.
- Pi runs the TypeScript sources directly. A shared package that an app imports at runtime must be published with it or bundled into it; decide which before adding the first one.
