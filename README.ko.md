# pi-packages

[English](README.md) | **한국어**

[Pi 코딩 에이전트](https://pi.dev)용 확장과, 그중 세 확장이 쓰는 가림 라이브러리를 하나의 Turborepo 작업 공간에서 개발합니다. 패키지마다 따로 설치하고 버전을 매기고 배포합니다. Pi 사용자는 아래에서 패키지를 고르고, 기여자는 [개발](#개발)부터 보세요.

## 패키지 고르기

아래 앱은 Pi에 설치합니다. 요구 사항, 설정, 첫 사용 방법은 각 README에 있습니다.

| 패키지 | npm 이름 | 설명 |
| --- | --- | --- |
| [`apps/pi-claude-bridge`](apps/pi-claude-bridge) | `@buyong/pi-claude-bridge` | Claude Code와 Agent SDK를 통해 Pi에서 Claude 모델 사용 |
| [`apps/pi-devin`](apps/pi-devin) | `@buyong/pi-devin` | Devin 계정으로 Devin 모델을 쓰는 비공식 공급자 |
| [`apps/pi-ollama-cloud`](apps/pi-ollama-cloud) | `@buyong/pi-ollama-cloud` | Ollama Cloud 공급자, 웹 도구, 사용량 조회 |
| [`apps/pi-codex`](apps/pi-codex) | `@buyong/pi-codex` | 아래 Codex 확장 5개와 `imagegen` 스킬을 묶은 통합 패키지 |
| [`apps/pi-codex-auto-review`](apps/pi-codex-auto-review) | `@buyong/pi-codex-auto-review` | Codex의 "Approve for me"를 참고한 실행 승인 검토 |
| [`apps/pi-codex-computer-use`](apps/pi-codex-computer-use) | `@buyong/pi-codex-computer-use` | Codex Desktop 런타임을 통한 Codex Computer Use·Browser Use |
| [`apps/pi-codex-fast-mode`](apps/pi-codex-fast-mode) | `@buyong/pi-codex-fast-mode` | OpenAI Fast·Ultrafast 서비스 등급 |
| [`apps/pi-codex-image-gen`](apps/pi-codex-image-gen) | `@buyong/pi-codex-image-gen` | Codex 호환 `image_gen` 도구와 `imagegen` 스킬 |
| [`apps/pi-codex-memory`](apps/pi-codex-memory) | `@buyong/pi-codex-memory` | Codex memory v2 추출·통합·조회와 `/codex-memory` 관리(Pi 1.4.0+) |
| [`apps/pi-redact`](apps/pi-redact) | `@buyong/pi-redact` | 도구 결과와 모든 모델 요청의 인증 정보를 언어 모델로 보내기 전에 가림 |

새 메모리 패키지는 소스 체크아웃에서 사용할 수 있으며 npm 게시 여부는 확인하지 않았습니다. 로컬 설치는 해당 README를 따르세요.

게시된 앱은 npm 이름으로 설치합니다. 예:

```sh
pi install npm:@buyong/pi-codex
```

`pi install git:`은 저장소 루트를 설치하므로, 이 작업 공간의 앱 하나만 설치할 수는 없습니다.

공용 패키지는 Pi 패키지가 아니므로 `pi install`로 설치하지 마세요.

| 패키지 | npm 이름 | 설명 |
| --- | --- | --- |
| [`packages/redact`](packages/redact) | `@buyong/redact` | Node.js 코드에서 인증 정보·개인 키와 선택한 개인정보(PII)를 가리는 라이브러리. `pi-codex-auto-review`, `pi-codex-memory`, `pi-redact`가 의존 |
| [`packages/typescript-config`](packages/typescript-config) | 게시하지 않음 | 이 작업 공간의 공용 `tsconfig` 기본 설정 |

## 저장소 구성

| 폴더 | 내용 | npm 게시 |
| --- | --- | --- |
| `apps/` | 사용자가 Pi에 설치하는 Pi 패키지 | 패키지마다 독립 버전으로 게시 |
| `packages/` | 앱들이 함께 쓰는 코드와 설정 | 앱이 런타임에 npm에서 설치하는 패키지만 게시(현재 `redact`) |

## 개발

Node.js 22.19 이상과 pnpm 10이 필요합니다. 컴파일한 `dist/`를 배포하는 패키지(pi-codex 계열, `pi-redact`, `redact`)는 테스트하거나 소스에서 로드하기 전에 빌드해야 합니다.

```bash
pnpm install
pnpm check                          # typecheck and lint every package, cached by Turborepo
pnpm build                          # compile the packages that ship dist/ (pi-codex family, pi-redact, redact)
pnpm --filter @buyong/pi-ollama-cloud typecheck
pi -e ./apps/pi-ollama-cloud        # load an app in Pi for one session
```

`pnpm check`는 패키지를 검사하기 전에, 타입 검사에 필요한 작업 공간 의존성을 먼저 빌드합니다. 패키지 하나의 스크립트를 직접 실행할 때는 `pnpm --filter "<패키지>..." build`로 그 패키지와 작업 공간 의존성을 먼저 빌드합니다. 예를 들어 `pi-codex-auto-review`와 `pi-redact`의 타입 검사와 테스트는 빌드한 `@buyong/redact`를 씁니다. 공통 CI도 타입 검사 전에 같은 빌드를 실행합니다.

## 공통 CI와 패키지별 배포

`.github/workflows/pi-packages.yml` 하나가 공개 패키지의 CI와 npm 배포를 맡습니다. 공개 패키지는 `pi` 매니페스트가 있고 `private`이 아닌 `apps/*` 패키지와, `private`이 아닌 `packages/*` 패키지(현재 `redact`)입니다. PR과 `main` push에서는 변경된 공개 패키지마다 타입 검사, 선언된 린트·단위 테스트, 패키징을 실행합니다. 잠금 파일·catalog·공용 코드·공통 검사 설정·workflow가 바뀌면 모든 공개 패키지를 검증합니다. 수동 실행은 검증만 하고 배포하지 않습니다.

### 배포 전 확인

- `origin/main`과 연결된 `main` 브랜치에서, Git이 추적하는 파일과 index에 변경 사항이 없는 상태로 배포합니다.
- 패키지의 `package.json`에 이 저장소를 가리키는 `repository.url`이 있어야 하고, npm Trusted Publisher가 `buYoung/pi-packages`와 workflow 파일명 `pi-packages.yml`로 설정되어 있어야 합니다.
- 의존하는 패키지를 먼저 배포합니다. `@buyong/redact`는 `@buyong/pi-codex-auto-review`·`@buyong/pi-redact`보다, 바뀐 Codex 구성 요소는 `@buyong/pi-codex`보다 먼저 배포합니다([Codex 패키지 유지보수](#codex-패키지-유지보수) 참고).
- 빠진 변경 이력 항목의 초안을 만들려면 `pnpm release`에 로그인된 Claude Code의 `claude` CLI가 필요합니다. CLI가 없거나 초안 작성에 실패하면 두 변경 이력 파일을 그대로 두며, 미배포 절의 짝이 이미 맞을 때만 배포를 이어 갈 수 있습니다(2단계 참고).

### `pnpm release`로 배포

1. 저장소 루트에서 `pnpm release`를 실행하고 패키지 하나를 고릅니다.
2. `claude -p`(Sonnet, medium effort)가 그 패키지의 지난 배포 태그 이후 커밋으로 변경 이력 초안을 만듭니다. 확인하면 `CHANGELOG.md`(영문)와 `CHANGELOG.ko.md`(한글)의 미배포 절에 기록합니다. 이미 있는 항목은 그대로 두고 빠진 변경만 더합니다. 두 미배포 절의 짝이 맞아야 버전을 고를 수 있습니다. 모든 항목이 `### New`, `### Improved`, `### Fixed`, `### Removed`(한국어 파일은 `### 새로워진 것`, `### 달라진 것`, `### 해결된 것`, `### 제거된 것`) 아래에 있고, 두 파일의 하위 절 구성과 절마다의 항목 수가 같아야 합니다.
3. 버전을 고른 뒤 커밋·태그·push를 하나씩 확인합니다. 거절하거나 취소하면 이후 단계는 멈추고, 이미 바뀐 로컬 상태는 남습니다.

코딩 에이전트처럼 터미널 없이 실행하는 경우에는 `pnpm release:dry-run --app <폴더명> --version <버전|patch|minor|…>`으로 같은 계획을 미리 확인합니다. 폴더명에는 `pi-codex`, `redact`처럼 경로의 마지막 부분만 넣습니다. 파일·Git·원격을 바꾸지 않고, 준비 여부(`ready`)와 차단 사유(`blockers`), 실행될 커밋·태그·push 명령을 JSON으로 출력합니다. `--checks`를 붙이면 패키지의 배포 전 검사도 실행합니다. 공통 흐름은 `scripts/release/`에, 패키지별 설정은 각 패키지의 `.release-it.json`에 있습니다.

### 배포 태그가 하는 일

`<폴더명>-v<버전>` 태그를 push하면 그 패키지 하나만 검증·패키징·배포합니다. 태그 이름에 폴더명을 쓰므로 `apps/`와 `packages/`의 폴더명은 서로 겹치면 안 됩니다. 다른 공개 패키지를 `workspace:` 의존성으로 설치하거나 묶는 앱은 그 패키지가 바뀔 때 함께 검사합니다. 배포하려면 태그와 일치하는 버전, `CHANGELOG.md`와 `CHANGELOG.ko.md`의 해당 버전 항목(GitHub Release 본문에 두 언어가 함께 들어감), 위에서 설명한 `repository.url`과 Trusted Publisher가 필요합니다.

## Codex 패키지 유지보수

`@buyong/pi-codex`, `@buyong/pi-codex-auto-review`, `@buyong/pi-codex-computer-use`, `@buyong/pi-codex-fast-mode`, `@buyong/pi-codex-image-gen`, `@buyong/redact`는 기존 npm 이름과 독립 버전을 유지합니다. `buYoung/pi-codex-auto-review`의 파일을 Git 이력 없이 옮겨 왔으며, 패키지마다 Apache-2.0 라이선스와 NOTICE를 그대로 둡니다.

- 이 패키지들은 TypeScript를 `tsc`로 `dist/`에 컴파일해 배포합니다. 빌드 순서는 [개발](#개발)에 있습니다.
- `@buyong/pi-codex-auto-review`와 `@buyong/pi-redact`는 `@buyong/redact`를 npm에서 설치합니다. `redact`의 새 버전을 먼저 배포하세요. 그 버전이 npm에 없으면 `pnpm release`와 dry-run이 멈춥니다.
- `@buyong/pi-codex`는 구성 확장 5개를 `bundleDependencies`로 묶으며, `pi-codex` 배포 태그 시점의 작업 공간 코드를 넣습니다. 바뀐 구성 요소를 먼저 배포한 뒤 통합 패키지를 배포하세요. pnpm은 hoisted 연결에서만 `bundleDependencies`를 포장하므로, 공통 CI는 이 패키지만 `pnpm pack --config.node-linker=hoisted`로 포장합니다.
- 이전 저장소에서 등록한 npm Trusted Publisher는 `buYoung/pi-codex-auto-review`와 `npm-package.yml`을 가리킵니다. 이 저장소에서 처음 배포하기 전에 패키지마다 `buYoung/pi-packages`와 `pi-packages.yml`로 바꾸세요.
- `pi-codex-auto-review`의 Docker·Windows 검증과 증거 저장 스크립트는 이전 저장소(`buYoung/pi-codex-auto-review`)에 남아 있습니다. 이 저장소의 `test:unit`은 현재 OS의 단위·통합 검증만 다룹니다. 단계별 검증 기록은 저장소 루트 [`docs/verification/`](docs/verification)의 `auto-review`, `computer-use`, `image-gen`, `pi-guard`, `reviewer-redact` 폴더에 있습니다.

## pi-claude-bridge 유지보수

`@buyong/pi-claude-bridge`(`apps/pi-claude-bridge`)는 기존 npm 이름과 독립 버전을 유지합니다. upstream remote나 자동 동기화는 설정하지 않습니다. 원본 변경이 필요하면 [upstream 갱신 가이드](apps/pi-claude-bridge/docs/upstream.md)를 따라 직접 가져옵니다.

## pi-ollama-cloud 유지보수

`@buyong/pi-ollama-cloud`도 기존 npm 이름과 독립 버전을 유지합니다. `buYoung/pi-ollama-cloud`의 전체 Git 이력을 `apps/pi-ollama-cloud`로 편입했습니다. 설치와 Git 설치 전환은 [앱 README](apps/pi-ollama-cloud/README.ko.md)를, 생성 데이터 갱신과 배포는 [유지보수 가이드](apps/pi-ollama-cloud/docs/maintaining.md)를 따릅니다.

공통 CI는 이 앱에 최신 Pi 호환성 검사와 실서비스 검사를 더 실행합니다. 실서비스 키는 `OLLAMA_CLOUD_API_KEY`로 등록하며 PR에는 전달하지 않습니다. `pi-ollama-cloud-v*` 배포 태그에서는 키와 실서비스 검사가 필수입니다. 이전 단독 GitHub 저장소(`buYoung/pi-ollama-cloud`)만 유지보수를 종료하며, npm 패키지는 deprecated 처리하지 않습니다.

## 앱 작성 규칙

- npm으로 배포합니다. `pi install git:`으로는 이 작업 공간의 앱 하나를 설치할 수 없습니다([패키지 고르기](#패키지-고르기) 참고).
- Pi 호스트 패키지(`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`)는 `peerDependencies`에 `"*"`로, `devDependencies`에 `catalog:`로 선언합니다. `dependencies`에는 절대 넣지 마세요. 사본이 하나 더 생기면 Pi의 클래스와 레지스트리가 나뉩니다.
- Pi는 설치한 패키지마다 별도의 모듈 루트로 로드합니다. `packages/`의 공용 패키지는 사용하는 앱마다 따로 복사되므로 타입·상수·순수 함수는 담을 수 있지만 공유 상태는 담을 수 없습니다. 런타임에 서로 조율해야 하는 앱은 `globalThis[Symbol.for(...)]`를 씁니다.
- Pi는 TypeScript 소스를 직접 실행합니다. 예외는 pi-codex 계열, `pi-redact`, `redact`로, `dist/`의 `tsc` 출력을 배포합니다(빌드 방법은 [개발](#개발) 참고).
- 앱이 런타임에 import하는 공용 패키지는 npm에 따로 게시하거나 앱의 압축 파일에 묶어야 합니다. 새 공용 패키지를 추가할 때 어느 쪽으로 할지 먼저 정하세요. `redact`는 따로 게시하며, 이를 설치하는 앱보다 먼저 배포합니다.

## 라이선스

저장소 루트는 MIT License([`LICENSE`](LICENSE))를 따릅니다. 패키지마다 자체 `LICENSE`가 있고, 일부에는 `NOTICE`도 있습니다.

- MIT: `pi-claude-bridge`, `pi-devin`, `pi-ollama-cloud`, `typescript-config`
- Apache-2.0: `pi-codex`, `pi-codex-auto-review`, `pi-codex-computer-use`, `pi-codex-fast-mode`, `pi-codex-image-gen`, `pi-codex-memory`, `pi-redact`, `redact`
