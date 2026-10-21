# pi-codex-auto-review

[English](README.md) | **한국어**

Codex의 **Approve for me**에서 영감을 받은 [Pi](https://pi.dev) 실행 승인 검토 확장입니다. 셸·파일·MCP 도구 호출을 로컬 정책으로 판단하고, 승인이 필요한 호출은 모델 자동 검토나 사용자 확인으로 처리합니다. 승인된 호출은 Pi의 원래 실행기를 사용합니다.

**승인을 돕는 확장이며 OS 샌드박스가 아닙니다.** 승인된 명령은 호스트 권한으로 실행합니다. 파일·프로세스·네트워크 접근을 격리하지 않습니다.

아래 빠른 시작은 자동 검토만 설치합니다. Computer Use·Fast 모드·이미지 생성도 함께 설치하려면 [`@buyong/pi-codex` 안내](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex/README.ko.md)를 따르세요. 다른 구성 요소는 [작업 공간 패키지](#작업-공간-패키지)에 있습니다.

## 요구 사항

| 항목 | 필요한 조건 |
| --- | --- |
| Node.js | 22.19 이상 |
| Pi | 1.0.0 이상. 매니페스트의 peer 범위가 더 넓어도 보호 CLI·SDK는 1.0.0 미만의 Pi를 거부합니다. |
| 모델 접근 | 설정된 Pi 공급자와 대화 모델. 별도 검토 모델을 고르지 않으면 대화 모델로 검토합니다. |

규칙 엔진은 TypeScript를 컴파일한 JavaScript이며 Rust 컴파일러나 플랫폼별 규칙 바이너리는 필요하지 않습니다. Pi 자체의 네이티브 의존성은 별개입니다. 자동 검토는 모델을 추가 호출하므로 공급자 사용량이 발생할 수 있습니다.

## 빠른 시작

Pi가 설치된 상태에서 최근 게시된 자동 검토 패키지를 설치하고 세션을 시작합니다.

```sh
pi install npm:@buyong/pi-codex-auto-review
pi list
pi
```

Pi에서 다음 순서로 진행합니다.

1. 필요하면 `/login`으로 공급자 접근을 설정하고 대화 모델을 선택합니다.
2. `/approve`에서 **Approve for me**를 선택합니다.
3. 다음과 같이 요청합니다.

```text
Use bash to run exactly node --version and report the result. Do not install anything or change files.
```

기본 정책에서 이 명령은 승인 검토가 필요합니다. 실행에 성공하면 설치된 Node.js 버전을 보고합니다. 검토가 거부되거나 실패하면 명령을 실행하지 않습니다. 사용자 규칙과 기존 승인은 검토 경로를 바꿀 수 있습니다.

`/approve-model`은 대화 모델을 바꾸지 않고 검토 모델을 선택합니다. 모델 검토 대신 직접 확인하려면 `/approve`에서 **Ask for approval**을 고릅니다.

### 설치 범위와 이전 설치에서 전환

- 프로젝트 범위에 등록하려면 `pi install`에 `--local`을 추가합니다. Pi가 프로젝트를 신뢰한 뒤 패키지를 로드합니다.
- 게시된 릴리스로 고정하려면 npm 이름에 `@<version>`을 붙입니다. 문서는 체크아웃을 설명하며, 게시 버전에는 미게시 변경이 없을 수 있습니다.
- 개별 설치와 `@buyong/pi-codex`를 통해 같은 확장을 함께 켜지 마세요. 중복 등록이 도구·명령·이벤트 처리에 영향을 줄 수 있습니다.
- 이전 이름인 `pi-codex-auto-review`에서 전환할 때는 `pi list`에 표시된 소스를 제거하고 스코프 패키지를 설치합니다. 제거할 때도 같은 전역·`--local` 범위를 사용하세요.

**승인 제어가 로드되지 않으면 실행 시작을 거부해야 하나요?** [보호 CLI·SDK](docs/usage.ko.md#보호가-준비된-상태에서-시작하기)를 사용하세요. Pi 1.3.0은 새 CLI 시작 중 확장 로딩 오류가 나면 종료 코드 1로 끝납니다. 다시 로드와 SDK의 오류 처리는 별개이며, 보호 시작은 실행 전에 제어기 준비 상태까지 확인합니다.

## 승인 방식과 설정

`/approve`는 승인 방식과 확장 전체의 켜기·끄기를 설정합니다. 일반 읽기나 작업 공간 쓰기까지 모두 확인하도록 만들지는 않습니다.

| 선택 | 검토 방식 | 저장 여부 |
| --- | --- | --- |
| **Approve for me** | 모델 자동 검토. 기본값입니다. | 저장 |
| **Ask for approval** | 사용자 확인 | 저장 |
| **Full Access** | 확인 후 승인·경로·명령·네트워크 제한을 건너뜁니다. 보호 경로와 거부 규칙도 포함합니다. | 저장하지 않음. Pi 종료나 다른 승인 방식 선택까지 적용 |
| **Auto Review Off** | 자동 검토·승인 확인·정책 제한을 끄고 Pi의 원래 도구로 실행합니다. | 저장 |

`/approve off`로 확장 전체를 끄고, `/approve on`으로 이전 승인 방식과 검토 모델을 유지한 채 다시 켭니다. `/approve status`는 현재 상태를 표시합니다. 켜기·끄기는 즉시 적용하고 다음 실행에도 유지합니다. 승인 방식을 메뉴에서 선택하면 확장이 다시 켜집니다.

일반 설치도 Off 상태를 포함해 Pi의 유효 `shellPath`·`shellCommandPrefix`·`images.autoResize` 설정을 유지하며, 명시적인 SDK 도구 옵션이 우선합니다. 셸 경로를 지정하지 않으면 Pi가 플랫폼에 맞게 탐색합니다. 초기화는 `--help`용 확장 로딩이 아닌 세션 시작이나 첫 사용 때 수행합니다.

설정은 `<agentDir>/guard/settings.json` 또는 CLI·SDK에서 선택한 정책 파일에 저장합니다. `agentDir`은 보통 `~/.pi/agent`이며 `PI_CODING_AGENT_DIR`을 따릅니다. 선택창을 취소하면 기존 설정을 유지합니다. 명령·선택창·승인 창의 고정 문구는 영어입니다.

모델 범위, 저장 설정과 다시 로드는 [사용법](docs/usage.ko.md#승인-방식과-검토-모델-선택)을 참고하세요. 작업이 거부되면 이유를 읽고 승인을 바꾸거나 [`/approve retry`](docs/usage.ko.md#거부오류재시도)를 사용하세요. 재시도는 자동 승인이 아니라 새 검토를 요청합니다.

## 승인 경계

**확장이 켜져 있고 Full Access가 꺼져 있을 때** 기본 정책은 일반 범위, 검토 가능한 작업과 절대 거부를 구분합니다.

| 대상 | 동작 |
| --- | --- |
| 내장 `powershell` 호출(Windows) | 리터럴 PowerShell 문법으로 `bash`와 같이 보호합니다. 비활성 상태로 등록되므로 Pi의 `defaultTools`나 `--tools`로 켭니다. [Windows와 PowerShell](docs/usage.ko.md#windows와-powershell)을 참고하세요. |
| 일반 작업 공간·임시 디렉터리 쓰기 | `workspace-write`는 허용하고 `read-only`는 검토합니다. |
| 일반 범위 밖이나 프로젝트 `.git`·`.agents`·`.codex`·`.aws`·`.pi` 메타데이터 쓰기 | 무조건 차단하지 않고 검토합니다. |
| 가드 제어 파일·선택한 정책·규칙 파일 | 보호 도구의 읽기·쓰기를 차단합니다. 프로젝트 `.pi/guard`는 쓰기를 차단합니다. |
| 확장 자체 코드·명시적으로 신뢰한 확장의 코드 디렉터리 | 모델 쓰기를 차단합니다. |

절대 거부는 모델 검토와 저장 승인보다 먼저 확인합니다. 검토 오류·시간 초과·취소는 승인으로 처리하지 않습니다. 저장된 정확한 작업 승인은 도구·입력·실행 문맥·정책·요청 범위에 묶입니다. 조건을 충족하는 MCP 도구와 스킬 스크립트는 버전·내용이 그대로일 때 별도의 패키지 승인을 재사용할 수 있습니다.

검토자에게 전달할 증거는 `@buyong/redact`로 가립니다. 사용자 규칙과 선택적 개인정보 탐지도 제공합니다. 가림은 검토자 사본을 보호하며 승인 후 실행할 원래 작업을 바꾸지 않습니다. 파일 조사는 최대 1 MiB의 전체 원문을 경로와 함께 가린 뒤 발췌하며, 더 큰 파일은 거부합니다. 메모리에는 최근 감사 기록 1,000개만 보관하지만 `<agentDir>/guard/audit.jsonl` 파일은 회전 없이 계속 증가합니다. 수동으로 보관하거나 삭제하기 전에 세션을 종료하세요. [정책 설정](docs/usage.ko.md#정책-파일), [승인 재사용](docs/usage.ko.md#정확한-작업에-대한-승인과-실행), [검토자 가림](docs/usage.ko.md#검토자-가림)을 참고하세요.

### 승인이 보장하지 않는 것

- **OS 격리:** 검토 범위는 강제 권한 경계가 아닙니다. 승인된 셸·인터프리터는 파일에 간접 접근하거나 다른 목적지에 연결할 수 있습니다. 네트워크 프록시나 디렉터리·하드링크 전수 검사는 없습니다.
- **신뢰한 코드 전체의 보호:** Pi·로드한 확장·외부 MCP 서버는 신뢰하는 실행 구성 요소입니다. 다른 확장의 도구에 이 승인 제어가 자동 적용되지 않으며 외부 MCP 서버 내부 실행도 격리하지 않습니다.
- **외부 요청의 즉시 취소:** 이미 MCP 서버에 보낸 요청의 중단 효과는 해당 서버 구현에 달려 있습니다.
- **Codex와 같은 보안·판단:** 기준은 Codex [`rust-v0.160.0`](https://github.com/openai/codex/tree/a956835d020762cb2b570053af06f643a11c0ecc)의 공개 정책·규칙 계약이며 독점 모델이나 샌드박스가 아닙니다.
- **설치된 Pi 호스트의 변경:** 저장소 잠금 파일은 별도 호스트의 의존성을 바꾸지 않습니다. [의존성 보안](docs/security/dependencies.ko.md)을 참고하세요.

## 작업 공간 패키지

각 패키지는 [pi-packages](https://github.com/buYoung/pi-packages) 저장소에서 버전과 릴리스를 독립적으로 관리합니다. 필요한 기능에 맞는 패키지를 선택하세요. 통합 설치 후에도 각 구성 요소의 요구 사항은 유지됩니다.

| 패키지 | 용도와 요구 사항 |
| --- | --- |
| `@buyong/pi-codex-auto-review` | 자동 승인 검토. 이 README와 [사용법](docs/usage.ko.md)에서 설명합니다. |
| [`@buyong/pi-codex`](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex/README.ko.md) | 확장 4개와 `imagegen` 스킬. 같은 개별 패키지를 함께 활성화하지 마세요. |
| [`@buyong/pi-codex-computer-use`](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-computer-use/README.ko.md) | 설치된 Codex Desktop 런타임의 Computer Use·Chrome Browser Use. Linux는 미지원입니다. |
| [`@buyong/pi-codex-fast-mode`](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-fast-mode/README.ko.md) | `/codex-fast`로 지원하는 공급자·모델·인증 조합의 Standard·Fast·Ultrafast를 선택하고 `/codex-fast status`로 로컬 진단 확인 |
| [`@buyong/pi-codex-image-gen`](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-image-gen/README.ko.md) | Pi의 `openai-codex` 구독 로그인으로 이미지 생성·편집 |
| [`@buyong/redact`](https://github.com/buYoung/pi-packages/blob/main/packages/redact/README.ko.md) | 자격 증명·개인 키·선택적 개인정보 가림. Pi 확장이 아닌 라이브러리입니다. |

새로 준비한 패키지는 설치 전에 게시를 확인하세요. 로컬 매니페스트 버전만으로 npm에서 사용할 수 있는지 알 수는 없습니다.

## 소스 빌드와 검증

기여자는 [pi-packages](https://github.com/buYoung/pi-packages) 저장소 루트에서 실행합니다.

```sh
pnpm install
pnpm --filter "@buyong/pi-codex-auto-review..." build
pnpm --filter @buyong/pi-codex-auto-review test:unit
```

`build`는 이 패키지가 가져오는 `@buyong/redact`도 함께 빌드합니다. `test:unit`은 현재 OS에서 단위·통합·적합성·실행·종단 간 테스트를 모델·UI 고정 응답으로 실행하며 유료 모델을 호출하지 않습니다. 빌드한 확장 로드는 [소스 설치](docs/usage.ko.md#소스에서-빌드)를 따르세요.

빌드 후 저장소 루트에서 다음 모델 없는 검사를 실행합니다. 설치된 Pi CLI가 필요합니다.

```sh
cd apps/pi-codex-auto-review
pnpm run typecheck
pnpm run lint
pnpm run test:unit
verification_dir="$(mktemp -d)"
PI_CODING_AGENT_DIR="$verification_dir" PI_OFFLINE=1 \
  pi --no-extensions -e "$PWD/dist/index.js" --help
test ! -e "$verification_dir/pi-codex-auto-review.sqlite"
```

예상 결과는 검사 종료 코드 0과 검토 DB를 만들지 않는 도움말 출력입니다. Pi 자체 설정·인증 파일은 임시 디렉터리에 생길 수 있습니다. 도움말 검사는 세션이나 실모델을 실행하지 않습니다.

로컬 통과는 다른 OS나 실모델을 검증하지 않습니다. 이전 [pi-codex-auto-review](https://github.com/buYoung/pi-codex-auto-review) 저장소의 Docker·Windows 검증은 이 저장소에 포함하지 않았으며, 그 기록은 [검증표](docs/testing/auto-review-protection.ko.md)에 남아 있습니다.

## 문서와 문의

- [사용법](docs/usage.ko.md) · [English](docs/usage.md) — 설치, 승인 설정, CLI·SDK, 정책과 검증
- [의존성 보안](docs/security/dependencies.ko.md) · [English](docs/security/dependencies.md) — 기록된 수정과 범위
- [보호 경계 검증](docs/testing/auto-review-protection.ko.md) · [English](docs/testing/auto-review-protection.md) — 현재 검증, 과거 결과와 미검증 경계
- [이슈](https://github.com/buYoung/pi-packages/issues) — 결함 신고와 질문

## 라이선스

[Apache-2.0](LICENSE). Codex 규칙 계약의 TypeScript 이식과 포함된 정책의 출처 표시는 [NOTICE](NOTICE)에 유지합니다.
