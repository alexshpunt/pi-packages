# @buyong/pi-codex-fast-mode

[English](README.md) | **한국어**

대화 모델·엔드포인트를 유지하고 Pi에서 OpenAI 서비스 등급을 요청합니다. 모델별로 Standard·Fast·Ultrafast를 선택하고, 별도 선택이 없는 모델에는 전체 속도를 적용합니다. **세션 속도 > 모델별 설정 > 전체 속도 순서로 우선합니다.** 로컬 호환 조건을 통과할 때만 해당 `service_tier`를 추가하며, 명시적 선택이 없는 초기 Standard는 요청을 바꾸지 않습니다.

선택한 등급은 요청에 적용합니다. 서버 응답 등급은 요청과 다를 수 있으며, Codex backend에서는 Fast·Ultrafast 요청에도 `default`가 관측됐습니다. 응답의 `default`만으로 선택을 해제하거나 실패로 판단하지 않습니다. 실제 처리 속도·과금은 별도로 확인합니다. OpenAI의 [Fast](https://developers.openai.com/api/docs/guides/fast-mode)·[Ultrafast](https://developers.openai.com/api/docs/guides/ultrafast-mode) 안내를 참고하세요.

## 요구 사항

Node.js 22.19 이상, Pi 1.0.0 이상과 설정된 모델 접근이 필요합니다. 이 저장소는 Pi 1.3.0을 기준으로 빌드합니다. Fast는 [로컬 허용 목록](#지원-모델과-요청-값)의 사용 가능한 모델을 선택합니다. Ultrafast에는 API·인증·엔드포인트 조건도 있습니다. 목록이 계정 접근이나 백엔드 지원을 제공하는 것은 아닙니다.

## 빠른 시작

게시된 릴리스를 설치합니다.

```sh
pi install npm:@buyong/pi-codex-fast-mode
pi list
pi
```

`@buyong/pi-codex`를 통해 같은 확장을 함께 활성화하지 마세요. Pi에서 다음 순서로 진행합니다.

1. [로컬 Fast 허용 목록](#지원-모델과-요청-값)의 모델을 선택합니다.
2. `/codex-fast`에서 모델 아래의 `Speed`를 Fast로 고르고 Enter로 저장합니다.
3. `/codex-fast status`로 선택한 등급의 요청이 현재 모델에서 활성화됐는지 확인합니다.
4. 짧은 프롬프트로 모델 요청을 만듭니다. 예를 들어 다음과 같이 요청합니다.

```text
Reply with READY only. Do not use tools.
```

`/codex-fast status`를 다시 확인합니다. `OpenAI requested service tier`는 선택한 요청 등급이고, `Request enabled`는 확장의 로컬 조건을 통과했다는 뜻입니다. 활성 선택은 하단에 `gpt-6.1-sol fast`처럼 표시하고 일치하는 요청은 마지막 주입에 `priority`를 기록합니다. 이 기록은 훅이 준비한 요청 필드이며 실제 서버 처리 등급의 확인은 아닙니다. 이 모델의 가속을 끄려면 모델별 속도를 Standard로 저장하세요.

## 등급 선택

`/codex-fast`는 **Session speed (not saved)**를 맨 위에 표시한 뒤 `/scoped-models`에 선택된 모델 중 사용 가능하고 속도 조절이 가능한 모델을 표시하고, 아래에 **Global speed**를 둡니다. 선택 범위를 설정하지 않았다면 Pi와 동일하게 사용 가능한 전체 모델을 기준으로 합니다. 모델은 Astra·Sol·Luna 계열 순서, 같은 계열에서는 숫자 버전 내림차순, 그다음 모델 키 순서로 정렬합니다. 나머지 모델은 그 뒤에 모델 키 순서로 표시하며, 현재 모델에 정렬 우선권을 주지 않습니다. 범위 밖의 모델은 현재 모델이어도 추가하지 않습니다. 각 모델 아래의 `Speed`에서 **Standard·Fast·Ultrafast 중 하나**를 선택합니다. 별도 설정이 없으면 모델명 옆에 `global`을 표시하며 전체 속도를 따릅니다.

`/scoped-models`에서 선택을 바꾼 뒤 `/codex-fast`를 다시 열면 변경된 목록이 반영됩니다. 목록에서 숨겨진 모델의 속도 설정은 그대로 보존합니다.

- **↑/↓**: 세션·모델·전체 속도 항목 선택. 긴 목록은 선택에 따라 스크롤합니다.
- **←/→ 또는 Tab/Shift+Tab**: 속도 선택. 대괄호는 세션 선택 또는 저장된 모델·전체 값, `›…‹`는 현재 선택 위치입니다.
- **Enter**: 세션 행은 저장 없이 적용하고, 모델·전체 속도는 저장합니다. 화면은 열린 상태를 유지합니다.
- **R**: 세션 행에서는 세션 속도를 해제하고, 모델 행에서는 별도 설정을 해제해 전체 속도를 상속합니다.
- **Esc**: 닫기. Enter로 적용하지 않은 선택은 버립니다.

해당 모델에서 요청할 수 없는 속도는 모델 행에서 흐리게 `×`로 표시하고 선택에서 제외합니다. 세션 행에서는 세 속도를 모두 선택할 수 있으며, 현재 모델이 지원하지 않아도 선택을 유지합니다. 좁은 터미널에서는 저장된 속도와 선택 중인 속도를 간단히 표시합니다.

| 명령 | 동작 |
| --- | --- |
| `/codex-fast session standard` / `fast` / `ultrafast` | 현재 세션에만 속도를 덮어씁니다. 설정 파일에는 저장하지 않습니다. |
| `/codex-fast session clear` | 세션 속도를 해제하고 모델별·전체 설정으로 돌아갑니다. |
| `/codex-fast speed standard` / `fast` / `ultrafast` | 전체 속도 선택. 모델별 설정은 유지합니다. |
| `/codex-fast model <provider/id> standard` / `fast` / `ultrafast` | 해당 모델의 속도 선택. 지원되지 않는 선택은 기존 설정을 유지합니다. |
| `/codex-fast model <provider/id> inherit` | 해당 모델을 전체 속도 상속으로 되돌립니다. |
| `/codex-fast on` | 전체 속도를 Fast로 선택 |
| `/codex-fast off` | 전체 속도를 Standard로 선택. 모델별 설정은 유지합니다. |
| `/codex-fast fast on` / `/codex-fast fast off` | 전체 Fast 변경. 이미 꺼진 모드를 끄면 다른 전체 속도를 유지합니다. |
| `/codex-fast ultrafast on` / `/codex-fast ultrafast off` | 전체 Ultrafast 변경. 지원되지 않는 모델에서는 요청 등급을 추가하지 않습니다. |
| `/codex-fast status` | 선택한 등급, 세션 속도 설정 여부, 적용 상태, 모델, 설정 경로, 저장 여부와 마지막 주입을 표시합니다. 선택은 바꾸지 않습니다. |

명시적 인자는 UI 없이도 사용할 수 있습니다. `<provider/id>`는 `openai-codex/gpt-6.1-sol`처럼 실제 공급자·모델 ID로 바꿉니다. RPC에서는 세션·모델·전체 속도를 고른 뒤 속도 선택창을 엽니다. 세션 속도 해제와 모델의 전체 속도 상속 항목도 제공합니다. 모드 변경은 현재 에이전트 작업이 멈출 때까지 기다립니다. `status`는 설정을 저장하거나 모델을 호출하지 않습니다. Pi 시작 명령의 `--fast`는 저장된 전체 속도를 Fast로 덮어쓰며, 모델별 설정이 계속 우선합니다.

세션 속도는 모델별 설정과 전체 속도(`--fast` 포함)보다 우선합니다. `persistState`와 무관하게 메모리에만 유지하며, 모델을 바꿔도 선택은 유지하고 모델별 호환 조건을 다시 확인합니다. 프로세스 종료, `/new`, `/resume`, `/fork`, `/reload` 시 사라지고, 세션 시작 시 저장 설정과 시작 플래그로 돌아갑니다. 세션을 바꾸지 않고 해제하려면 `/codex-fast session clear`를 사용하세요. 설정 중에는 footer에 `· session`을 붙이고, 가속을 요청할 수 없으면 `unsupported`도 표시합니다. `status`는 저장 속도를 덮어쓰고 있음을 안내합니다. 전체·모델별 명령과 TUI 저장은 계속 정상 저장하되 결과 메시지에서 세션 속도가 우선 적용 중임을 알립니다.

세션 속도가 없으면 모델을 바꿀 때 해당 모델의 설정 또는 전체 속도를 다시 계산합니다. 선택한 가속 등급을 지원하지 않는 모델에서는 설정을 유지하고 등급을 추가하지 않습니다. 모델별 명령으로 속도를 고를 때는 대상 모델의 호환 조건을 먼저 확인합니다.

## 이전 명령에서 전환

이 체크아웃은 `/codex-fast`만 등록합니다. `/openai-tier`·`/openai-settings`는 별칭을 남기지 않고 제거했습니다. 진단에는 `/codex-fast status`, 모델별 설정에는 `model` 명령, 전체 설정에는 `speed` 명령을 사용하세요. 기존 `/codex-fast on`·`off`와 모드별 축약형은 전체 속도를 변경하며 계속 지원합니다.

이전 명령을 호출하는 스크립트는 갱신해야 합니다. 기존 불리언·설정 경로는 유지하고 모델별 설정이 전체 속도보다 우선합니다. 게시된 릴리스는 체크아웃과 다를 수 있으므로 이 변경이 포함된 릴리스나 아래 소스 빌드를 사용하세요.

## 설정과 저장

| 위치 | 경로 |
| --- | --- |
| 전역 | `<agentDir>/codex-fast-mode/settings.json` |
| 프로젝트 | `<cwd>/.pi/codex-fast-mode/settings.json` |

`agentDir`은 `PI_CODING_AGENT_DIR`을 따르며 보통 `~/.pi/agent`입니다. 프로젝트 설정이 전역보다 우선합니다. 프로젝트 파일이 있으면 전체·모델별 명령은 거기에 저장하고, 없으면 전역 파일에 저장합니다. 세션 속도는 어느 파일에도 저장하지 않습니다.

```json
{
  "serviceTier": "standard",
  "modelServiceTiers": {
    "openai-codex/gpt-6.1-sol": "ultrafast",
    "openai-codex/gpt-6-astra": "fast"
  },
  "persistState": true,
  "notifyOnModelSwitch": true
}
```

| 설정 | 기본값 | 동작 |
| --- | --- | --- |
| `serviceTier` | `"standard"` | 모델별 설정이 없는 모델에 적용할 전체 속도. `standard`·`fast`·`ultrafast`. Standard를 명시적으로 저장하면 선택이 없는 상태와 다릅니다. |
| `modelServiceTiers` | `{}` | 정확한 `provider/id`별 속도. `standard`·`fast`·`ultrafast`는 전체 속도보다 우선하며 `null`은 전체 속도 상속입니다. |
| `persistState` | `true` | `false`는 전체·모델별 명령 변경을 메모리에만 유지합니다. 세션 속도는 이 값과 무관하게 저장하지 않습니다. |
| `notifyOnModelSwitch` | `true` | 모델 변경으로 적용 여부가 바뀌면 알립니다. |
| `supportedModels` | 아래 기본 목록 | 정확한 `provider/id` 문자열로 Fast 허용 목록을 대체합니다. `[]`은 Fast 지원을 끄지만 Ultrafast 조건은 바꾸지 않습니다. |
| `desiredActive`, `active`, `fast.enabled` | 없음 | 이전 불리언 설정. 같은 계층에서는 `serviceTier` → `desiredActive` → `active` → `fast.enabled` 순서로 우선합니다. |

전체 속도는 계층별로 해석한 뒤 병합하므로 프로젝트의 이전 불리언도 전역 `serviceTier`를 덮어쓸 수 있습니다. 모델별 설정은 ID별로 병합하며 같은 모델은 프로젝트 값이 우선합니다. 전역 파일의 모델별 설정도 프로젝트의 전체 속도보다 우선합니다. 프로젝트에 해당 모델을 `null`로 저장하면 전역 모델별 설정을 가리고 전체 속도를 상속합니다.

전체 속도 변경은 `serviceTier`·`desiredActive`·`active`를, 모델별 변경은 대상 ID만 갱신하며 다른 필드는 보존합니다. 전역 설정의 모델을 상속으로 되돌리면 해당 항목을 삭제합니다. 같은 파일에 대한 동시 저장은 확장 인스턴스와 Pi 프로세스 사이에서 직렬화하여 다른 모델과 무관한 필드를 보존합니다. 2초 안에 저장 잠금을 얻지 못하면 오류를 알리고 이전 선택을 복원하므로, 다른 저장이 끝난 뒤 재시도하세요. 다른 저장 실패도 이전 선택을 복원합니다. 모델 변경은 파일을 저장하지 않고 요청 속도와 적용 여부만 다시 계산합니다.

직접 편집한 뒤 `/reload`를 실행합니다. 잘못됐거나 읽을 수 없는 설정은 오류를 알리고 기본값을 사용하며 변경은 세션에만 적용합니다. 명령 저장에 실패하면 이전 등급으로 되돌립니다.

## 지원 모델과 요청 값

확장의 **기본 로컬 Fast 허용 목록**입니다. 공급자·계정이 모든 모델이나 서비스 등급을 제공한다는 약속은 아닙니다.

| 공급자 | 모델 ID |
| --- | --- |
| `openai` | `gpt-5.4`, `gpt-5.5`, `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna` |
| `openai-codex` | 위 모델들과 `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` |

Ultrafast는 `gpt-6-astra` 또는 `gpt-6.1-sol`에서 다음 경로로 요청합니다.

| 공급자·API | 인증 | 기본 엔드포인트 |
| --- | --- | --- |
| `openai`·`openai-responses` | Pi에 설정된 API 키 또는 ChatGPT OAuth 인증 | `https://api.openai.com/v1` |
| `openai-codex`·`openai-codex-responses` | 설정된 OAuth 인증 | `https://chatgpt.com/backend-api`. `/codex`·`/codex/responses`를 붙인 주소도 허용합니다. |

HTTPS 기본 포트나 443을 사용하고 URL 자격 증명·쿼리·프래그먼트가 없어야 합니다. 경로 끝의 `/`는 허용합니다. Codex 경로의 활성 상태는 확장이 요청을 준비할 수 있다는 뜻입니다. 해당 계정의 지원 여부나 실제 처리 등급을 Codex 응답 등급 하나로 확정하지 않습니다.

| 선택 | 주입하는 `service_tier` |
| --- | --- |
| 명시적 선택이 없는 초기 Standard | 필드를 추가하지 않음 |
| 세션에서 직접 고르거나 저장한 전체·모델별 Standard | 속도 조절이 가능한 모델에 `"default"` |
| Fast | Fast 지원 모델에 `"priority"` |
| Ultrafast | 조건을 통과하면 `"ultrafast"` |
| 미지원 모델의 가속 선택 | 필드를 추가하지 않고 선택만 유지 |

훅은 요청이 객체이며 `payload.model`이 현재 모델 ID와 일치할 때만 복사본을 반환합니다. 다른 모델의 보조 요청은 바꾸지 않습니다. 미지원 요청은 유지하며 엔드포인트·모델을 바꾸거나 백엔드의 실제 등급을 검증하지 않습니다.

[Sol 속도 등급 PoC](https://github.com/buYoung/pi-codex-auto-review/blob/master/docs/testing/ultrafast-sol.ko.md)는 Pi 공급자가 만드는 최종 HTTP 본문과 정상 응답을 확인하고 요청 등급·서버 원문 등급·TPS를 따로 기록합니다. 응답 등급 차이만으로 실패하지 않으며, 이 결과가 실제 처리 등급이나 과금을 보장하지는 않습니다.

## 선택한 등급이 적용되지 않을 때

| 증상 | 확인할 내용 |
| --- | --- |
| 선택은 유지하지만 비활성 | 현재 `provider/id`와 `supportedModels` 재정의를 확인합니다. 저장 선택이 호환 여부는 아닙니다. |
| 저장 속도를 바꿔도 현재 모델의 속도가 유지됨 | `status`에서 세션 속도를 확인하고 `session clear`로 해제하세요. 세션 속도가 없으면 모델별 설정이 전체 속도보다 우선합니다. 해당 모델에서 `R` 또는 `model <provider/id> inherit`으로 전체 속도를 상속합니다. |
| Ultrafast 선택 거부 | 위 조건을 모두 확인합니다. 이전 등급을 유지하며 Fast로 대신 선택하지 않습니다. |
| 프롬프트 후에도 주입 없음 | 현재 모델과 공급자 요청의 일치하는 `model` 필드를 확인합니다. 다른 모델 요청·호환되지 않는 요청은 유지합니다. |
| 설정 로드·저장 오류 | 표시된 설정 경로를 확인합니다. 로드 오류는 기본값과 세션 변경만 사용하고, 명령 저장 실패는 이전 등급으로 되돌립니다. |

## 소스 빌드와 로드

[pi-packages](https://github.com/buYoung/pi-packages) 저장소 루트에서 실행합니다.

```sh
pnpm install
pnpm --filter @buyong/pi-codex-fast-mode build
pnpm --filter @buyong/pi-codex-fast-mode exec pi -ne -e ./dist/index.js
```

영구 패키지 등록 없이 이번 실행에 확장을 로드합니다. 소스를 바꾼 뒤 다시 빌드하세요. 모델 없이 소스를 검증하려면 `apps/pi-codex-fast-mode`에서 `pnpm run typecheck`, `pnpm run lint`, `pnpm run build`를 실행하고 모두 정상 종료하는지 확인합니다. Pi 안에서 `/codex-fast session fast`와 `/codex-fast status`를 실행하면 설정 저장 없이 세션 속도를 확인할 수 있습니다. `/codex-fast session clear` 또는 `/reload` 뒤 `status`를 다시 실행하여 `Session speed: not set`으로 돌아오는지 확인하세요. 이 확인 과정은 모델을 호출하지 않습니다. 릴리스 준비는 [저장소 배포 절차](https://github.com/buYoung/pi-packages#공통-ci와-패키지별-배포)를 참고하세요.

## 라이선스

[Apache-2.0](LICENSE). npm 압축 파일에는 `LICENSE`를 포함합니다.
