# @buyong/pi-codex

[English](README.md) | **한국어**

자동 승인 검토, Computer Use·Browser Use, OpenAI Fast 모드와 이미지 생성을 Pi 패키지 하나로 설치합니다. 원래 확장 4개와 `imagegen` 스킬을 포함하며 각 구성 요소의 명령·설정을 유지합니다.

여러 기능을 함께 쓸 때 통합 패키지를 사용하세요. 하나만 필요하다면 아래 개별 안내를 따릅니다. 별도의 자동화·승인 엔진을 추가하거나 Codex Desktop·계정 접근을 제공하지는 않습니다.

## 설치 전 확인

- Node.js 22.19 이상과 설정된 Pi 대화 공급자·모델
- Pi 1.0.0 이상이 필요합니다. 저장소는 Pi 1.3.0을 기준으로 빌드하고 구성 요소별 검증 범위는 다릅니다. 자동 검토의 보호 CLI·SDK는 1.0.0 미만의 Pi를 거부합니다.
- 아래 기능별 요구 사항. 사용하지 않는 기능은 꺼 둘 수 있습니다.

| 기능 | 추가 요구 사항 | 저장 설정이 없을 때의 초기 상태 |
| --- | --- | --- |
| [자동 검토](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-auto-review/README.ko.md) | 자동 검토용 모델 접근이나 승인 요청에 응답할 사용자 확인 | **Approve for me**. OS 샌드박스가 아닙니다. |
| [Computer Use](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-computer-use/README.ko.md) | 설치된 Codex Desktop 런타임. Chrome에는 확장·네이티브 호스트도 필요합니다. macOS 실기록이 있고 Windows는 미검증, Linux는 미지원입니다. | Computer·Browser 모두 켜짐. Pi 시작 때 런타임 실행을 시도할 수 있습니다. |
| [Fast 모드](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-fast-mode/README.ko.md) | 지원하는 공급자·모델·인증 조합 | Standard. 가속을 선택하지 않은 상태입니다. |
| [이미지 생성](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-image-gen/README.ko.md) | Pi의 `openai-codex` 구독 로그인 | 로그인 없이는 도구·스킬 숨김 |

**통합 패키지와 같은 개별 확장을 함께 활성화하지 마세요.** 도구·명령·이벤트 처리기가 중복 등록될 수 있습니다. 이미 설치했다면 로드 전에 [전환 절차](#개별-패키지에서-전환)를 따르세요.

## 게시된 릴리스 설치

```sh
pi install npm:@buyong/pi-codex
pi list
pi
```

버전을 생략하면 최근 게시된 릴리스를 선택하고, `@<version>`으로 고정할 수 있습니다. 프로젝트 범위에는 `--local`을 추가하며 프로젝트 신뢰가 필요합니다. 체크아웃 버전은 npm 게시의 근거가 아닙니다. 미등록 패키지나 미게시 변경에는 [소스 로드](#소스-빌드와-로드)를 사용하세요.

## 개별 패키지에서 전환

1. `pi list`에서 전역·프로젝트 설정의 겹치는 확장 소스를 확인합니다.
2. `pi remove <source>`로 제거합니다. 프로젝트 항목은 `pi remove --local <source>`를 사용합니다.
3. 원하는 범위에 통합 패키지를 설치하고 Pi를 재시작합니다.

버전 문자열을 추측하지 말고 `pi list`가 보여 준 소스를 사용하세요. 구성 요소의 설정 경로는 바뀌지 않으므로 기존 선택을 전환 후에도 사용할 수 있습니다.

## 기능 작업 전에 준비 상태 확인

Pi에서 필요하면 `/login`으로 대화 접근을 설정합니다. `/approve`에서 **Approve for me**나 **Ask for approval**을 선택하고, 범위를 제한한 승인 검토를 다음과 같이 요청합니다.

```text
Use bash to run exactly node --version and report the result. Do not install anything or change files.
```

기본 정책에서 명령은 검토가 필요합니다. 실행에 성공하면 설치된 Node.js 버전을 보고합니다. 사용자 규칙·저장 승인은 경로를 바꿀 수 있습니다. 자동 검토는 모델을 추가 호출합니다.

다른 기능은 각각 설정합니다.

| 목표 | 진입점 | 확인할 결과 |
| --- | --- | --- |
| 앱·Chrome 조작 | `/computer-use-check`, 그다음 `/computer-use` | 누락된 요구 사항을 해결하고 필요한 기능을 켭니다. 연결된 런타임이 `mcp__cua_repl__js`를 제공하며 앱·출처 접근은 런타임 승인을 따릅니다. |
| 더 빠른 서비스 등급 요청 | `/codex-fast`, 그다음 `/codex-fast status` | 선택한 등급과 로컬 적용 여부를 함께 확인합니다. 마지막 주입 기록은 실제 서버 처리·과금의 확인이 아닙니다. |
| 이미지 생성 | `/login openai-codex`, 그다음 `/codex-imagen` | 로그인하고 이미지 모델을 선택한 뒤 `image_gen` 사용을 요청합니다. 결과에 이미지를 포함하며 저장은 실패할 수 있습니다. |

Computer Use를 쓰지 않으면 두 기능을 모두 끕니다. 서비스 등급·이미지 모델 선택은 대화 모델을 바꾸지 않지만, 등급 적용은 그 모델의 호환 조건을 따릅니다. 기존 저장 선택은 위 표의 초기 상태보다 우선합니다.

개별 안내는 `/approve-model`·`/approve retry`, Fast 모드의 통합 명령, 설정 파일과 실패 처리도 설명합니다. 앱의 영구 권한을 주거나 유료 서비스 등급을 쓰기 전에 확인하세요.

## 보호 시작은 별도 선택

일반 Pi 확장 탐색은 확장 로딩 실패 후에도 계속할 수 있습니다. 통합 패키지 설치만으로 승인 제어가 준비된 시작을 **보장하지는 않습니다.**

그 보장이 필요하면 [자동 검토 CLI·SDK](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-auto-review/docs/usage.ko.md#보호가-준비된-상태에서-시작하기)를 사용합니다. 추가 구성 요소는 명시적으로 로드하고 자동 검토 확장을 중복 로드하지 마세요. 승인된 명령은 여전히 호스트 권한으로 실행하며 OS 샌드박스가 아닙니다.

## 소스 빌드와 로드

[pi-packages](https://github.com/buYoung/pi-packages) 저장소 루트에서 실행합니다.

```sh
pnpm install
pnpm --filter "@buyong/pi-codex..." build
pnpm --filter @buyong/pi-codex-auto-review exec pi -ne -e ../pi-codex
```

구성 요소를 먼저 빌드하고 게시 파일·런타임 의존성을 통합 패키지 안에 준비합니다. `-ne`는 자동 확장 탐색을 끄고 `-e`는 영구 항목 없이 이번 실행에 로드합니다. Desktop 준비와 구독 로그인은 그대로 필요합니다.

구성 요소를 바꾼 뒤 다시 빌드하세요. 개별 소스 디렉터리가 아니라 내부에 준비한 복사본을 로드합니다.

## 내용과 릴리스 순서

매니페스트는 확장 4개를 `workspace:*` 의존성으로 적고 `bundleDependencies`로 포장하며, 포장할 때 작업 공간의 버전을 기록합니다. `pi.extensions`·`pi.skills`는 원래 진입점·스킬 디렉터리를 가리킵니다. 개발 의존성, Pi 호스트와 Codex 비공개 런타임은 제외합니다.

바뀐 구성 요소를 먼저 릴리스한 뒤 통합 패키지를 릴리스하세요. 통합 패키지는 자신의 릴리스 태그 시점에 이 저장소의 구성 요소를 포장하므로, 릴리스하지 않은 변경도 해당 구성 요소의 현재 버전으로 함께 포함됩니다. 릴리스와 패키지별 Trusted Publishing은 [저장소 배포 절차](https://github.com/buYoung/pi-packages#공통-ci와-패키지별-배포)를 참고하세요.

## 라이선스

[Apache-2.0](LICENSE). npm 압축 파일에 `LICENSE`로 포함하며 의존성은 각 라이선스·출처 표시를 유지합니다.
