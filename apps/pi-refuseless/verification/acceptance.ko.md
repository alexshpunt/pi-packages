# Refuseless 패키지 검증 기록

[English](acceptance.md) | **한국어**

소스 패키지와 npm 압축 파일 모두 로컬 검증을 통과했습니다. 자동 확인에는 Refuseless API를 흉내 내는 로컬 모의 서버를 썼고, 이 서버는 2026-10-27에 받은 실제 `GET /v1/models` 응답을 돌려줍니다. 이어서 실제 서비스에서도 모델 3개가 각각 10턴을 모두 통과했습니다.

2026-10-28에 크레딧 표시, `/pi-refuseless`, 모델 목록의 `abliterated` 필드를 추가하면서 이 기록을 고쳤습니다. 이 기능들은 모의 서버로만 확인했습니다. 실제 서비스 확인은 다시 하지 않았으므로, 아래의 실제 서비스 결과는 2026-10-27 것입니다.

## 확인한 패키지

| 항목 | 값 |
| --- | --- |
| 패키지 | `@buyong/pi-refuseless` 0.1.0 |
| 소스 | `feat/pi-refuseless-credits` 브랜치의 `apps/pi-refuseless`. `c0201d6` 기준, 2026-10-28의 커밋하지 않은 작업 트리 |
| 압축 파일 | `npm pack --ignore-scripts`로 만든 `buyong-pi-refuseless-0.1.0.tgz`, SHA-256 `6e7b0e47fa6d8d021386da7547f13ffd0384d634051023c1adcf2e8287dbe33b` |
| 압축 파일에 든 파일 | `package.json`, `src/index.ts`, `src/api.ts`, `src/command.ts`, `src/credits.ts`, `src/credits-status.ts`, `src/models.ts`, `src/settings.ts`, `src/thinking.ts`, `README.md`, `README.ko.md`, `CHANGELOG.md`, `CHANGELOG.ko.md`, `LICENSE` |
| 확장 진입점 | `pi.extensions: ["./src/index.ts"]`. `skills`, `prompts`, `themes`는 `[]` |
| 명령 | `/pi-refuseless`. 도구와 플래그는 없음 |
| 호스트 peer 의존성 | `@earendil-works/pi-ai: *`, `@earendil-works/pi-coding-agent: *`, `@earendil-works/pi-tui: *`. 런타임 `dependencies` 없음 |
| 공급자 | ID `refuseless`, 이름 `Refuseless`, `auth.apiKey`만 사용(OAuth 없음), 기본 URL `https://api.refuseless.com/v1`, API `openai-completions` |
| 환경 | 설치된 Pi 1.4.0(`~/.nvm/versions/node/v24.14.0/bin/pi`), 작업 공간 Pi SDK 1.3.0, Node.js 24.14.0, macOS 15.7.1 arm64 |

### 모델 목록 변환

Refuseless 문서에 나온 모델 목록 필드는 `id`, `object`, `created`, `owned_by`(openapi.json, `ModelObject`), 선택 필드 `context_length`(api/models), `reasoning_efforts`와 `reasoning_default`(guides/reasoning), 필수 불리언 필드 `abliterated`(openapi.json, `ModelObject`. api/models는 `-abliterated` 접미사 대신 이 필드로 구분하라고 안내함)입니다. 가격, 출력 한도, 입력 형식 필드는 없습니다.

2026-10-27에 받은 응답은 `abliterated`가 생기기 전 것이며, 모델 6개에 대해 나머지 필드만 있습니다.

- `context_length`: `deepseek-v4.1-flash-free`는 524,288, 나머지 5개는 1,048,576
- `reasoning_efforts`: `deepseek-v4.1-flash-abliterated`와 `deepseek-v4.1-flash-fast`는 `["off","low","high","max"]`, 나머지 4개는 `["low","high","max"]`
- `reasoning_default`: 6개 모두 `"low"`
- `abliterated`: 없음. 모의 서버는 ID가 `-abliterated`로 끝나는 3개에 `true`, 나머지 3개에 `false`를 넣음. 실제 값은 확인하지 않음

패키지는 모델 목록의 항목마다 다음과 같이 Pi 모델을 만듭니다.

| Pi 필드 | 값 |
| --- | --- |
| `id`, `name` | `id`. 문자열 `id`가 없는 항목은 건너뜀 |
| `contextWindow` | 양수인 `context_length`. 없으면 128,000(Pi가 사용자 정의 모델에 쓰는 기본값) |
| `reasoning`, `thinkingLevelMap` | `reasoning_efforts`에서 가져옴. Pi의 각 생각 수준은 목록에 있는 같은 이름의 값을 보냄(`none`은 `off`로 봄). 목록에 없는 수준은 `null`. 필드가 없으면 생각 수준 없음. `off`만 있으면 `reasoning`은 false |
| `reasoningDefault`(모델과 함께 저장되는 추가 필드) | `reasoning_default`가 지원 수준 중 하나이고 모델에 생각 수준이 있을 때 그 값 |
| `abliterated`(모델과 함께 저장되는 추가 필드) | 불리언인 `abliterated`. 아니면 비워 둠. ID는 보지 않음 |
| `maxTokens` | 131,072(docs.refuseless.com/sdks의 Pi 설정 값). `contextWindow`보다 크지 않음 |
| `input` | `["text"]` |
| `cost` | 모두 0 |
| `compat` | `supportsDeveloperRole: false`. openapi.json의 `ChatMessage.role`에는 `system`, `user`, `assistant`, `tool`만 있음 |

### 크레딧 잔액

`GET /v1/credits`(api/credits)는 `balance`, `reserved`, `available`, `key_limit`를 미국 달러로 돌려주며 크레딧을 쓰지 않습니다. 패키지는 Pi가 `refuseless`에 쓰는 키(저장한 키, 없으면 `REFUSELESS_API_KEY`)로, `models.json`에서 바꾼 주소를 포함한 공급자 기본 URL에서 이 값을 읽습니다. `balance`, `reserved`, `available`이 숫자가 아닌 응답은 오류로 보고, 숫자가 아닌 `key_limit`은 한도 없음으로 봅니다. 금액은 소수점 아래 2자리에서 6자리까지 표시합니다.

| 위치 | 표시 내용 | 읽는 때 |
| --- | --- | --- |
| 상태 줄(키 `refuseless-credits`) | `Refuseless <available>`. 예: `Refuseless $41.30`. 키가 없거나 읽기에 실패하면 표시하지 않음 | 대화형 Pi에서 Refuseless 모델을 쓰는 동안만. 세션 시작, 모델 선택, `agent_end`마다, 스위치를 켤 때 |
| 대화형 Pi의 `/pi-refuseless` | `Available`, `Balance`, `Reserved`, `Key limit`(null이면 `none`) 또는 오류, 그리고 스위치 `Credits in status line` | 패널을 열 때 한 번. 패널을 닫으면 읽기를 취소함 |
| 다른 모드의 `/pi-refuseless` | 같은 네 줄을 알림(RPC)이나 stderr(print, JSON)로 출력 | 한 번 |

더 새로운 읽기, 다른 공급자 모델로 바꾸기, 스위치 끄기, `session_shutdown`은 진행 중인 읽기를 취소하고 그 결과를 버립니다. 스위치는 Pi 에이전트 폴더의 `refuseless.json`에 `"creditsStatus": false`가 없으면 켜져 있습니다. 스위치를 바꾸면 바로 적용되고, 다른 키는 그대로 둔 채 그 값을 임시 파일과 이름 바꾸기로 파일에 합칩니다. JSON 객체가 아닌 파일은 바꾸지 않으며, 이때 패널이 이유를 보여 주고 바꾼 설정은 Pi를 다시 시작하거나 다시 읽을 때까지만 유지됩니다.

## 다시 확인하는 방법

`pnpm install`을 실행한 뒤 저장소 루트에서 다음을 실행하세요.

```bash
pnpm --filter @buyong/pi-refuseless typecheck
pnpm --filter @buyong/pi-refuseless test:unit
pnpm --filter @buyong/pi-refuseless cli verify
```

`cli verify`는 아래 단계를 차례로 실행하고, 화면에 출력한 폴더에 검사기 보고서와 `summary.json`을 씁니다. 검사기와 TUI 단계를 직접 실행하려면 `apps/pi-refuseless`에서 다음을 실행하세요.

```bash
pi_root="$(dirname "$(dirname "$(dirname "$(realpath "$(command -v pi)")")")")"   # 설치된 pi-coding-agent
reports="$(mktemp -d)"
node verification/scripts/validate-package.mjs . --expect verification/inventory.json \
  --runtime --pack --pi-root "$pi_root" --report "$reports/source.json"
archive_dir="$(node -e 'console.log(require(process.argv[1]).artifact.packageDir)' "$reports/source.json")"
node verification/scripts/validate-package.mjs "$archive_dir" --expect verification/inventory.json \
  --runtime --pi-root "$pi_root" --report "$reports/archive.json"
REFUSELESS_PACKAGE_DIR="$archive_dir" REFUSELESS_PI_SDK="$pi_root" pnpm exec vitest run test/integration.test.ts
```

`pi_root` 줄은 npm 전역 설치 구조(`…/pi-coding-agent/dist/bundle/cli.js`)를 가정합니다. `cli verify`는 패키지 루트를 스스로 찾습니다.

실제 서비스 확인을 다시 하려면 저장소 루트에서 본인의 키를 넣어 실행하세요. 채팅 요청은 크레딧을 씁니다.

```bash
REFUSELESS_API_KEY=<키> pnpm --filter @buyong/pi-refuseless cli live --model glm-5.3-abliterated --model glm-5.3-flash-abliterated --model deepseek-v4.1-flash-abliterated
```

## 결과

| 확인 | 대상과 Pi | 상태 | 근거 |
| --- | --- | --- | --- |
| `typecheck`(`tsgo --noEmit`) | 소스 | pass | 종료 코드 0 |
| `lint`(`biome check .`) | 소스 | pass | 종료 코드 0 |
| 전체 테스트 80개 | 소스, Pi 1.3.0 | pass | `test/provider.test.ts` 40개, `test/credits.test.ts` 19개, `test/integration.test.ts` 10개, `test/cli.test.ts` 11개. 전체를 3회 연속 통과 |
| TUI 흐름 테스트 10개 | 소스, Pi 1.4.0 | pass | `REFUSELESS_PI_SDK`를 설치된 Pi로 지정 |
| 검사기(파일 목록, 런타임, 압축) | 소스, Pi 1.4.0 | pass | pass 79, skipped 2, not_applicable 4 |
| 압축 파일의 파일이 파일 목록(`verification/inventory.json`)과 같음 | 압축 파일 | pass | 확인한 패키지 표의 파일 14개 |
| 검사기(파일 목록, 런타임) | 압축 파일, Pi 1.4.0 | pass | pass 47, skipped 1, not_applicable 6 |
| TUI 흐름 테스트 10개 | 압축 파일, Pi 1.4.0 | pass | `REFUSELESS_PACKAGE_DIR`를 풀어 놓은 압축 파일로 지정 |
| 설치된 CLI가 모델 목록을 받아 옴(RPC 모드 시작) | 소스와 압축 파일, Pi 1.4.0 | pass | `get_available_models`가 모의 서버의 모델 6개를 돌려줌. 모의 서버는 `Bearer abl_verify`가 담긴 `GET /v1/models`를 받음 |
| 설치된 `pi -p`가 저장된 목록으로 요청 | 소스와 압축 파일, Pi 1.4.0 | pass | `POST /v1/chat/completions (Bearer abl_…, model=glm-5.3-flash-abliterated, reasoning_effort=high, messages=2, tools=4)`. 새 세션은 Pi 기본 수준 `medium`으로 시작하고, Refuseless에 `medium`이 없으므로 Pi가 `high`로 올림 |
| 설치된 `pi -p "/pi-refuseless"` | 소스, Pi 1.4.0 | pass | stderr에 잔액 네 줄을 출력하고 종료 코드 0. 모의 서버는 `GET /v1/credits (Bearer abl_…)`만 받음 |
| import 검토 | 소스 | pass | 아래 참고 |
| 배포 도구 | 저장소 | pass | `changelog.mjs check` 종료 코드 0. `dry-run.mjs --list`가 `pi-refuseless`를 `hasConfig: true`, 변경 이력 문제 없음으로 표시. `configProblems`는 비어 있음 |
| 인증 정보 검사 | 패키지 파일 31개, 압축 파일 안 파일 14개, 보고서 | pass | `abl_unit-test-key` 같은 테스트용 키만 있음. 모의 서버 로그에는 키의 앞 네 글자만 남음. 실제 서비스 확인에 쓴 키는 어느 파일에도 없음 |
| 유효한 키로 `GET /v1/models` | 실제 서비스, Pi 1.4.0, 2026-10-27 | pass | 테스트용 키로 RPC 모드를 시작한 뒤 모델마다 Pi의 모델 목록에 나타남 |
| 실제 대화, 모델마다 10턴, 모델 3개 동시(`cli live`) | 실제 서비스, Pi 1.4.0, 2026-10-27 | pass | 30턴 중 30턴 통과. [실제 서비스](#실제-서비스) 참고 |

검사기 항목 중 `pass`가 아닌 것은 다음과 같습니다.

- `skipped`, 의미 단위 import·번들 검사: 직접 검토했습니다. 소스 파일은 `@earendil-works/pi-ai`와 그 `compat` 진입점(Pi 1.3.0과 1.4.0의 확장 로더가 연결함), `@earendil-works/pi-coding-agent`(타입과 `DynamicBorder`, `getSettingsListTheme`, `getAgentDir`), `@earendil-works/pi-tui`(`SettingsList`, `Text`), `node:crypto`, `node:fs`, `node:path`, 패키지 자체 파일만 import하고 전역 `fetch`를 씁니다. 다른 앱이나 개발용 파일은 import하지 않습니다.
- `skipped`, 풀어 놓은 압축 파일의 런타임·동작(소스 보고서에만 있음): 압축 파일 검사기 실행, 압축 파일 TUI 테스트, 압축 파일 CLI 확인으로 대신했습니다.
- `not_applicable`: 테마 규격과 스킬·프롬프트·테마 필터(이 패키지에는 없음), 압축 파일 실행의 npm 메타데이터와 압축(압축은 소스에서만 함).

## 실제 Pi 화면 흐름

`test/integration.test.ts`는 Pi의 `InteractiveMode`를 같은 프로세스에서 가상 터미널로 실행하고, 사용자가 입력하는 내용을 그대로 입력합니다. Pi는 `pi -e <폴더>`와 같은 방식으로 패키지 폴더에서 리소스 로더를 통해 패키지를 읽습니다. 에이전트 폴더의 `models.json`은 `refuseless`를 실제 모델 목록을 돌려주는 로컬 모의 서버로 향하게 합니다. Pi 자체의 모델 목록 서버는 닫힌 로컬 포트로 바꾸고, 127.0.0.1 밖으로 나가는 요청이 있으면 테스트가 실패합니다. Pi 1.3.0과 1.4.0에서, 소스와 압축 파일 모두 다음을 관찰했습니다.

| 단계 | 관찰 결과 |
| --- | --- |
| 시작 | ID가 `refuseless`인 공급자 하나, 모델은 없음. 다른 공급자 ID와 선택된 모델은 같은 에이전트 폴더를 패키지 없이 실행했을 때와 같음 |
| `/login` | `Select authentication method:` → `Sign in with an API key` → `Select provider to configure:`. `Refuseless`로 걸러 보면 `Refuseless • not configured`가, 키를 저장한 뒤에는 `Refuseless ✓ stored`가 나옴 |
| 키 입력 | `Login to Refuseless` / `Enter Refuseless API key`. `  abl_tui-native-key  `를 입력하면 `Saved API key for Refuseless. Credentials saved to <agent>/auth.json`이 나옴 |
| 저장된 인증 정보 | `auth.json`에 미리 있던 다른 공급자의 인증 정보는 그대로 두고 `"refuseless": { "type": "api_key", "key": "abl_tui-native-key" }`를 추가함. 세션 모델과 기본 모델 설정은 바뀌지 않음 |
| 모델 목록 | 로그인 직후 Pi가 `Bearer abl_tui-native-key`로 `GET /v1/models`를 보내고, abliterated 여부와 관계없이 모델 6개를 모두 표시함 |
| `/model` | 모델 이름으로 걸러 보면 `<id> [refuseless]`가 나오고, 고르면 `Model: <id>`가 나옴 |
| 요청 | `Mock Refuseless reply from glm-5.3-flash-abliterated` 응답이 나옴. 모의 서버는 `Bearer abl_tui-native-key`와 그 모델 ID가 담긴 `POST /v1/chat/completions`를 1번 받음 |
| 시작 수준 | 모델 없이 시작한 새 세션(생각 수준 `off`)에서 `off`를 지원하는 `deepseek-v4.1-flash-abliterated`를 고르면 `deepseek-v4.1-flash-abliterated • low`가 나오고 `reasoning_effort: "low"`를 보냄 |
| 고른 수준 | Shift+Tab을 누르면 `high`, `max`, `thinking off` 순으로 바뀜. `deepseek-v4.1-flash-fast`로 바꾸면 `off`가 유지되고 `"off"`를 보냄. `glm-5.3-abliterated`로 바꾸면 `low`, `high`, `max`만 나오고, Pi가 `off`를 `low`로 바꿔 `"low"`를 보냄 |
| 재시작 | 같은 에이전트 폴더로 새 프로세스를 시작하면 저장된 모델 6개가 있고, 다시 로그인하지 않아도 `minimax-m3.1-flash` 요청에 `Bearer abl_tui-native-key`를 보냄 |
| 거부된 키 | `wrong-key`를 입력하면 키는 저장되지만, 모델 목록 요청이 `401`을 받고 Pi가 `Saved API key for Refuseless, but its model catalog could not be refreshed; using cached models.`를 표시함. 모델은 표시되지 않음 |
| 첫 로그인 취소 | 키 입력 화면에서 Escape를 누르면 아무것도 저장하지 않고, `auth.json`에는 미리 있던 인증 정보만 남음. Pi는 `Failed to save API key for Refuseless: This operation was aborted`를 표시함. Pi 내장 공급자인 Cerebras의 키 입력에서도 같은 문구가 나오므로, 이 문구는 이 패키지가 아니라 Pi가 표시하는 것임 |
| 키 교체 취소·빈 입력 | Escape와, 공백만 입력한 뒤 Enter 모두 저장된 키를 유지함. 빈 입력에는 `Failed to save API key for Refuseless: API key is empty`가 나옴. 다음 요청도 저장된 키를 보냄 |
| `/logout` | `Select provider to logout:` → Refuseless → `Removed stored API key for Refuseless. Environment variables and models.json config are unchanged.` `refuseless` 항목만 지워지고, 그 뒤로는 Refuseless 키를 찾지 못함 |
| 선택한 모델로 요청 | 모델을 고른 뒤 그 세션의 모든 채팅 요청에 그 모델 ID와 Refuseless 키가 담김(도구 호출 왕복 포함). 테스트용으로 설정한 두 번째 공급자(`stub`)는 요청을 하나도 받지 않음 |
| 새 세션 | 테스트용 두 번째 공급자(`stub`)의 모델을 기본 모델로 저장해 두면, 새 세션은 앞서 고른 Refuseless 모델이 아니라 `stub-model`로 시작하고 Pi는 경고를 표시하지 않음. 상태 줄에는 `(stub) stub-model`이 나옴. Refuseless 모델을 기본 모델로 저장해 두면 새 세션은 그 모델로 시작함 |
| 상태 줄의 크레딧 | 키가 저장되어 있어도 Refuseless 모델을 고르기 전에는 아무것도 읽지 않음. `glm-5.3-flash-abliterated`를 고르면 상태 줄에 `Refuseless $41.30`이 나오고, 모의 서버는 저장된 키가 담긴 `GET /v1/credits`를 받음. 응답이 끝나면 Pi가 잔액을 다시 읽음 |
| `/pi-refuseless` | 잔액을 한 번 더 읽고 `Refuseless credits`, `Available  $41.30`, `Balance    $42.50`, `Reserved   $1.20`, `Key limit  none`, `Credits in status line  on`을 표시함 |
| 끄기 | `Credits in status line`에서 Enter를 누르면 `off`가 나오고 `<agent>/refuseless.json`에 `{"creditsStatus": false}`를 씀. 그 뒤 응답에서는 잔액을 읽지 않으며, 같은 에이전트 폴더로 새 프로세스를 시작해도 같고 거기서 `/pi-refuseless`는 `off`를 표시함 |
| 키 없이 `/pi-refuseless` | `No Refuseless API key. Run /login and choose Refuseless.`와 `Credits in status line  on`을 표시하고 요청은 보내지 않음 |
| `/reload` | 키는 저장되어 있고 저장된 모델 목록이 없을 때 `/model`을 열면 목록을 받아 옴. `Reloaded keybindings, extensions, skills, prompts, themes, and context files` 뒤에도 `refuseless` 공급자는 하나이고, Pi가 저장된 목록에서 같은 모델 6개를 되살리며, 모델은 여전히 모의 서버를 가리키고, 다음 요청에 저장된 키를 씀 |

Pi 1.4.0 소스를 보면 대화 요약(compaction)과 캐시 예열도 세션의 모델과 키를 그대로 쓰므로, 다른 공급자로 요청이 가지 않습니다.

## 모델 목록과 요청

`test/provider.test.ts`는 다음을 확인합니다.

- 모델 목록 요청: `GET /v1/models`는 저장된 키를 보내고, 저장된 키가 없으면 Pi를 거쳐 `REFUSELESS_API_KEY`를 보냅니다. 키가 전혀 없으면 요청을 보내지 않고 저장된 모델 목록을 유지합니다. `401`, `503`, `data`가 없는 응답에는 HTTP 상태와 Refuseless 오류를 담아 실패합니다.
- 변환: [모델 목록 변환](#모델-목록-변환)의 규칙. `context_length`가 없는 경우, `none` 별칭, 출력 한도보다 작은 컨텍스트, ID가 없는 항목을 포함합니다. `abliterated`는 ID와 관계없이 필드 값을 따르고(접미사가 없는 ID에 `true`, 있는 ID에 `false`), 필드가 없거나 불리언이 아니면 비워 두며, 저장된 모델 목록과 함께 복원됩니다.
- 저장과 복원: `models.json`으로 주소를 바꾸면 Pi는 바뀐 주소에서 모델 목록을 받아 저장하고, 새 런타임에서 요청 없이 복원합니다. Refuseless 모델 목록에서 빠진 모델은 다음 갱신 때 사라지고, 갱신에 실패하면 이전 모델 목록을 유지합니다.
- 보내는 생각 수준: 실제 모델 목록과 테스트용 항목(`["high","max"]`, `off`만, `reasoning_efforts` 없음)에서 Pi의 모든 수준을 확인합니다. 모의 서버는 모델이 지원하지 않는 값을 거부합니다. `off`가 없는 모델에 생각 수준 없이 요청하면 `reasoning_effort`를 보내지 않고, `off`만 지원하는 모델에는 이 값을 보내지 않습니다.
- 시작 수준: `reasoning_default`는 모델이 지원하는 값일 때만 쓰고(`none`은 `off`로 봄), 저장된 모델 목록과 함께 복원됩니다. 모델이 없었거나 생각 수준이 없는 모델에서 Refuseless 모델로 바꾸면, Pi는 `off`를 이어 쓰거나 `off`가 없는 모델에서는 가장 낮은 수준으로 둡니다. 그러면 패키지가 그 수준을 모델의 `reasoning_default`로 바꿉니다. 다른 방법으로 정한 수준은 그대로이며, 이어받은 세션은 바꾸지 않습니다. 테스트는 생각 수준이 있는 이전 모델, Pi 설정이 정한 수준, 이미 기본 생각 수준인 경우를 포함해 각 경우를 확인합니다.
- 채팅 요청: 모든 모델에서 시스템 프롬프트의 `system` 역할, `reasoning_content`가 있는 텍스트, 도구 호출과 결과, 캐시된 토큰이 포함된 사용량, 응답 도중 취소를 확인합니다. HTTP 401, 402, 404, 429, 503, 잘못된 JSON 조각, `finish_reason`이 없는 스트림, 응답 도중의 `insufficient_credits` 이벤트는 모두 `error` 이벤트 하나로 끝나고 `done`은 나오지 않습니다.

스트리밍과 요청은 Pi에 내장된 OpenAI chat completions 구현을 씁니다.

## 크레딧 표시

`test/credits.test.ts`는 [크레딧 잔액](#크레딧-잔액)의 규칙을 확인합니다.

- 요청: `GET /v1/credits`는 키를 보냅니다. 키 한도는 그대로 쓰고, 없으면 한도 없음으로 봅니다. HTTP 401 `invalid_key`, 429 `rate_limit_exceeded`, 503 `gateway_down`, 금액이 없는 응답에는 HTTP 상태와 Refuseless 오류를 담아 실패합니다.
- 키와 주소(Pi의 `ModelRegistry`와 `ModelRuntime` 사용): 키가 없으면 요청을 보내지 않습니다. 그다음 `REFUSELESS_API_KEY`, 이어서 저장한 키가 각각 `models.json`의 주소로 갑니다. 공급자 기본 URL이 없으면 `https://api.refuseless.com/v1/credits`로 가며, 테스트는 이 요청을 막습니다.
- 상태 줄: 세션을 시작하면 표시하고, `agent_end` 뒤에 다시 읽으며, 다른 공급자 모델로 바꾸거나 `session_shutdown`이 오면 지웁니다. 다른 모델을 쓰는 동안에는 읽지 않습니다. print 모드에서는 표시하지도 읽지도 않습니다. 키가 없거나 `401`을 받으면 표시를 지웁니다. 모델을 바꿀 때 진행 중이던 읽기는 취소되고(모의 서버에서 연결이 닫힘) 그 결과는 버려집니다.
- 스위치: 끄면 표시를 지우고, 모르는 키를 남긴 채 `creditsStatus: false`를 저장합니다. 새 확장 인스턴스는 꺼진 상태로 시작해 아무것도 읽지 않고, 켜면 바로 읽습니다. 올바른 JSON이 아닌 파일은 바꾸지 않고, 호출은 그 이유를 돌려주며, 새 인스턴스는 켜진 상태로 시작합니다.
- 다른 모드: print 모드에서는 잔액을 stderr로 출력합니다. RPC 모드에서는 잔액(`info`), 키 없음(`error`), `401`(`error`)을 알림으로 보냅니다.
- 금액 형식: `$41.30`, `$0.00`, `$0.000125`, `$1,234.50`.

## 실제 서비스

2026-10-27에 유효한 API 키로 `cli live`를 실행해, `glm-5.3-abliterated`, `glm-5.3-flash-abliterated`, `deepseek-v4.1-flash-abliterated`를 동시에 확인했습니다. 모델마다 설치된 Pi 1.4.0이 새 에이전트 폴더에서 패키지를 읽고, 모델 목록을 받아 그 모델로 바꾼 뒤 다음 대화를 진행했습니다.

생각 수준 열의 `—`는 그 턴이 앞 턴의 수준을 그대로 쓴다는 뜻입니다.

| 턴 | 요청 내용 | 정한 생각 수준 | 통과 조건 |
| --- | --- | --- | --- |
| 1 | READY라고 답하기 | — | 답에 `READY`가 있음 |
| 2 | 암호 AMBER-42 기억하기 | — | 답에 `OK`가 있음 |
| 3 | 17 × 23 | — | 답에 `391`이 있음 |
| 4 | bash로 `cat notes.txt` 실행 | — | bash가 실행되고 답에 `4096`이 있음 |
| 5 | bash로 `result.txt` 만들기 | — | bash가 실행되고, 파일에 `pi-refuseless-ok`가 있고, 답에 `DONE`이 있음 |
| 6 | 하늘이 파랗게 보이는 이유 | `high` | 답에 산란이나 파장 언급이 있음 |
| 7 | 빛의 삼원색 | `low` | 답에 빨강·초록·파랑이 있음 |
| 8 | 암호 다시 말하기 | — | 답에 `AMBER-42`가 있음 |
| 9 | "good morning"을 한국어로 | `off` | 답에 한글이 있음 |
| 10 | 대화 요약 | — | 답이 비어 있지 않음 |

모든 턴은 `stopReason`이 `stop`으로 끝나야 하고, 모든 답은 `refuseless/<모델>`에서 와야 통과합니다.

| 모델 | 통과한 턴 | 시작 생각 수준 | 토큰(입력, 캐시 포함 / 출력) |
| --- | --- | --- | --- |
| `glm-5.3-abliterated` | 10/10 | `low` | 20,090 / 346 |
| `glm-5.3-flash-abliterated` | 10/10 | `low` | 19,834 / 228 |
| `deepseek-v4.1-flash-abliterated` | 10/10 | `low` | 22,313 / 238 |

- 모든 모델이 시작 수준 규칙대로, 새 세션에서 각자의 `reasoning_default`인 `low`로 시작했습니다.
- GLM 모델은 `off`를 지원하지 않으므로 9·10턴에서 Pi가 `low`를 썼습니다. `deepseek-v4.1-flash-abliterated`는 9·10턴을 `off`로 진행했습니다.
- Pi에서 `deepseek-v4.1-flash-abliterated`는 어떤 턴, 어떤 생각 수준에서도 생각 내용을 보여 주지 않았습니다. `reasoning_effort: "high"`로 `https://api.refuseless.com/v1/chat/completions`에 직접 요청해도 `reasoning_content`가 `"."`뿐이었으므로, 이는 서비스 쪽 동작입니다. GLM 모델은 일부 턴에서 생각 내용을 돌려줬고, 가장 긴 것은 492자였습니다(`glm-5.3-abliterated`, `high`로 진행한 6턴).
- 목록의 다른 모델(`deepseek-v4.1-flash-fast`, `minimax-m3.1-flash`, `deepseek-v4.1-flash-free`)은 실제 서비스에서 써 보지 않았습니다.
- 테스트 하네스를 만드는 동안 의도하지 않은 실제 요청이 1번 나갔습니다. 초기 버전이 `models.json`을 에이전트 폴더 밖에 써서, 테스트용 키 `abl_tui-test-key`로 보낸 `Say ok.` 요청 하나가 `https://api.refuseless.com/v1/chat/completions`에 도착했습니다. 서비스는 문서에 나온 오류와 같은 `401 {"code":"invalid_key","message":"Invalid API key.","type":"api_error"}`를 돌려줬습니다. 크레딧은 쓰지 않았고, 이 요청으로는 정상 응답을 확인할 수 없습니다. 지금 하네스는 주소 설정을 직접 쓰고, 모든 Refuseless 모델이 모의 서버를 가리키지 않으면 시작하지 않으며, 127.0.0.1 밖으로 나가는 요청이 있으면 테스트를 실패시킵니다.

## 알려진 한계

- `/model`에서 Enter로 고른 모델은 지금 세션에만 적용됩니다. 새 세션은 Pi가 `--models`로 정한 모델, 저장된 기본 모델(`/model`에서 Ctrl+S), 사용 가능한 첫 모델 순으로 찾은 모델로 시작합니다. 사용 가능한 첫 모델을 고를 때는 공급자별 Pi 내장 기본 모델을 우선하는데, Refuseless에는 이 기본 모델이 없습니다. Pi는 이때 경고를 표시하지 않으므로 `/model`과 상태 줄로만 알 수 있습니다.
- Pi 자체의 모델 복원 대체(`Could not restore model …. Using …`)는 이어받은 세션에 저장된 모델을 쓸 수 없을 때 동작합니다. 테스트 하네스가 매번 새 세션을 만들기 때문에 이번 확인에서는 이 경로에 닿지 않았습니다.
- 모델 목록은 대화형 Pi(로그인 직후, `/model`을 열 때, 시작할 때)와 RPC 모드 시작 때 받아 옵니다. `pi -p`와 `pi --list-models`는 저장된 목록만 쓰고, `pi update --models`는 확장이 추가한 공급자의 모델 목록을 갱신하지 않습니다(Pi 1.4.0에서 관찰). 그래서 새 에이전트 폴더에서 처음 `pi -p --model refuseless/…`를 쓰려면 먼저 대화형 세션을 한 번 열어야 합니다.
- 모델 목록 항목에 `reasoning_efforts`가 없으면 Pi에 그 모델의 생각 수준이 없습니다. 요청에 `reasoning_effort`를 담지 않으므로 Refuseless가 모델의 기본값을 씁니다.
- 모델이 없었거나 생각 수준이 없는 모델에서 바꿀 때, Pi는 확장에 생각 수준이 어디서 왔는지 알려 주지 않습니다. 그래서 모델별 생각 수준이나 기본 생각 수준을 `off`(`off`가 없는 모델에서는 가장 낮은 수준)로 정해 둔 설정도 `reasoning_default`로 바뀝니다. Refuseless 모델로 시작하는 새 세션은 Pi 규칙을 따릅니다. `--thinking`, `/settings`의 기본 생각 수준, 둘 다 없으면 `medium` 순이고, Pi가 `medium`을 `high`로 올립니다.
- 출력 한도, 입력 형식, 가격은 모델 목록에 없습니다. refuseless.com이나 Refuseless SDKs 안내에 다른 값이 있어도, 모든 모델은 출력 131,072 토큰(`contextWindow`보다 크지 않음)과 텍스트 입력만 쓰고 비용을 표시하지 않습니다.
- 모델을 고르지 않은 상태에서 처음 로그인하면 Pi 1.3.0과 1.4.0은 `Saved API key for Refuseless, but no default model is configured for provider "refuseless". Use /model to select a model.`도 표시합니다. 이 문구는 Pi가 표시하며, README는 `/model`로 계속하라고 안내합니다.
- `models.json`에 모델이 들어 있는 `refuseless` 항목(Refuseless SDKs 안내의 Pi 설정)이 있으면, 이 패키지의 모델 중 ID가 같은 모델을 생각 수준까지 포함해 덮어씁니다. README는 이 항목을 지우라고 안내합니다.
- 크레딧 표시, `/pi-refuseless`, `abliterated`는 문서의 응답 형식을 따르는 모의 서버로만 확인했습니다. 실제 `GET /v1/credits`와 실제 `abliterated` 값은 확인하지 않았습니다.
- 상태 줄에는 `available`만 나오며 응답 도중이 아니라 응답이 끝난 뒤에 읽으므로, 긴 응답이 진행되는 동안 줄어든 잔액은 상태 줄에 바로 반영되지 않습니다. `/pi-refuseless`는 열 때 한 번 읽고, 열려 있는 동안에는 새로 읽지 않습니다.
- `balance`는 유료 크레딧만 셉니다(api/credits). 프로모션 크레딧과 요금제 사용량은 표시하지 않습니다.
- Refuseless는 키마다 분당 60번까지 잔액을 읽게 합니다. 상태 줄은 세션 시작, 모델 선택, 응답마다 한 번 읽습니다. `429`를 받으면 다음에 읽기에 성공할 때까지 아무것도 표시하지 않습니다.
