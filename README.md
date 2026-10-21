# pi-packages

Pi packages (extensions and their resources) in one Turborepo workspace.

## Layout

| Folder | Holds | Published |
| --- | --- | --- |
| `apps/` | Pi packages: what users install into Pi | Each to npm, on its own version |
| `packages/` | Code and configuration the apps share | Private unless an app installs it from npm at runtime |

| Package | Description |
| --- | --- |
| [`apps/pi-claude-bridge`](apps/pi-claude-bridge) | Claude Code provider and AskClaude tool for Pi |
| [`apps/pi-ollama-cloud`](apps/pi-ollama-cloud) | Ollama Cloud 공급자, 웹 도구, 사용량 조회 |
| [`apps/pi-codex`](apps/pi-codex) | The four Codex extensions below and the `imagegen` skill in one bundle |
| [`apps/pi-codex-auto-review`](apps/pi-codex-auto-review) | Execution approval review inspired by Codex's "Approve for me" |
| [`apps/pi-codex-computer-use`](apps/pi-codex-computer-use) | Codex Computer Use and Browser Use through the Codex Desktop runtime |
| [`apps/pi-codex-fast-mode`](apps/pi-codex-fast-mode) | OpenAI Fast and Ultrafast service tiers |
| [`apps/pi-codex-image-gen`](apps/pi-codex-image-gen) | Codex-compatible `image_gen` tool and `imagegen` skill |
| [`apps/pi-redact`](apps/pi-redact) | Masks credentials in tool results and every model request before they reach a language model |
| [`packages/redact`](packages/redact) | Credential, private-key, and opt-in PII masking library; published for `pi-codex-auto-review` and `pi-redact` |
| [`packages/typescript-config`](packages/typescript-config) | Shared `tsconfig` bases |

## Develop

Requires Node.js 22.19 or later and pnpm 10.

```bash
pnpm install
pnpm check                          # typecheck and lint every package, cached by Turborepo
pnpm build                          # compile the packages that ship dist/ (pi-codex family, pi-redact, redact)
pnpm --filter @buyong/pi-ollama-cloud typecheck
pi -e ./apps/pi-ollama-cloud        # load an app in Pi for one session
```

## 공통 CI와 패키지별 배포

`.github/workflows/pi-packages.yml` 하나가 CI와 npm 배포를 담당합니다. PR과 `main` push에서는 변경된 공개 Pi 앱의 타입 검사, 선언된 린트·단위 테스트, 패키징을 실행합니다. 잠금 파일·catalog·공용 코드·공통 검사 설정·workflow 변경 시에는 모든 공개 Pi 앱을 검증합니다. 수동 실행도 검증만 하며 배포하지 않습니다.

배포는 저장소 루트의 `pnpm release` 하나로 모든 공개 Pi 앱에 적용합니다. 터미널에서 앱 하나와 버전을 고른 뒤 커밋·태그·push를 하나씩 확인합니다. 추적 파일과 index가 깨끗하고 `origin/main`을 추적하는 `main`이어야 합니다. 앱을 고르면 `claude -p`(Sonnet, medium)가 지난 배포 태그 이후 커밋에서 변경 이력 초안을 만들고, 확인하면 `CHANGELOG.md`(영문)와 `CHANGELOG.ko.md`(한글)의 미배포 절에 기록합니다. 이미 있는 항목은 그대로 두고 빠진 변경만 더합니다. 두 파일의 미배포 절에 짝이 맞는 항목이 있어야 버전 선택으로 넘어갑니다. 거절하거나 취소하면 이후 단계는 멈추고 이미 바뀐 로컬 상태는 남습니다. 코딩 에이전트는 터미널 없이 `pnpm release:dry-run --app <앱 폴더명> --version <버전|patch|minor|…>`으로 같은 계획을 미리 확인합니다. 파일·Git·원격을 바꾸지 않고 준비 여부(`ready`)와 차단 사유(`blockers`), 실행될 커밋·태그·push 명령을 JSON으로 출력하며, `--checks`를 붙이면 앱의 배포 전 검사도 실행합니다. 공통 흐름은 `scripts/release/`, 앱별 설정은 `apps/<앱>/.release-it.json`에 있습니다.

`<앱 폴더명>-v<버전>` 태그 push는 해당 앱 하나만 검증·패키징·배포합니다. 대상은 `apps/*/package.json`의 `pi`가 있고 `private`이 아닌 패키지와, `packages/*` 중 `private`이 아닌 패키지(`redact`)에서 선택합니다. 태그 이름이 폴더명을 쓰므로 두 디렉터리의 폴더명은 겹치면 안 됩니다. 다른 배포 대상을 `workspace:` 의존성으로 설치하거나 묶는 앱은 그 대상이 바뀔 때 함께 검사합니다. 배포하려면 태그와 일치하는 버전, `CHANGELOG.md`와 `CHANGELOG.ko.md`의 해당 버전 항목(GitHub Release 본문에 두 언어가 함께 들어감), 이 저장소를 가리키는 `repository.url`, 그리고 패키지별 npm Trusted Publisher 설정이 필요합니다. 각 npm 패키지는 동일한 `buYoung/pi-packages`와 workflow 파일명 `pi-packages.yml`을 지정합니다.

## Codex 패키지 유지보수

`@buyong/pi-codex`, `@buyong/pi-codex-auto-review`, `@buyong/pi-codex-computer-use`, `@buyong/pi-codex-fast-mode`, `@buyong/pi-codex-image-gen`, `@buyong/redact`는 기존 npm 이름과 독립 버전을 유지합니다. `buYoung/pi-codex-auto-review`의 파일을 Git 이력 없이 옮겨왔으며, 패키지별 라이선스는 Apache-2.0과 NOTICE를 그대로 둡니다.

- 이 패키지들은 TypeScript를 `tsc`로 `dist/`에 컴파일해 배포합니다. auto-review의 타입 검사와 테스트는 `@buyong/redact`의 빌드 결과를 쓰므로 `pnpm --filter "<패키지>..." build`로 의존성까지 먼저 빌드합니다. 공통 CI는 타입 검사 전에 같은 빌드를 실행합니다.
- `@buyong/pi-codex-auto-review`는 `@buyong/redact`를 npm에서 설치합니다. redact의 새 버전을 먼저 배포하세요. `pnpm release`와 dry-run은 그 버전이 npm에 없으면 멈춥니다.
- `@buyong/pi-codex`는 나머지 네 확장을 `bundleDependencies`로 묶고, 자신의 릴리스 태그 시점의 작업 공간 코드를 넣습니다. 바뀐 구성 요소를 먼저 릴리스한 뒤 통합 패키지를 릴리스하세요. pnpm은 hoisted 연결에서만 `bundleDependencies`를 포장하므로, 공통 CI는 이 패키지만 `pnpm pack --config.node-linker=hoisted`로 포장합니다.
- 이전 저장소에서 등록한 npm Trusted Publisher는 `buYoung/pi-codex-auto-review`와 `npm-package.yml`을 가리킵니다. 이 저장소에서 처음 배포하기 전에 패키지마다 `buYoung/pi-packages`와 `pi-packages.yml`로 바꾸세요.
- auto-review의 Docker·Windows 검증과 증거 저장 스크립트는 이전 저장소에 남아 있습니다. 이 저장소의 `test:unit`은 현재 OS의 단위·통합 검증만 다룹니다. 단계별 검증 기록은 `docs/verification/`의 `auto-review`, `computer-use`, `image-gen`, `pi-guard`, `reviewer-redact`에 있습니다.

## bridge 유지보수

`@buyong/pi-claude-bridge`는 기존 npm 이름과 독립 버전을 유지합니다. 저장소 루트의 `pnpm release`에서 bridge를 고르고 버전을 선택한 뒤 커밋·태그·push를 각각 승인합니다. `pi-claude-bridge-v*` 태그가 공통 workflow에서 bridge의 npm 배포와 GitHub Release만 실행합니다.

upstream remote나 자동 동기화는 설정하지 않습니다. 원본 변경이 필요할 때 [upstream 갱신 가이드](apps/pi-claude-bridge/docs/upstream.md)를 따라 수동으로 가져옵니다.

## Ollama Cloud 유지보수

`@buyong/pi-ollama-cloud`도 기존 npm 이름과 독립 버전을 유지합니다. `buYoung/pi-ollama-cloud`의 전체 Git 이력을 `apps/pi-ollama-cloud`로 편입했습니다. 설치·Git 설치 전환은 [앱 README](apps/pi-ollama-cloud/README.md), 생성 데이터 갱신과 배포는 [유지보수 가이드](apps/pi-ollama-cloud/docs/maintaining.md)를 따릅니다.

공통 CI는 이 앱에 최신 Pi 호환성 검사와 실서비스 검사를 추가로 적용합니다. 실서비스 키는 `OLLAMA_CLOUD_API_KEY`로 등록하며 PR에는 전달하지 않습니다. `pi-ollama-cloud-v*` 배포 태그에서는 키와 실서비스 검증이 필수입니다. 기존 GitHub만 유지보수 종료 대상으로 삼고 npm 패키지는 deprecated 처리하지 않습니다.

## Rules for apps

- Distribute through npm. `pi install git:` installs a repository root, so it cannot install one app from this workspace.
- Declare the Pi host packages (`@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, `typebox`) in `peerDependencies` with `"*"`, and in `devDependencies` with `catalog:`. Never in `dependencies`: a second copy splits Pi's classes and registries.
- Pi loads each installed package with its own module root. A shared package from `packages/` is a separate copy in every app that uses it, so it can hold types, constants, and pure functions, not shared state. Apps that coordinate at runtime do it through `globalThis[Symbol.for(...)]`.
- Pi runs the TypeScript sources directly. The pi-codex family, `pi-redact`, and `redact` are the exception: they publish `tsc` output from `dist/`, so build before type checking, testing, or loading them from source.
- A shared package that an app imports at runtime must be published with it or bundled into it; decide which before adding the first one. `redact` is published on its own and released before the apps that install it.
