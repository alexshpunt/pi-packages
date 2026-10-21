# @buyong/pi-redact

[English](README.md) | **한국어**

Pi가 언어 모델에 보내기 전에 인증 정보와 개인 키를 가리는 Pi 확장입니다. 도구 결과는 Pi가 저장하거나 화면에 보여 주기 전에 가리고, 모든 모델 요청·압축·브랜치 요약은 보내기 직전에 한 번 더 검사합니다. 탐지한 값은 `{{REDACTED}}`가 되며, 모델이 이 표식을 파일이나 명령에 다시 쓰는 호출은 차단합니다.

탐지는 [`@buyong/redact`](https://github.com/buYoung/pi-packages/blob/main/packages/redact/README.ko.md)가 담당합니다. 기본 토큰·인증 정보 규칙, PEM 개인 키, `PASSWORD=…` 같은 민감한 대입문과, [설정](#설정)의 `piiEntities`로 켠 개인정보(기본값은 꺼짐)를 탐지합니다. 모든 비밀을 찾는다고 보장하지 않으므로, 사용하기 전에 [가리지 않는 것](#가리지-않는-것)을 확인하세요.

## 요구 사항

- Node.js 22.19 이상
- Pi 1.3.0. `@earendil-works/pi-coding-agent` 1.3.0으로 빌드하고 테스트했습니다. 이전 버전은 테스트하지 않았습니다.

## 설치

게시된 릴리스를 설치합니다.

```sh
pi install npm:@buyong/pi-redact
```

## 가림이 동작하는지 확인

이 확인에는 Pi에 설정된 모델이 필요합니다. 빈 디렉터리에 `API_KEY=sk-example0123456789abcd`가 든 `.env` 파일을 만들고, 그 디렉터리에서 `pi`를 시작한 뒤 모델에게 `.env`를 읽게 합니다. 결과에 `API_KEY={{REDACTED}}`가 보입니다. 이어서 `/pi-redact`를 실행하면 적용 중인 설정과 함께, 이 세션에서 가린 도구 결과 1건을 보고합니다.

## 하는 일

| 시점 | pi-redact의 동작 |
| --- | --- |
| 도구가 결과를 돌려줄 때 (`read`, `bash`, `grep`, MCP 도구 등) | 결과의 텍스트, `details`, `structuredContent`를 Pi가 세션 파일에 저장하고 화면에 보여 주기 전에 가립니다. `read` 결과는 파일 경로를 함께 넘겨 검사하므로 `.env`, `.ini`, `.properties`, `.cfg`의 값은 줄 끝까지 가립니다. |
| 모든 모델 요청 | 전송하는 사본에서 사용자 메시지, 어시스턴트 텍스트, 도구 호출 인자, 도구 결과, `!` 명령 출력, 확장 메시지, 요약을 가립니다. 모든 `context` 핸들러 다음에 실행되므로 다른 확장이 추가한 텍스트도 가립니다. |
| 압축과 브랜치 요약(`/tree`로 브랜치를 떠날 때 만드는 요약) | Pi가 요약할 대화를 가립니다. Pi는 이 요청을 context 훅 없이 보내므로 따로 처리합니다. |
| 모델이 `write`, `edit`, `bash`, `powershell`을 호출할 때 | 되쓰기 차단이 `{{REDACTED}}`를 쓰게 되는 호출을 막습니다. 막는 호출은 표식이 들어간 셸 명령, 파일에 이미 있는 개수보다 표식을 더 쓰는 `write`, `newText`의 표식 개수가 `oldText`보다 많은 `edit`입니다. 모델은 차단 이유를 받고 사용자에게는 경고가 표시됩니다. |
| 에이전트 실행마다 | 시스템 프롬프트에 지침 하나를 더합니다. `{{REDACTED}}`는 가린 값이므로 쓰지 말고, 그 줄을 피해 편집하거나 사용자에게 값을 요청하라는 내용입니다. |

`grep -n`, `rg`, `cat -n`, 줄 번호를 붙이는 도구, diff가 줄 앞에 붙인 접두사는 떼고 다시 검사합니다. 그래서 `.env:2:DB_PASSWORD=value`와 `+API_TOKEN=value`도 일반 대입문처럼 가립니다.

### 표식

가린 구간은 길이와 관계없이 모두 `{{REDACTED}}`가 됩니다. 줄마다 따로 바꾸고 줄바꿈은 그대로 두므로, 가린 파일의 줄 번호는 디스크의 파일과 같습니다. 그래서 모델은 비밀이 있는 파일의 다른 줄을 편집할 수 있습니다. `oldText`에 가린 줄이 들어간 편집은 일치하는 곳이 없어 실패할 뿐입니다.

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

설정은 선택 사항이며 `@buyong/redact` 설정 키를 쓰는 JSON 파일입니다. 기본 규칙에 더해질 뿐 기본 규칙을 끌 수는 없습니다. `exceptions`만 정확히 일치하는 값을 보이게 둡니다.

| 파일 | 적용 조건 |
| --- | --- |
| `~/.pi/agent/pi-redact/settings.json` (또는 `$PI_CODING_AGENT_DIR/pi-redact/settings.json`) | 항상 |
| `<프로젝트>/.pi/pi-redact/settings.json` | Pi에서 프로젝트를 신뢰한 경우에만(Pi 시작 시 묻는 창이나 `/trust`로 설정) |

```json
{
  "sensitiveFields": ["OPENAI_KEY", "SESSION_KEY"],
  "rules": [{ "id": "custom.env-key", "pattern": "^[A-Z0-9_]*_KEY=(?<secret>.+)$", "flags": "m" }],
  "exceptions": [{ "ruleId": "custom.env-key", "value": "example-value" }],
  "piiEntities": ["EMAIL_ADDRESS"]
}
```

- `sensitiveFields`는 글자와 숫자만 남겨 대소문자 구분 없이 비교하는 정확한 이름입니다(`OPENAI_KEY`는 `openaiKey`와 일치).
- `rules[].id`는 `custom.`으로 시작해야 합니다. 규칙은 일치한 구간 전체를 가리고, 패턴에 이름 있는 그룹 `(?<secret>…)`이 있으면 그 그룹만 가립니다. 패턴은 신뢰할 수 없는 텍스트에서 실행되므로 중첩 반복은 피하세요.
- `exceptions`는 한 규칙 id에서 정확히 일치하는 값 하나를 보이게 둡니다. `piiEntities`는 이름을 적은 개인정보 엔티티를 켭니다. 기본 규칙 id는 `@buyong/redact` README의 [규칙](https://github.com/buYoung/pi-packages/blob/main/packages/redact/README.ko.md#규칙), 엔티티 이름은 [PII](https://github.com/buYoung/pi-packages/blob/main/packages/redact/README.ko.md#pii), 패턴 문법과 허용하는 `flags`는 [설정](https://github.com/buYoung/pi-packages/blob/main/packages/redact/README.ko.md#설정)에 있습니다.
- 프로젝트 설정은 전역 설정에 더해지며, id가 같은 프로젝트 규칙은 전역 규칙을 대신합니다.
- 파일이 없으면 알리지 않고 건너뜁니다. 파일이 있지만 읽을 수 없거나, 올바른 JSON이 아니거나, 잘못된 설정이 들어 있으면 그 파일을 통째로 건너뜁니다. 이때 세션마다 한 번 경고하고(Pi에 UI가 없으면 stderr에 출력), `/pi-redact`는 그 파일을 `Skipped:` 줄로 보여 줍니다. 알림에는 설정 키와 배열 인덱스만 나오며 설정한 값은 나오지 않습니다. 나머지 파일과 기본 규칙으로 계속 가립니다.

설정은 세션이 시작될 때 읽습니다. 수정한 뒤에는 `/reload`를 실행하거나 새 세션을 시작하세요.

## 가리기에 실패하면

pi-redact는 가리지 못한 텍스트를 보내지 않습니다. 가리지 못한 텍스트를 대신하는 안내문은 `[pi-redact withheld this content because masking it failed]`입니다.

- 가리지 못한 도구 결과는 안내문으로 바꾸고 오류로 표시합니다.
- 모델 요청이나 요약에서 가리지 못한 메시지는 안내문으로 바꿉니다. 모델 요청에서 그마저 실패하면 실행을 중단하고, 요청의 대화 내용을 안내문 하나로 바꿉니다.
- 요약 입력 전체를 처리하지 못하면 가리지 않은 텍스트를 요약하는 대신 압축이나 `/tree` 이동을 취소합니다.

각 경우 세션마다 한 번 `pi-redact: masking failed for <where>; the affected content was withheld instead of sent` 오류를 표시합니다. `<where>`는 `a bash result`, `a model request`, `compaction`, `a branch summary` 등입니다. `/pi-redact`는 안내문으로 바꾼 항목 수를 셉니다.

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

테스트는 미리 정한 응답을 돌려주는 모델로 실제 Pi 세션을 실행하고, 보낼 요청, 세션 파일, 압축, 브랜치 요약, 되쓰기 차단을 확인합니다.

## 라이선스

[Apache-2.0](LICENSE)
