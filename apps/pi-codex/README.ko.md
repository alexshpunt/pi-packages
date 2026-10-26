# @buyong/pi-codex

[English](README.md) | **한국어**

자동 승인 검토, Computer Use·Browser Use, OpenAI Fast 모드, 이미지 생성과 memory v2를 Pi 패키지 하나로 설치합니다. 개별 Codex 확장 5개(`@buyong/pi-codex-auto-review`, `@buyong/pi-codex-computer-use`, `@buyong/pi-codex-fast-mode`, `@buyong/pi-codex-image-gen`, `@buyong/pi-codex-memory`)와 `imagegen` 스킬을 포함하며, 각 구성 요소의 명령과 설정을 그대로 유지합니다.

여러 기능을 함께 쓸 때 통합 패키지를 사용하세요. 하나만 필요하다면 아래 개별 안내를 따릅니다. 별도의 자동화·승인 엔진을 추가하거나 Codex Desktop·계정 접근을 제공하지는 않습니다.

## 설치 전 확인

- Node.js 22.19 이상과 설정된 Pi 대화 공급자·모델
- 전체 번들은 Pi 1.4.0 이상이 필요합니다. 메모리는 1.4.0 API를 사용하며 다른 구성 요소의 호환성 기준은 그대로 유지합니다.
- 아래 표의 기능별 요구 사항(사용하지 않는 기능은 꺼 둘 수 있음)

| 기능 | 추가 요구 사항 | 저장 설정이 없을 때의 초기 상태 |
| --- | --- | --- |
| [자동 검토](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-auto-review/README.ko.md) | 자동 검토에 쓸 모델 접근. 또는 승인이 필요한 호출을 사용자가 직접 확인 | **Approve for me**. OS 샌드박스가 아닙니다. |
| [Computer Use](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-computer-use/README.ko.md) | 설치된 Codex Desktop 런타임. Chrome의 Browser Use에는 ChatGPT Chrome 확장과 네이티브 메시징 호스트도 필요합니다. macOS에서 실제로 확인했고 Windows는 미검증, Linux는 미지원입니다. | Computer Use·Browser Use 모두 켜져 있어 확장이 Desktop 런타임을 시작할 수 있습니다. `/computer-use`에서 끌 수 있습니다. |
| [Fast 모드](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-fast-mode/README.ko.md) | Fast 모드 허용 목록에 있는 `openai`·`openai-codex` 모델. Ultrafast에는 인증·엔드포인트 조건이 더 있습니다. | Standard. 가속을 선택하지 않은 상태입니다. |
| [이미지 생성](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-image-gen/README.ko.md) | Pi의 `openai-codex` 구독 로그인 | 로그인 없이는 도구·스킬 숨김 |
| [Memory v2](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-memory/README.ko.md) | Pi 1.4.0, 사용자가 선택한 추출·통합 모델 | 저장소별 조회, 같은 저장소의 worktree끼리 공유. `/codex-memory`에서 켜기 전까지 자동 생성은 꺼짐 |

**통합 패키지와, 그 안에 들어 있는 개별 확장을 함께 활성화하지 마세요.** 도구·명령·이벤트 처리기가 중복 등록될 수 있습니다. 개별 확장을 이미 설치했다면 통합 패키지를 로드하기 전에 [전환 절차](#개별-패키지에서-전환)를 따르세요.

## 게시된 릴리스 설치

```sh
pi install npm:@buyong/pi-codex
pi list
pi
```

`pi list`는 `User packages:` 아래에 `npm:@buyong/pi-codex`와 설치 경로를 표시합니다. 이어서 `pi`로 통합 패키지를 로드한 세션을 시작하고 [기능 작업 전에 준비 상태 확인](#기능-작업-전에-준비-상태-확인)으로 넘어갑니다.

버전을 생략하면 최근 게시된 릴리스를 설치하고, `@<version>`을 붙이면 그 버전으로 고정합니다. 현재 프로젝트에만 설치하려면 `--local`을 붙입니다(`pi install --local npm:@buyong/pi-codex`). 이 경우 프로젝트 신뢰가 필요하며, `pi list`는 이 항목을 `Project packages:` 아래에 표시합니다. 저장소 체크아웃의 버전은 아직 npm에 없을 수 있습니다. 게시하지 않은 변경을 실행하려면 [소스에서 빌드해 로드](#소스-빌드와-로드)하세요.

## 개별 패키지에서 전환

1. `pi list`를 실행해 전역·프로젝트 설정에 위의 개별 패키지 5개가 있는지 확인합니다.
2. `pi remove <source>`로 제거합니다. 프로젝트 항목은 `pi remove --local <source>`를 사용합니다.
3. 원하는 범위에 통합 패키지를 설치하고 Pi를 재시작합니다.

버전 문자열을 추측하지 말고 `pi list`가 보여 준 소스를 사용하세요. 구성 요소의 설정 경로는 바뀌지 않으므로 기존 선택을 전환 후에도 사용할 수 있습니다.

## 기능 작업 전에 준비 상태 확인

Pi에서 필요하면 `/login`으로 대화 접근을 설정합니다. `/approve`에서 **Approve for me**나 **Ask for approval**을 선택하고, 범위를 제한한 승인 검토를 다음과 같이 요청합니다.

```text
Use bash to run exactly node --version and report the result. Do not install anything or change files.
```

기본 정책에서 이 명령은 검토 대상이며, 실행에 성공하면 설치된 Node.js 버전을 알려 줍니다. 사용자 규칙이나 저장된 승인이 있으면 처리 경로가 달라질 수 있습니다. 자동 검토는 모델을 추가로 호출합니다.

다른 기능은 각각 설정합니다.

| 목표 | 진입점 | 할 일과 확인할 결과 |
| --- | --- | --- |
| 앱·Chrome 조작 | `/computer-use-check`, 그다음 `/computer-use` | 누락된 요구 사항을 해결하고 Computer Use, Browser Use, 둘 다 중 필요한 기능만 켜 둡니다(처음에는 둘 다 켜져 있음). 연결된 런타임이 `mcp__cua_repl__js`를 제공하며 앱·출처 접근은 런타임 승인을 따릅니다. |
| 더 빠른 서비스 등급 요청 | `/codex-fast`, 그다음 `/codex-fast status` | 등급을 선택한 뒤, 선택한 등급이 현재 모델에 적용되는지를 함께 확인합니다. 상태에 표시되는 마지막 요청의 등급은 서버가 실제로 그 등급으로 처리하거나 과금했다는 뜻이 아닙니다. |
| 이미지 생성 | `/login openai-codex`, 그다음 `/codex-imagen` | 로그인하고 이미지 모델을 선택한 뒤 `image_gen` 사용을 요청합니다. 결과에 이미지가 들어 있습니다. 확장은 `<agentDir>/generated_images/` 아래에 PNG 저장도 시도하며, 저장에 실패해도 결과의 이미지는 남습니다. |

Computer Use를 쓰지 않으면 `/computer-use`에서 Computer Use와 Browser Use를 모두 끄세요. 서비스 등급이나 이미지 모델을 선택해도 대화 모델은 바뀌지 않으며, 등급 적용은 대화 모델의 호환 조건을 따릅니다. 기존에 저장된 선택은 [설치 전 확인](#설치-전-확인) 표의 초기 상태보다 우선합니다.

`/codex-memory`에서 기억, 추출·통합 모델, 호출 예산과 자동 생성을 관리합니다. `/codex-memory status`는 모델을 호출하지 않습니다. `repositories`에서 다른 저장소의 읽기 확인·연결을, `legacy`에서 기존 cwd 기억의 선택적 가져오기를 관리하며 자동으로 범위를 합치지 않습니다. 생성을 켜면 마스킹한 대화 사본을 선택한 공급자에게 전송하고 요금이나 구독 한도를 사용합니다.

개별 안내는 `/approve-model`·`/approve retry`, `/codex-fast` 하위 명령, 설정 파일과 실패 처리도 설명합니다. 앱의 영구 권한을 주거나 유료 서비스 등급을 쓰기 전에 확인하세요.

## 보호 시작은 별도 선택

일반 Pi 확장 탐색은 확장 로딩 실패 후에도 계속할 수 있습니다. 통합 패키지 설치만으로 승인 제어가 준비된 시작을 **보장하지는 않습니다.**

그 보장이 필요하면 [자동 검토의 보호 CLI·SDK](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-auto-review/docs/usage.ko.md#보호가-준비된-상태에서-시작하기)를 사용합니다. 이 진입점은 자동 검토를 이미 포함하고 확장 자동 탐색을 끕니다. 필요한 다른 구성 요소는 `--extension` 옵션(SDK는 `trustedExtensionPaths`)으로 하나씩 로드하세요. 통합 패키지 안의 구성 요소 진입 파일을 넘기며, 예를 들면 `<통합 패키지 경로>/node_modules/@buyong/pi-codex-fast-mode/dist/index.js`입니다. 통합 패키지 경로는 `pi list`에 나옵니다. 통합 패키지 전체를 넘기면 자동 검토 확장이 한 번 더 로드됩니다. 승인된 명령은 여전히 호스트 권한으로 실행하며 OS 샌드박스가 아닙니다.

## 소스 빌드와 로드

[pi-packages](https://github.com/buYoung/pi-packages) 저장소 루트에서 실행합니다.

```sh
pnpm install
pnpm --filter "@buyong/pi-codex..." build
pi -ne -e ./apps/pi-codex
```

구성 요소를 먼저 빌드하고 게시 파일·런타임 의존성을 통합 패키지 안에 준비합니다. `-ne`는 자동 확장 탐색을 끄고, `-e`는 Pi 설정에 저장하지 않고 이번 실행에만 이 패키지를 로드합니다. Desktop 준비와 구독 로그인은 그대로 필요합니다.

구성 요소를 바꾼 뒤 다시 빌드하세요. 개별 소스 디렉터리가 아니라 내부에 준비한 복사본을 로드합니다.

## 패키지 구성과 릴리스 순서(관리자용)

매니페스트는 확장 5개를 `workspace:*` 의존성으로 적고 `bundleDependencies`로 포장하며, 포장할 때 작업 공간의 버전을 기록합니다. `pi.extensions`·`pi.skills`는 원래 진입점·스킬 디렉터리를 가리킵니다. 개발 의존성, Pi 호스트와 Codex 비공개 런타임은 제외합니다.

바뀐 구성 요소를 먼저 릴리스한 뒤 통합 패키지를 릴리스하세요. 통합 패키지는 그 릴리스 태그 시점의 구성 요소 코드를 그대로 포장합니다. 구성 요소를 먼저 릴리스하지 않으면, 아직 릴리스하지 않은 변경이 그 구성 요소의 현재 버전 번호를 단 채 통합 패키지에 들어갑니다. 릴리스와 패키지별 Trusted Publishing은 [저장소 배포 절차](https://github.com/buYoung/pi-packages/blob/main/README.ko.md#공통-ci와-패키지별-배포)를 참고하세요.

## 라이선스

[Apache-2.0](LICENSE). npm 압축 파일에 `LICENSE`로 포함하며 의존성은 각 라이선스·출처 표시를 유지합니다.
