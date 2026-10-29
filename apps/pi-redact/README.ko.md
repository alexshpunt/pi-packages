# @buyong/pi-redact

[English](README.md) | **한국어**

Pi가 언어 모델에 보내기 전에 인증 정보와 개인 키를 가리는 Pi 확장입니다. 도구 결과는 Pi가 저장하거나 화면에 보여 주기 전에 가리고, 모든 모델 요청·압축·브랜치 요약은 보내기 직전에 한 번 더 검사합니다. 탐지한 값은 `{{REDACTED}}`가 되며, 모델이 이 표식을 파일이나 명령에 다시 쓰는 호출은 차단합니다.

Pi 안에서는 페이지 세 개로 관리합니다. `/redact`는 현재 상태를 보여 주고 세션이나 기본값으로 가림을 켜고 끕니다. `/redact-custom`은 규칙을 편집하고, `/redact-analytics`는 무엇을 가렸는지 전과 후를 보여 줍니다.

탐지는 [`@buyong/redact`](https://github.com/buYoung/pi-packages/blob/main/packages/redact/README.ko.md)가 담당합니다. 기본 토큰·인증 정보 규칙, PEM 개인 키, `PASSWORD=…` 같은 민감한 대입문과, [설정](#설정)의 `piiEntities`로 켠 개인정보(기본값은 꺼짐)를 탐지합니다. 모든 비밀을 찾는다고 보장하지 않으므로, 사용하기 전에 [가리지 않는 것](#가리지-않는-것)을 확인하세요.

## 요구 사항

- Node.js 22.19 이상
- Pi 1.3.0 이상. `@earendil-works/pi-coding-agent` 1.3.0과 1.4.0으로 테스트했습니다. 이전 버전은 테스트하지 않았습니다.

## 설치

게시된 릴리스를 설치합니다.

```sh
pi install npm:@buyong/pi-redact
```

## 가림이 동작하는지 확인

이 확인에는 Pi에 설정된 모델이 필요합니다.

1. 빈 디렉터리에 `API_KEY=sk-example0123456789abcd`가 든 `.env` 파일을 만들고, 그 디렉터리에서 `pi`를 시작한 뒤 모델에게 `.env`를 읽게 합니다. 결과에 `API_KEY={{REDACTED}}`가 보입니다.
2. `/redact`를 실행합니다. 페이지 첫 줄은 `Masking is on (this session follows the global default).`이고, 이 세션에서 `1 tool results masked`를 보고합니다.
3. `/redact-analytics`를 실행하고 `.env`의 `read` 기록에서 Enter를 누릅니다. diff에 원래 줄 `-1 API_KEY=sk-example0123456789abcd`와 가린 줄 `+1 API_KEY={{REDACTED}}`가 보입니다.

## 하는 일

| 시점 | pi-redact의 동작 |
| --- | --- |
| 도구가 결과를 돌려줄 때 (`read`, `bash`, `grep`, MCP 도구 등) | 결과의 텍스트와 `details`를 Pi가 세션 파일에 저장하고 화면에 보여 주기 전에 가리고, Pi가 JSON 모드 출력이나 RPC 클라이언트 같은 이벤트 수신자에게 넘기는 `structuredContent` 사본도 가립니다. `read` 결과는 이 사본까지 파일 경로를 함께 넘겨 검사하므로 `.env`, `.ini`, `.properties`, `.cfg`의 값은 줄 끝까지 가립니다. |
| 모든 모델 요청 | 전송하는 사본에서 사용자 메시지, 어시스턴트 텍스트, 도구 호출 인자, 도구 결과, `!` 명령 출력, 확장 메시지, 요약을 가립니다. 모든 `context` 핸들러 다음에 실행되므로 다른 확장이 추가한 텍스트도 가립니다. |
| 압축과 브랜치 요약(`/tree`로 브랜치를 떠날 때 만드는 요약) | Pi가 요약할 대화를 가립니다. Pi는 이 요청을 context 훅 없이 보내므로 따로 처리합니다. |
| 모델이 `write`, `edit`, `bash`, `powershell`을 호출할 때 | 되쓰기 차단이 `{{REDACTED}}`를 쓰게 되는 호출을 막습니다. 막는 호출은 표식이 들어간 셸 명령, 파일에 이미 있는 개수보다 표식을 더 쓰는 `write`, `newText`의 표식 개수가 `oldText`보다 많은 `edit`입니다. 모델은 차단 이유를 받고 사용자에게는 경고가 표시됩니다. |
| 에이전트 실행마다 | 시스템 프롬프트에 지침 하나를 더합니다. `{{REDACTED}}`는 가린 값이므로 쓰지 말고, 그 줄을 피해 편집하거나 사용자에게 값을 요청하라는 내용입니다. |

[`/redact`](#가림-켜기와-끄기)로 가림을 끈 동안에는 위 표의 처음 세 동작이 멈춥니다. 앞서 가린 결과에 표식이 남아 있을 수 있으므로 되쓰기 차단과 지침은 유지합니다.

`grep -n`, `rg`, `cat -n`, 줄 번호를 붙이는 도구, diff가 줄 앞에 붙인 접두사는 떼고 다시 검사합니다. 그래서 `.env:2:DB_PASSWORD=value`와 `+API_TOKEN=value`도 일반 대입문처럼 가립니다.

### 표식

가린 구간은 길이와 관계없이 모두 `{{REDACTED}}`가 됩니다. 줄마다 따로 바꾸고 줄바꿈은 그대로 두므로, 가린 파일의 줄 번호는 디스크의 파일과 같습니다. 그래서 모델은 비밀이 있는 파일의 다른 줄을 편집할 수 있습니다. `oldText`에 가린 줄이 들어간 편집은 일치하는 곳이 없어 실패할 뿐입니다.

## 페이지

| 명령 | 여는 페이지 |
| --- | --- |
| `/redact` | 현재 상태와, 이 세션 및 전역 기본값의 스위치. [가림 켜기와 끄기](#가림-켜기와-끄기)를 참고하세요. |
| `/redact-custom` | 기본 규칙, 개인정보, 필드 이름, 패턴, 예외, 가림 미리보기. [규칙 바꾸기](#규칙-바꾸기)를 참고하세요. |
| `/redact-analytics` | 가린 내용과 그 원래 줄·가린 줄. [가린 내용 보기](#가린-내용-보기)를 참고하세요. |

명령은 인수를 받지 않으며 모든 선택은 페이지에서 합니다. 터미널에서는 Esc로 각 페이지를 닫습니다. 대화상자는 있지만 터미널은 없는 RPC 클라이언트와 UI가 없는 모드에서는 각 절에서 설명하는 대체 동작을 합니다. 0.2.0부터 이전의 상태 명령 `/pi-redact`는 `/redact`로 바뀌었습니다.

## 가림 켜기와 끄기

`/redact`는 가림 상태, 사용 중인 설정 파일, 건너뛴 파일, 이 세션의 건수, 분석 기록 수를 보여 줍니다. 그 아래에 스위치 두 개가 있으며, Enter나 Space로 바꿉니다.

| 스위치 | 저장 위치 | 적용 범위 |
| --- | --- | --- |
| This session | 세션 파일의 `pi-redact-session` 항목. 모델은 이 항목을 보지 않습니다. | 이 세션만. 세션을 다시 열거나 `/reload`, `/tree`를 해도 현재 브랜치에 기록된 선택을 되살립니다. |
| Global default | 전역 설정 파일의 `"enabled": false`. 다시 켜면 이 키를 지웁니다. | 새 세션과, 자체 선택이 없는 세션 |

세션 자체의 선택이 전역 기본값보다 우선합니다. 자체 선택이 없는 세션은 페이지에서 바꾼 것을 포함해 전역 기본값을 따릅니다.

가림을 끈 동안에는 다음과 같습니다.

- 도구 결과를 그대로 세션 파일에 저장하고 모델에 보내며, 모델 요청·압축·브랜치 요약도 가리지 않습니다. `/redact-analytics`에 기록하지도 않습니다.
- 가림을 켜 둔 동안 가린 결과는 가린 채로 남습니다. 원래 값을 저장하지 않았기 때문입니다.
- 되쓰기 차단은 계속 `{{REDACTED}}`를 막고, 시스템 프롬프트의 지침도 유지합니다.
- Pi 상태 표시줄에 `redact off`가 보입니다. 세션 자체의 선택으로 끈 경우에는 `redact off (this session)`이 보입니다.

다시 켜면 다음 모델 요청부터 대화 전체를 가립니다. 이미 보낸 내용과, 세션 파일에 가리지 않은 채 저장된 내용은 바꿀 수 없습니다.

터미널이 없으면 `/redact`는 같은 상태를 알림으로 보여 준 뒤, `Close`를 고를 때까지 두 스위치를 선택 대화상자로 제공합니다. UI가 전혀 없으면 상태를 stderr에 출력합니다.

## 규칙 바꾸기

`/redact-custom`은 설정 파일을 한 번에 하나씩 편집합니다. 바꿀 때마다 검사하고 저장한 뒤 실행 중인 세션에 바로 적용하므로 `/reload`가 필요 없습니다.

| 행 | 할 수 있는 일 |
| --- | --- |
| Settings file | `global`과 `project` 중에서 고릅니다. `project`는 신뢰한 프로젝트에서만 고를 수 있습니다. |
| Built-in rules | 기본 규칙 16개 중 하나를 끕니다. 예를 들어 모델이 토큰을 다음 호출에 넘겨야 하면 `token.jwt`를 끕니다. 가림을 약하게 하므로 전역 파일에서만 할 수 있습니다. |
| Personal information | 개인정보 엔티티를 켭니다. 이름 90개를 입력해서 찾습니다. |
| Sensitive field names | `OPENAI_KEY` 같은 정확한 필드 이름을 추가·수정·삭제합니다. |
| Custom patterns | 정규식을 추가·수정·삭제합니다. 입력란은 id(`custom.`이 없으면 붙임), 패턴, 선택 사항인 플래그 순서입니다. |
| Exceptions | 한 규칙에서 정확히 일치하는 값 하나를 보이게 둡니다. 입력란은 기본 규칙 id와, 이 파일의 패턴·개인정보 엔티티 id를 선택지로 보여 줍니다. |
| Try masking | 한 줄을 입력하면 가린 결과를 diff로, 일치한 규칙과 함께 보여 줍니다. 가림을 켰든 껐든 저장된 설정을 적용합니다. 입력한 줄은 저장하지도 보내지도 않습니다. |

잘못된 패턴처럼 라이브러리가 거부하는 항목은 저장하지 않으며, 입력란에 이유를 보여 줍니다. 디스크의 설정 파일 자체가 잘못되었으면 페이지에서 편집할 수 없습니다. 페이지가 문제를 알려 주므로 파일을 고치거나 지우세요.

터미널이 없으면 `/redact-custom`은 파일의 JSON을 Pi 편집기 대화상자로 엽니다. 프로젝트 파일도 고를 수 있으면 먼저 어떤 파일인지 묻습니다. 올바른 설정 파일일 때만 저장하며, 그렇지 않으면 입력한 텍스트로 대화상자를 다시 열고 알림으로 이유를 알려 줍니다. UI가 전혀 없으면 설정 파일 경로를 stderr에 출력합니다.

## 가린 내용 보기

`/redact-analytics`는 pi-redact가 가린 내용을 최신순으로 보여 줍니다. 각 항목에는 단계(도구 결과, 모델 요청, 압축, 브랜치 요약), `read .env`나 `user message` 같은 이름표, 일치한 규칙이 나옵니다. 목록 위에는 기록 수와 가린 줄 수, 규칙별 기록 수가 나옵니다.

- Tab은 이 세션과, 최근 30일의 모든 세션 사이를 전환합니다.
- Enter로 기록을 엽니다. 바뀐 줄과 앞뒤 두 줄을 Pi 편집 도구와 같은 형태의 diff로 보여 줍니다. Tab을 누르면 전과 후를 따로 보여 줍니다. ↑·↓로 스크롤하고, PgUp·PgDn으로 한 쪽씩 이동하며, Esc로 돌아갑니다.
- `d`를 누른 뒤 Enter로 확인하면 현재 보기의 기록을 지웁니다.

기록하는 내용은 다음과 같습니다.

- 가림으로 바뀐 텍스트 하나마다, 세션과 단계별로 한 번 기록합니다. 다음 요청에 같은 텍스트가 다시 나오거나, `read` 결과의 `content`와 `structuredContent`에 같은 텍스트가 있어도 기록을 더하지 않습니다.
- 기록 하나에 앞뒤 줄을 포함해 최대 300줄을 남깁니다. 400자를 넘는 줄은 바뀐 부분(최대 1,000자)과 그 양쪽 최대 80자만 남깁니다.
- 기록은 `~/.pi/agent/pi-redact/analytics.sqlite`(또는 `$PI_CODING_AGENT_DIR` 아래)에 있는 SQLite 파일에 저장합니다. 이 파일은 본인만 읽을 수 있게 만듭니다(macOS와 Linux에서 권한 0600). 같은 agent 디렉터리를 쓰는 모든 Pi 세션과 서브에이전트가 이 파일에 기록합니다.
- 30일이 지난 기록은 보이지 않게 한 뒤 지웁니다. 이 기간은 바꿀 수 없습니다. 기록은 최신 50,000건까지만 남깁니다.

> [!WARNING]
> 기록에는 원래 값이 들어 있으므로, 분석 파일은 비밀 값을 최대 30일 동안 디스크에 보관합니다. `d`로 기록을 지우거나, Pi가 실행 중이 아닐 때 파일을 지우세요.

기록을 저장하지 못해도 가림은 계속하며, pi-redact는 세션마다 한 번 `pi-redact: masked content could not be saved for /redact-analytics: <reason>` 경고를 표시합니다. 터미널이 없으면 `/redact-analytics`는 이 세션의 합계와 최신 기록 다섯 건을 텍스트 diff로 알려 줍니다.

## 가리지 않는 것

- **시스템 프롬프트.** `AGENTS.md`, `CLAUDE.md` 같은 컨텍스트 파일은 그대로 보냅니다. 이 파일에는 비밀을 두지 마세요.
- **세션 파일에 저장되는 사용자 입력과 `!` 명령 출력.** 입력한 그대로 저장하고, 모델에 보낼 때만 가립니다.
- **이미지.** 스크린샷과 이미지 파일은 검사하지 않습니다.
- **thinking 블록.** 프로바이더 서명 때문에 바꿀 수 없습니다. 모델이 이미 본 내용만 들어 있습니다.
- **명령 실행 중의 실시간 출력.** 최종 결과는 가리지만, 실행 중 화면에 흐르는 부분 출력은 가리지 않습니다.
- **도구가 다른 도구를 통해 호출한 결과** (예: codemode 스크립트 안의 호출). 모델이 아니라 그 도구로 돌아가며, 바깥 도구의 결과는 가립니다.
- **다른 확장이 직접 하는 모델 호출.**
- **결과가 잘렸을 때 Pi가 임시 파일에 저장하는 bash 전체 출력.** 그 파일을 `read`로 읽으면 가립니다.
- **규칙이 다루지 않는 형식.** 예를 들어 이름이 `key`로만 끝나는 `OPENAI_KEY=…`, `SESSION_KEY=…`, 로그 줄 중간의 `key=value`, `hooks.slack.com/services/…` 형태의 Slack 웹훅 URL입니다. 사용하는 이름과 형식은 [설정](#설정)에 추가하세요.
- **다른 도구가 `*`로 가린 텍스트.** 예를 들어 `@buyong/redact`는 짧은 값을 `*`로 표시합니다. 되쓰기 차단은 `{{REDACTED}}`만 막으므로 모델은 이런 표시를 파일이나 명령에 쓸 수 있습니다.
- **`/compact`나 `/tree` 브랜치 요약에 입력한 지침.** Pi가 대화와 따로 요약기에 넘깁니다.

### 부수 효과

- JSON 필드나 `key=value`·`key: value` 대입문처럼, 이름이 `apikey`, `token`, `password`, `passwd`, `pwd`, `secret`, `secretkey`, `privatekey`, `accesskey`, `accesskeyid`로 끝나는 필드나 대입문의 값은 모두 가립니다. 이름은 글자와 숫자만 남겨 대소문자 구분 없이 비교합니다. `nextPageToken` 같은 페이지네이션 값도 포함되므로 모델은 그 값을 다음 호출에 넘길 수 없습니다.
- 채팅에 입력한 비밀은 모델이 보기 전에 가리므로 모델이 파일에 쓸 수 없습니다. 파일을 직접 편집하거나, 값을 환경변수에 두고 모델이 그 이름을 참조하게 하세요.

## 설정

설정은 선택 사항인 JSON 파일입니다. [`/redact-custom`](#규칙-바꾸기)이 대신 편집해 주며, 직접 편집해도 됩니다. 기본 규칙에 더해지는 `@buyong/redact` 설정 키와, 전역 파일에만 둘 수 있는 pi-redact 자체 키 두 개를 씁니다.

| 파일 | 적용 조건 |
| --- | --- |
| `~/.pi/agent/pi-redact/settings.json` (또는 `$PI_CODING_AGENT_DIR/pi-redact/settings.json`) | 항상 |
| `<프로젝트>/.pi/pi-redact/settings.json` | Pi에서 프로젝트를 신뢰한 경우에만(Pi 시작 시 묻는 창이나 `/trust`로 설정) |

```json
{
  "enabled": true,
  "disabledRules": ["token.jwt"],
  "sensitiveFields": ["OPENAI_KEY", "SESSION_KEY"],
  "rules": [{ "id": "custom.env-key", "pattern": "^[A-Z0-9_]*_KEY=(?<secret>.+)$", "flags": "m" }],
  "exceptions": [{ "ruleId": "custom.env-key", "value": "example-value" }],
  "piiEntities": ["EMAIL_ADDRESS"]
}
```

- `enabled`는 [`/redact`](#가림-켜기와-끄기)의 전역 기본값입니다. `false`면 자체 선택이 없는 세션에서 가림을 끕니다. `disabledRules`는 무시할 기본 규칙 id 목록입니다. 토큰·인증 정보 규칙 14개, `private-key.pem`, `field.sensitive`를 쓸 수 있습니다. 두 키 중 하나라도 든 프로젝트 파일은 통째로 건너뜁니다. pi-redact 0.1.x는 이 키를 모르므로 이 키가 든 파일을 건너뜁니다.
- `sensitiveFields`는 글자와 숫자만 남겨 대소문자 구분 없이 비교하는 정확한 이름입니다(`OPENAI_KEY`는 `openaiKey`와 일치).
- `rules[].id`는 `custom.`으로 시작해야 합니다. 규칙은 일치한 구간 전체를 가리고, 패턴에 이름 있는 그룹 `(?<secret>…)`이 있으면 그 그룹만 가립니다. 패턴은 신뢰할 수 없는 텍스트에서 실행되므로 중첩 반복은 피하세요.
- `exceptions`는 한 규칙 id에서 정확히 일치하는 값 하나를 보이게 둡니다. `piiEntities`는 이름을 적은 개인정보 엔티티를 켭니다. 기본 규칙 id는 `@buyong/redact` README의 [규칙](https://github.com/buYoung/pi-packages/blob/main/packages/redact/README.ko.md#규칙), 엔티티 이름은 [PII](https://github.com/buYoung/pi-packages/blob/main/packages/redact/README.ko.md#pii), 패턴 문법과 허용하는 `flags`는 [설정](https://github.com/buYoung/pi-packages/blob/main/packages/redact/README.ko.md#설정)에 있습니다.
- 프로젝트 설정은 전역 설정에 더해지며, id가 같은 프로젝트 규칙은 전역 규칙을 대신합니다.
- 파일이 없으면 알리지 않고 건너뜁니다. 파일이 있지만 읽을 수 없거나, 올바른 JSON이 아니거나, 잘못된 설정이 들어 있으면 그 파일을 통째로 건너뜁니다. 이때 세션마다 한 번 경고하고(Pi에 UI가 없으면 stderr에 출력), `/redact`는 그 파일을 `Skipped:` 줄로 보여 줍니다. 알림에는 설정 키와 배열 인덱스만 나오며 설정한 값은 나오지 않습니다. 나머지 파일과 기본 규칙으로 계속 가립니다.

설정은 세션이 시작될 때와, `/redact`나 `/redact-custom`에서 바꿀 때마다 읽습니다. 파일을 직접 고친 뒤에는 `/reload`를 실행하거나 새 세션을 시작하세요. 페이지는 파일을 두 칸 들여쓰기로 다시 쓰며, 기본값과 빈 목록은 적지 않습니다.

## 가리기에 실패하면

pi-redact는 가리지 못한 텍스트를 보내지 않습니다. 가리지 못한 텍스트를 대신하는 안내문은 `[pi-redact withheld this content because masking it failed]`입니다.

- 가리지 못한 도구 결과는 안내문으로 바꾸고 오류로 표시합니다.
- 모델 요청이나 요약에서 가리지 못한 메시지는 안내문으로 바꿉니다. 모델 요청에서 그마저 실패하면 실행을 중단하고, 요청의 대화 내용을 안내문 하나로 바꿉니다.
- 요약 입력 전체를 처리하지 못하면 가리지 않은 텍스트를 요약하는 대신 압축이나 `/tree` 이동을 취소합니다.

각 경우 세션마다 한 번 `pi-redact: masking failed for <where>; the affected content was withheld instead of sent` 오류를 표시합니다. `<where>`는 `a bash result`, `a model request`, `compaction`, `a branch summary` 등입니다. `/redact`는 안내문으로 바꾼 항목 수를 셉니다.

## 성능

모델 요청을 가릴 때 대화 전체를 한 번 검사하고, 이후 요청에서 반복되는 텍스트는 그 결과를 재사용합니다. 서로 다른 텍스트 기준 최대 8,388,608자(8 × 1024 × 1024)까지 보관합니다. Node.js 24.14와 Apple M4 Pro에서 100만 자 대화는 첫 요청에 약 22ms, 이후 요청에 1ms 미만이 걸렸습니다. 400만 자는 약 75ms와 1–2ms였고, 50KB 도구 결과 하나는 약 2ms였습니다.

## 소스 빌드와 검사

[pi-packages](https://github.com/buYoung/pi-packages) 체크아웃의 루트에서 실행합니다. 로컬 빌드를 한 세션만 사용해 보려면 다음을 실행합니다.

```sh
pnpm install
pnpm --filter "@buyong/pi-redact..." build
pi -e ./apps/pi-redact
```

자동 검사는 다음과 같이 실행합니다.

```sh
pnpm install
pnpm --filter "@buyong/pi-redact..." build
pnpm --filter @buyong/pi-redact typecheck
pnpm --filter @buyong/pi-redact lint
pnpm --filter @buyong/pi-redact test:unit
```

테스트는 미리 정한 응답을 돌려주는 모델로 실제 Pi 세션을 실행하고, 보낼 요청, 세션 파일, 압축, 브랜치 요약, 되쓰기 차단, 스위치, 분석 기록을 확인합니다. 터미널 페이지는 조작하지 않습니다.

설치된 사본을 Pi에서 확인하려면 `pi list`를 실행합니다. `User packages:` 아래에 `npm:@buyong/pi-redact`가 보입니다. 이어서 Pi에서 `/redact`를 입력하면 자동 완성에 `redact`, `redact-custom`, `redact-analytics`가 나옵니다.

## 라이선스

[Apache-2.0](LICENSE)
