# pi-codex-auto-review

[English](README.md) | **한국어**

Codex의 **Approve for me**에서 영감을 받은 [Pi](https://pi.dev) 실행 승인 검토 확장입니다. 이 확장은 셸·파일·MCP 도구 호출을 로컬 정책으로 판단합니다. 승인이 필요한 호출은 모델 자동 검토와 사용자 확인 중 고른 방식으로 처리합니다. 승인된 호출은 Pi의 원래 실행기를 사용합니다.

**승인을 돕는 확장이며 OS 샌드박스가 아닙니다.** Pi는 승인된 명령을 호스트 권한으로 실행합니다. 파일·프로세스·네트워크 접근을 격리하지 않습니다.

아래 빠른 시작은 자동 검토만 설치합니다. Computer Use·Fast 모드·이미지 생성도 함께 설치하려면 [`@buyong/pi-codex` 안내](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex/README.ko.md)를 따르세요. 같은 저장소의 다른 패키지는 [pi-packages README](https://github.com/buYoung/pi-packages/blob/main/README.ko.md#패키지-고르기)에 있습니다.

## 요구 사항

| 항목 | 필요한 조건 |
| --- | --- |
| Node.js | 22.19 이상 |
| Pi | 1.0.0 이상. [보호 CLI·SDK](docs/usage.ko.md#보호가-준비된-상태에서-시작하기)는 그보다 낮은 버전에서 시작을 거부합니다. |
| 모델 접근 | 설정된 Pi 공급자와 대화 모델. 별도 검토 모델을 고르지 않으면 대화 모델로 검토합니다. |

규칙 엔진에는 Rust 컴파일러나 플랫폼별 규칙 바이너리가 필요하지 않습니다. 자동 검토는 모델을 추가 호출하므로 공급자 사용량이 발생할 수 있습니다.

## 빠른 시작

설치하기 전에 두 가지를 확인하세요.

- 개별 설치와 `@buyong/pi-codex`를 통해 같은 확장을 함께 켜지 마세요. 중복 등록이 도구·명령·이벤트 처리에 영향을 줄 수 있습니다.
- 이전 이름인 `pi-codex-auto-review`가 설치되어 있다면 `pi list`에 표시된 소스를 같은 전역·`--local` 범위에서 먼저 제거하세요.

Pi가 설치된 상태에서 최근 게시된 자동 검토 패키지를 설치하고 세션을 시작하세요.

```sh
pi install npm:@buyong/pi-codex-auto-review
pi list
pi
```

`pi list`는 `User packages:` 아래에 `npm:@buyong/pi-codex-auto-review`와 설치 경로를 표시합니다.

Pi에서 다음 순서로 실행하세요.

1. 필요하면 `/login`으로 공급자 접근을 설정하고 대화 모델을 선택하세요.
2. `/approve`에서 **Approve for me**를 선택하세요.
3. 다음과 같이 요청하세요.

```text
Use bash to run exactly node --version and report the result. Do not install anything or change files.
```

기본 정책에서 이 명령은 승인 검토가 필요합니다. 실행에 성공하면 설치된 Node.js 버전을 보고합니다. 검토가 거부되거나 실패하면 명령을 실행하지 않습니다. 사용자 규칙과 기존 승인은 검토 경로를 바꿀 수 있습니다.

`/approve-model`은 대화 모델을 바꾸지 않고 검토 모델을 선택합니다. 모델 검토 대신 직접 확인하려면 `/approve`에서 **Ask for approval**을 고르세요.

### 설치 범위와 버전

- 프로젝트 범위에 등록하려면 `pi install`에 `--local`을 추가하세요. 프로젝트를 신뢰한다고 승인해야 Pi가 그 프로젝트의 패키지를 로드합니다.
- 게시된 릴리스로 고정하려면 npm 이름에 `@<version>`을 붙이세요. 이 문서는 현재 소스를 기준으로 합니다. 게시된 버전에는 최근 소스 변경이 아직 들어 있지 않을 수 있습니다.

**승인 제어를 로드하지 못했을 때 시작 자체를 막으려면** [보호 CLI·SDK](docs/usage.ko.md#보호가-준비된-상태에서-시작하기)를 사용하세요. 보호 시작은 실행 전에 승인 제어가 준비됐는지도 확인합니다. Pi 1.4.0은 새 CLI 시작 중 확장 로딩 오류가 나면 종료 코드 1로 끝내지만, 다시 로드와 SDK 로딩의 오류 처리는 별개입니다.

## 승인 방식과 설정

`/approve`는 승인 방식과 확장 전체의 켜기·끄기를 설정합니다. 일반 읽기나 작업 공간 쓰기까지 모두 확인하도록 만들지는 않습니다.

| 선택 | 검토 방식 | 저장 여부 |
| --- | --- | --- |
| **Approve for me** | 모델 자동 검토(기본값) | 저장 |
| **Ask for approval** | 사용자 확인 | 저장 |
| **Full Access** | 확인 후 승인과 모든 경로·명령·네트워크 제한을 건너뜀. 보호 경로와 거부 규칙도 포함 | 저장하지 않음. Pi 종료나 다른 승인 방식 선택까지 적용 |
| **Auto Review Off** | 자동 검토·승인 확인·정책 제한을 끄고 Pi의 원래 도구로 실행 | 저장 |

- `/approve off`는 확장 전체를 끕니다.
- `/approve on`은 이전 승인 방식과 검토 모델로 확장을 다시 켭니다.
- `/approve status`는 현재 상태를 표시합니다.

켜기·끄기는 즉시 적용되고 다음 실행에도 유지됩니다. `/approve`에서 **Approve for me**, **Ask for approval**, 확인을 마친 **Full Access**를 고르면 확장도 다시 켜집니다. 검토 캐시 만료 시간이나 검토 모델만 바꾸면 꺼진 상태를 유지합니다.

설정은 `<agentDir>/guard/settings.json` 또는 CLI `--policy` 옵션이나 SDK `settingsPath` 옵션으로 지정한 정책 파일에 저장합니다. `agentDir`은 보통 `~/.pi/agent`이며 `PI_CODING_AGENT_DIR`을 따릅니다.

선택창을 취소하면 기존 설정을 유지합니다. 명령·선택창·승인 창의 고정 문구는 영어입니다.

`/approve-model`의 모델 목록, 설정 저장과 다시 로드, Pi 셸 설정 유지 방법은 [사용법](docs/usage.ko.md#승인-방식과-검토-모델-선택)을 참고하세요. 작업이 거부되면 이유를 먼저 읽으세요. 그다음 메시지로 그 작업을 분명하게 허락하거나 [`/approve retry`](docs/usage.ko.md#거부오류재시도)를 사용하세요. 재시도는 자동 승인이 아니라 새 검토를 요청합니다.

## 승인 경계

**확장이 켜져 있고 Full Access가 꺼져 있을 때** 기본 정책은 일반 쓰기, 검토가 필요한 작업과 절대 거부를 구분합니다.

| 대상 | 동작 |
| --- | --- |
| 작업 공간·임시 디렉터리·설정한 `writableRoots` 안의 쓰기 | `workspace-write` 모드에서는 허용, `read-only` 모드에서는 검토 |
| 그 밖의 쓰기, 프로젝트 `.git`·`.agents`·`.codex`·`.aws`·`.pi` 메타데이터 쓰기 | 무조건 차단하지 않고 검토 |
| 이 확장의 제어 파일(표 아래 목록) | 보호 도구를 통한 읽기·쓰기 거부 |
| 프로젝트 `.pi/guard` | 쓰기 거부 |
| 확장 자체 코드·명시적으로 신뢰한 확장의 코드 디렉터리 | 모델의 도구 호출로 하는 쓰기 거부 |
| 내장 `powershell` 호출(Windows) | 리터럴 PowerShell 문법으로 `bash`와 같이 보호 |

제어 파일은 `<agentDir>/guard/` 디렉터리, 선택한 정책 파일, 설정한 규칙 파일, 검토 캐시 `<agentDir>/pi-codex-auto-review.sqlite`와 그 `-journal`·`-wal`·`-shm` 파일입니다.

확장은 `powershell` 도구를 꺼진 상태로 등록합니다. Pi의 `defaultTools` 설정(예: `"+powershell"`)이나 `--tools`로 켜세요. [Windows와 PowerShell](docs/usage.ko.md#windows와-powershell)을 참고하세요.

절대 거부는 모델 검토와 저장 승인보다 먼저 확인합니다. 검토 오류·시간 초과·취소는 승인으로 처리하지 않습니다. 저장된 정확한 작업 승인은 도구·입력·실행 문맥·정책·요청 범위에 묶입니다. MCP 도구와 스킬 스크립트는 버전과 내용이 바뀌지 않았다면 승인을 따로 재사용할 수 있습니다. 재사용할 수 있는 대상은 [승인 재사용](docs/usage.ko.md#정확한-작업에-대한-승인과-실행)을 참고하세요.

검토자에게 전달할 증거는 `@buyong/redact`로 가리며, 가림 규칙과 선택적 개인정보 탐지를 더할 수 있습니다. 가림은 검토자의 사본을 보호할 뿐, 승인 후 실행할 원래 작업을 바꾸지 않습니다.

검토자가 1 MiB 이하 파일을 조사할 때는 파일 전체에 가림을 적용한 뒤 발췌합니다. 1 MiB보다 큰 파일은 조사를 거부합니다. [정책 설정](docs/usage.ko.md#정책-파일)과 [검토자 가림](docs/usage.ko.md#검토자-가림)을 참고하세요.

감사 기록은 `<agentDir>/guard/audit.jsonl`에 쌓이며 이 파일은 회전 없이 계속 커집니다. 파일을 보관하거나 지우기 전에 그 디렉터리를 쓰는 세션을 종료하세요.

### 승인이 보장하지 않는 것

- **OS 격리:** 검토 범위는 강제 권한 경계가 아닙니다. 승인된 셸·인터프리터는 파일에 간접 접근하거나 다른 목적지에 연결할 수 있습니다. 네트워크 프록시나 디렉터리·하드링크 전수 검사는 없습니다.
- **신뢰한 코드 전체의 보호:** Pi·로드한 확장·외부 MCP 서버는 신뢰하는 실행 구성 요소입니다. MCP 도구를 제외한 다른 확장의 도구에는 이 승인 제어가 자동 적용되지 않으며 외부 MCP 서버 내부 실행도 격리하지 않습니다.
- **외부 요청의 즉시 취소:** 이미 MCP 서버에 보낸 요청의 중단 효과는 해당 서버 구현에 달려 있습니다.
- **Codex와 같은 보안·판단:** 이 확장은 Codex [`rust-v0.160.0`](https://github.com/openai/codex/tree/a956835d020762cb2b570053af06f643a11c0ecc)의 공개 정책·규칙 계약을 따릅니다. Codex의 독점 모델이나 샌드박스는 포함하지 않습니다.
- **설치한 Pi의 의존성:** 이 저장소에 기록한 의존성 수정은 따로 설치한 Pi가 쓰는 패키지를 바꾸지 않습니다. [의존성 보안](docs/security/dependencies.ko.md)을 참고하세요.

## 소스 빌드와 검증

기여자는 [pi-packages](https://github.com/buYoung/pi-packages) 저장소 루트에서 실행하세요. Pi 도움말 검사에는 설치된 Pi CLI가 필요합니다.

```sh
pnpm install
pnpm --filter "@buyong/pi-codex-auto-review..." build
cd apps/pi-codex-auto-review
pnpm run typecheck
pnpm run lint
pnpm run test:unit
verification_dir="$(mktemp -d)"
PI_CODING_AGENT_DIR="$verification_dir" PI_OFFLINE=1 \
  pi --no-extensions -e "$PWD/dist/index.js" --help
test ! -e "$verification_dir/pi-codex-auto-review.sqlite"
```

`test:unit`은 현재 OS에서 단위·통합·적합성·실행·종단 간 테스트를 모델·UI 고정 응답으로 실행하며 유료 모델을 호출하지 않습니다.

도움말 검사는 이 확장을 로드한 상태로 Pi 도움말을 출력하며, 세션을 시작하거나 모델을 호출하지 않습니다. 모든 명령이 종료 코드 0으로 끝나고 검토 DB(`pi-codex-auto-review.sqlite`, [읽기 자동 검토 캐시](docs/usage.ko.md#읽기-자동-검토-캐시))가 생기지 않으면 통과입니다. Pi 자체 설정·인증 파일은 임시 디렉터리에 생길 수 있습니다.

빌드한 확장을 세션에서 로드하려면 [소스 설치](docs/usage.ko.md#소스에서-빌드)를 따르세요.

로컬 통과는 다른 OS나 실모델을 검증하지 않습니다. 이전 [pi-codex-auto-review](https://github.com/buYoung/pi-codex-auto-review) 저장소의 Docker·Windows 검증 결과는 [검증표](docs/testing/auto-review-protection.ko.md)에 기록되어 있습니다.

## 문서와 문의

- [사용법](docs/usage.ko.md) · [English](docs/usage.md) — 설치, 승인 설정, CLI·SDK, 정책과 검증
- [의존성 보안](docs/security/dependencies.ko.md) · [English](docs/security/dependencies.md) — 기록된 수정과 범위
- [보호 경계 검증](docs/testing/auto-review-protection.ko.md) · [English](docs/testing/auto-review-protection.md) — 현재 검증, 과거 결과와 미검증 경계
- [이슈](https://github.com/buYoung/pi-packages/issues) — 결함 신고와 질문

## 라이선스

[Apache-2.0](LICENSE). Codex 규칙 계약의 TypeScript 이식과 포함된 정책의 출처 표시는 [NOTICE](NOTICE)에 있습니다.
