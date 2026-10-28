# @buyong/pi-ollama-cloud

[English](README.md) | **한국어**

로컬 Ollama 서버 없이 Pi를 Ollama Cloud API에 연결하는 확장입니다. 클라우드 모델 목록, 웹 검색·페이지 읽기, 사용량 조회와 여러 계정의 세션별 순환 사용을 제공합니다.

소스와 배포는 [`buYoung/pi-packages`](https://github.com/buYoung/pi-packages/tree/main/apps/pi-ollama-cloud)에서 관리합니다. npm 이름은 그대로입니다. [fgrehm/pi-ollama-cloud](https://github.com/fgrehm/pi-ollama-cloud)에서 시작한 포크이며, 기존 `buYoung/pi-ollama-cloud`의 Git 이력과 MIT 라이선스를 보존합니다.

## 설치와 첫 사용

Node.js 22.19 이상, Pi, [Ollama Cloud API 키](https://ollama.com)가 필요합니다. 이 패키지는 Pi 1.3.0으로 개발·검증하며, CI에서 최신 Pi와의 호환성도 확인합니다.

Git으로 설치했거나 0.13 이하 버전의 명령·import 경로를 쓰고 있었다면, 확장이 한 벌만 로드되도록 먼저 [이전 버전에서 옮기기](#이전-버전에서-옮기기)를 따르세요. 그렇지 않다면 npm으로 설치합니다.

```bash
pi install npm:@buyong/pi-ollama-cloud
```

프로젝트에만 설치하려면 대신 `pi install npm:@buyong/pi-ollama-cloud --local`을 실행합니다. 프로젝트 리소스는 Pi의 프로젝트 신뢰 설정을 따릅니다.

Pi를 시작한 뒤 다음 순서로 사용합니다.

1. `/login`에서 **Use an API key → Ollama Cloud**를 선택해 키를 입력하거나, Pi를 실행하는 환경에 `OLLAMA_API_KEY`를 설정합니다. 이미 키를 등록했다면 생략합니다. 키를 저장소나 설정 예제에 넣지 마세요.
2. `/model`에서 `ollama-cloud` 모델을 선택합니다.
3. 짧은 질문을 보내 응답을 확인합니다. 이 요청부터 모델 응답과 웹 도구는 실제 API 사용량을 씁니다. `/ollama`에서 계정별 사용량과 설정을 확인할 수 있습니다.

계정을 더 쓰려면 [여러 계정 사용](#여러-계정-사용)을 참고해 `/ollama`의 **+ Add account**로 추가합니다.

### 업데이트

```bash
pi update npm:@buyong/pi-ollama-cloud
```

대상 없이 `pi update`만 실행하면 Pi 자체를 업데이트합니다. 설치한 모든 확장을 업데이트하려면 `pi update --extensions`를 실행합니다. 정확한 버전에 고정한 설치는 새 버전으로 자동으로 바뀌지 않으므로, 새 버전을 지정해 `pi install`을 다시 실행합니다.

## 도구와 명령

| 이름 | 용도 |
| --- | --- |
| `ollama_web_search` | Ollama Cloud 웹 검색. 필수: `query`. 선택: `max_results`(기본 5, 최대 10), `expand`, `offset`, `refresh` |
| `ollama_web_fetch` | 웹 페이지의 제목·본문·링크 읽기. 필수: `url`. 선택: `full`, `offset`, `refresh` |
| `/ollama` | TUI에서 [설정 화면](#설정-화면)을 엽니다. TUI가 아니면 설정과 계정 요약을 출력합니다. |
| `/ollama usage` | 모든 계정의 잔액·할당량·상태와 확인 가능한 갱신일, 현재 세션 계정의 요청 통계를 조회합니다. |
| `/ollama status [on\|off]` | TUI 하단 사용량 표시를 켜거나 끕니다. 인수를 생략하면 현재 상태를 반대로 바꿉니다. 전역 설정에 저장합니다. |
| `/ollama webtools [on\|off]` | 웹 도구를 켜거나 끕니다. 인수를 생략하면 현재 상태를 반대로 바꿉니다. 전역 설정에 저장합니다. |

print·JSON 모드처럼 UI가 없는 환경에서는 `/ollama`의 요약·사용량·설정 저장 결과·오류를 stderr로 출력합니다. JSON 모드의 stdout 이벤트 스트림에는 명령 안내를 섞지 않습니다.

웹 도구는 모델 요청과 같은 계정, 즉 현재 세션에 배정된 계정의 API 키를 사용합니다.

- **`ollama_web_search`**: 결과마다 본문 미리보기를 기본 500자까지 보여 줍니다. 한 결과의 본문을 더 읽으려면 같은 `query`와 `max_results`에 `expand=<1부터 시작하는 결과 번호>`를 지정합니다. 이어 읽을 때는 `query`·`max_results`·`expand`를 그대로 두고 반환된 `nextOffset`을 `offset`으로 넘깁니다. 결과에도 그다음 호출이 적혀 있습니다. `expand` 없이 `offset`만 지정하면 결과 목록 문자열에서 그 위치부터 읽습니다.
- **`ollama_web_fetch`**: 페이지 본문을 기본 3000자씩 반환합니다. `full=true`를 지정해도 무제한이 아니라 출력 상한 안에서 가장 큰 조각을 반환합니다. 남은 본문이 있으면 `nextOffset`이 오므로, 그 값을 `offset`으로 넘겨 `nextOffset`이 없을 때까지 같은 `url`로 이어 읽습니다.
- `content`와 `details`를 합친 결과는 Pi의 출력 상한(Pi 1.3.0 기준 51,200바이트·2,000줄)을 따릅니다. 제목·URL·링크·`details`의 본문도 길이를 제한한 미리보기입니다.
- `offset`은 JavaScript 문자열의 UTF-16 위치입니다. 직접 계산하지 말고 `nextOffset`을 그대로 넘기세요. 이어 읽을 때 캐시 항목이 유효 시간(기본 24시간) 안에 있고 아직 지워지지 않았으면 API를 다시 호출하지 않습니다. 항목이 만료·제거되었거나 다른 호출이 `refresh=true`로 갱신했다면 검색 결과나 페이지를 다시 가져오므로 내용이 달라질 수 있습니다.
- 두 도구 모두 `refresh=true`로 캐시를 건너뛰고 다시 요청합니다. 결과의 `# live query`는 새 요청이나 함께 진행 중인 요청의 결과, `# from cache`는 캐시 결과라는 뜻입니다.

## 여러 계정 사용

계정을 여러 개 등록하면 각 세션이 계정 하나를 고정해 쓰고, 새 세션은 다음 계정을 받습니다. 한 계정의 사용량 한도에 도달하면 그 세션은 다음 계정으로 넘어갑니다.

계정을 추가하기 전에 확인하세요. 같은 Ollama 계정에서 만든 키 여러 개는 이 확장이 구분할 수 없으며 사용량 한도를 함께 씁니다. 각자 정당하게 보유한 계정만 등록하세요. 한도를 피하려고 계정을 여러 개 만들면 Ollama가 남용으로 판단할 수 있습니다. 여러 사람이 함께 쓰려면 Team 요금제를 검토하세요.

### 계정 구성

- **기본 계정(`default`)**: Pi의 `ollama-cloud` 자격 증명입니다. `/login`이나 `OLLAMA_API_KEY`로 설정하며, Pi가 모델을 사용 가능으로 표시하려면 필요합니다. 제거는 `/logout`으로 합니다.
- **추가 계정**: `~/.pi/agent/ollama-cloud-accounts.json`에 저장합니다. Pi의 agent 디렉터리를 바꾸면 이 파일도 그 디렉터리를 따릅니다. 형식은 Pi의 `auth.json`과 같고, Pi의 자격 증명 저장 계층으로 읽고 쓰므로 파일 권한 `0600`과 잠금 방식도 같습니다. 키는 값 그대로 적거나 `$ENV`·`${ENV}`·`!command` 참조로 적을 수 있습니다.
- 계정 ID는 영문 소문자·숫자·`-`·`_`로 된 1~32자이며, 글자나 숫자로 시작해야 합니다. `default`, `ollama-cloud`와 Pi 내장 공급자 이름(예: `anthropic`)은 쓸 수 없습니다.

TUI에서는 `/ollama`의 **+ Add account**에서 키나 참조를 먼저 입력하고 이어서 계정 ID를 정합니다. 비워 두면 `account-1`처럼 아직 쓰지 않은 ID를 붙입니다. 입력 중인 키와 계정 목록의 키는 앞 6자리만 표시하며, ID 칸에 키를 잘못 붙여 넣어도 전체를 표시하지 않습니다. 저장한 뒤 `/api/balance`로 키를 확인하며, Ollama가 키를 거부하거나 이미 등록한 키와 같으면 저장하지 않습니다. TUI가 아닌 환경에서는 파일을 직접 편집하며, 다음 요청 때 바뀐 파일을 읽습니다.

```json
{
  "work": { "type": "api_key", "key": "$OLLAMA_WORK_API_KEY" },
  "personal": { "type": "api_key", "key": "!op read op://Private/ollama/credential" }
}
```

Pi 1.3.0은 `!command` 결과를 프로세스가 끝날 때까지 캐시합니다. 명령이 반환하는 키를 바꿨다면 Pi를 다시 시작해야 새 값을 읽습니다. `/reload`는 명령을 다시 실행하지 않습니다.

### 세션 고정 순환

- 세션의 첫 Ollama Cloud 요청(모델 응답이나 웹 도구)에서 순번상 다음 계정을 배정합니다. 순번은 `default` 다음에 `ollama-cloud-accounts.json`에 적힌 순서이며, 마지막 계정 다음에는 처음으로 돌아갑니다.
- 배정은 세션 파일에 기록됩니다. Pi를 재시작하거나 `/resume`·`/reload`해도 같은 세션은 같은 계정을 씁니다. `/new`와 fork는 새 세션이므로 다음 계정을 받습니다.
- 같은 세션의 압축 요청과 웹 도구도 그 계정을 씁니다. 여러 Pi 프로세스와 서브에이전트는 `~/.pi/agent/ollama-cloud-account-state.json`으로 순번과 계정 상태를 공유합니다. 이 파일에는 키가 아니라 키 지문, 한도 도달 시각과 잔액 응답만 저장합니다.
- `/ollama`에서 계정을 선택하고 **Use for this session**을 고르면 현재 세션의 계정을 직접 바꿉니다.

상태 파일이 잠겨 있거나 저장에 실패하면 변경 사항을 현재 프로세스에만 보관합니다. 그 사이 다른 프로세스가 파일을 바꾸지 않았다면 다음 갱신 때 함께 저장하고, 바꿨다면 파일의 상태를 따릅니다.

### 계정 전환과 한도

응답이 시작되기 전에 다음 오류가 오면 그 계정을 표시해 두고 같은 요청을 다음 계정으로 다시 보냅니다. 세션은 새 계정으로 넘어가며 알림을 한 번 표시합니다.

| 응답 | 처리 |
| --- | --- |
| 429 `session`·`weekly`·`monthly usage limit` | `/api/balance`가 알려 준 재설정 시각까지 그 계정을 제외합니다. 시각을 알 수 없으면 session은 30분, weekly는 6시간, monthly는 24시간 뒤 다시 시도합니다. |
| 401 키 거부 | `/ollama`에서 **Clear limit markers**를 실행하거나 그 계정의 키가 바뀔 때까지 계정을 제외합니다. 다음 요청 때 `$ENV`·`${ENV}` 참조를 다시 읽으므로, 변수가 다른 키를 돌려주면 그 계정을 다시 씁니다. `!command` 참조는 Pi를 다시 시작할 때까지 캐시한 결과를 씁니다([계정 구성](#계정-구성) 참고). |
| 403 모델 거부 | 그 모델을 요청할 때만 그 계정을 6시간 동안 제외합니다. 웹 도구 요청이 403을 받으면 계정을 바꾸지 않습니다. |

응답이 시작되기 전에 동시 요청 한도(`429 "too many concurrent requests"`)에 걸리면 계정을 바꾸지 않고 같은 계정으로 다시 보냅니다. 여러 세션이나 서브에이전트가 한 계정을 함께 쓰면 다른 요청이 끝나야 자리가 나기 때문입니다. 약 1·2·4·8·16초(각각 0.5~1.5배 사이로 흩뜨림)를 기다리며 최대 다섯 번 다시 보내고, 처음 기다릴 때 알림을 한 번 표시합니다. 그래도 자리가 나지 않으면 Pi의 기본 재시도로 넘깁니다. 기다리는 중에 취소하면 바로 멈춥니다.

그 밖의 요청 제한(429), 서버 오류와 응답이 시작된 뒤의 오류는 계정을 바꾸지 않고 Pi의 기본 재시도에 맡깁니다. 쓸 수 있는 계정이 없으면 계정별 사유와 `quota exceeded`를 담은 오류를 반환하며, Pi는 이 오류를 자동으로 다시 시도하지 않습니다.

## 구매 크레딧 보호

Ollama는 포함 사용량을 먼저 쓰고, 다 쓰면 구매 크레딧에서 차감합니다. 구매 크레딧이 남아 있으면 한도 오류 없이 요청이 계속 처리되므로, 구매 크레딧이 있는 계정은 포함 사용량이 3% 이하로 남으면 요청을 보내지 않습니다. 계정이 하나여도 적용됩니다.

- 계정마다 첫 요청 전에 `/api/balance`를 한 번 조회합니다. 구매 크레딧이 없는 계정은 새 구매를 알아차리려고 15분마다, 있는 계정은 남은 양에 따라 30초~10분마다 다시 조회합니다.
- 잔액 사전 조회에서 키가 거부(401)되면 그 계정의 다음 조회에서 참조 키를 다시 읽습니다. 환경 변수 참조의 새 값은 `/reload` 없이 반영되며, `!command`는 위에서 설명한 Pi 프로세스 캐시 제한을 따릅니다.
- 조회와 조회 사이에 쓴 사용량은 막지 못합니다. 남은 포함 사용량이 적을수록 자주 조회해 그 차이를 줄입니다.
- 잔액 조회가 한 번도 성공하지 못한 계정은 요청을 막지 않고 `available (balance not verified)`로 표시합니다.
- 구매 크레딧이 확인된 계정은 잔액을 다시 조회하지 못하면, 남은 포함 사용량이 10% 미만이거나 마지막 성공 조회가 30분 이상 지났을 때 요청을 막습니다. 잔액 조회는 1분 뒤 다시 시도하며, 확인되면 요청을 다시 보냅니다.

## 설정 화면

TUI에서 `/ollama`를 실행하면 설정 화면이 열립니다. 위아래 화살표로 이동하고 Enter나 Space로 바꾸며, Esc로 닫습니다.

제목 바로 아래에 사용량 보고서가 표시됩니다. 계정마다 할당량 막대, 포함 잔액과 갱신일, 구매 크레딧을 보여 주고, 현재 세션 계정(배정 전에는 첫 계정)에는 7일 요청 수도 보여 줍니다. 보고서는 화면이 열려 있는 동안에만 갱신하고, 닫으면 조회를 멈춥니다.

- 잔액(`/api/balance`)은 5초마다 모든 계정을 다시 조회합니다. 이전 조회가 끝난 뒤에 다음 조회를 예약하므로 요청이 겹치지 않습니다.
- 요청 통계(`/api/usage`)는 조회 제한이 낮아 15초에 한 번만 조회합니다. 외부 관찰에 따르면 분당 약 5회를 넘으면 429를 반환합니다.
- 잔액 조회가 429를 받으면 30초 뒤에 다시 조회하고 보고서에 그 사실을 표시합니다.

| 항목 | 동작 |
| --- | --- |
| Usage status bar | 하단 사용량 표시(`usageStatus`)를 켜고 끕니다. 전역 설정 파일에 저장합니다. |
| Web tools | `ollama_web_search`·`ollama_web_fetch`를 켜고 끕니다. 전역 설정 파일에 저장하며, `PI_OLLAMA_WEB_TOOLS`가 웹 도구를 끄고 있으면 잠깁니다. |
| 계정 행 | 계정 ID(현재 세션 계정은 `*`), 키 앞 6자리, 마지막 사용량, 상태를 표시합니다. 사용량은 보고서와 함께 갱신됩니다. Enter로 **Use for this session**, **Disable**/**Enable**, **Clear limit markers**, **Remove account**(추가 계정만, 확인 후 삭제)를 고릅니다. |
| + Add account | 키나 `$ENV`·`!command` 참조를 입력한 뒤 계정 ID를 정합니다(비우면 `account-N`). 키는 앞 6자리만 표시합니다. |

`default` 계정은 여기서 삭제할 수 없으며 `/logout`으로 제거합니다.

## 설정

전역 설정은 `~/.pi/agent/ollama-cloud.json`, 프로젝트 설정은 `.pi/ollama-cloud.json`입니다. Pi의 agent 디렉터리를 바꾸면 전역 설정 위치도 그 디렉터리를 따릅니다.

```json
{
  "webTools": true,
  "usageStatus": false
}
```

프로젝트 설정이 전역 설정보다 우선합니다. `PI_OLLAMA_WEB_TOOLS` 환경 변수는 두 파일보다 우선하며, 값이 대소문자와 관계없이 `0`, `false`, `no`, `off` 또는 빈 문자열이면 웹 도구를 끄고 `/ollama`에서도 켤 수 없습니다. 그 밖의 값은 웹 도구를 켭니다. 설정 파일을 직접 바꾼 뒤에는 Pi를 재시작하거나 `/reload`합니다.

`/ollama`에서 바꾼 하단 사용량 표시와 웹 도구 설정은 바로 적용되고 전역 설정 파일에 저장되며, 파일의 다른 키는 그대로 둡니다. 프로젝트 설정이 같은 항목을 지정하고 있거나 `PI_OLLAMA_WEB_TOOLS`가 웹 도구를 켜고 있으면, 바꿀 때 안내를 표시하고 다음 시작 때는 그 값이 다시 우선합니다. 전역 설정 파일이 올바른 JSON이 아니면 덮어쓰지 않고 이번 실행에만 적용합니다.

하단 사용량 표시는 기본적으로 꺼져 있습니다. 켜면 TUI에서 `ollama-cloud` 모델을 쓰는 동안에만 5분 간격으로 갱신하며, 대화 턴이 끝날 때도 5분 간격을 지킵니다. 표시를 끄거나 다른 공급자로 바꾸거나 Pi를 종료하면 진행 중인 조회와 타이머를 취소합니다. TUI가 아닌 환경에서는 백그라운드 조회를 하지 않습니다. 계정이 여러 개면 현재 세션 계정의 사용량을 이름과 함께 표시하고, 배정 전에는 `default`를 표시합니다. 조회 결과는 구매 크레딧 보호에도 씁니다. `/ollama usage`와 설정 화면의 사용량 보고서는 별도로 명시한 조회이므로 상태 표시가 꺼져 있어도 API를 호출합니다.

### 웹 도구 캐시

기본 파일은 `~/.pi/agent/cache/pi-ollama-cloud/cache.json`이며 파일 권한은 `0600`입니다.

| 환경 변수 | 기본값 | 의미 |
| --- | --- | --- |
| `PI_OLLAMA_SEARCH_TTL_HOURS` | `24` | 성공 결과 유지 시간 |
| `PI_OLLAMA_SEARCH_FAIL_TTL_MINUTES` | `15` | 캐시할 수 있는 페이지 실패의 유지 시간 |
| `PI_OLLAMA_SEARCH_CACHE_PATH` | agent 디렉터리의 `cache/pi-ollama-cloud/cache.json` | 캐시 파일 위치 |
| `PI_OLLAMA_SEARCH_MAX_ENTRIES` | `500` | 검색·페이지 각각의 최대 항목 수 |
| `PI_OLLAMA_SEARCH_SNIPPET_CHARS` | `500` | 검색 결과 미리보기 길이 |
| `PI_OLLAMA_SEARCH_CHUNK_CHARS` | `3000` | 페이지 본문 조각 길이 |

인증 오류, 요청 제한, 통신 오류, 서버 오류와 잘못된 응답 형식은 실패 캐시에 저장하지 않습니다. `refresh=true` 요청이 이런 오류로 실패하면 이전 항목도 지워, 다음 요청이 정상적으로 다시 시도하게 합니다.

캐시 크기는 메모리 8 MiB(직렬화한 크기 기준), 디스크는 항목당 256 KiB·전체 8 MiB로 제한합니다. 메모리 수치는 프로세스의 heap이나 RSS 상한이 아닙니다. 전체 한도를 넘으면 본문을 잘라 저장하지 않고 오래된 항목을 통째로 지웁니다. 256 KiB를 넘는 항목은 메모리에만 두므로, 다른 프로세스나 다음 세션에서는 다시 가져옵니다.

같은 캐시와 인증을 쓰는 동일한 요청이 동시에 진행되면 결과를 공유합니다. 한 호출을 취소하면 그 호출만 끝나고, 공유하던 호출이 모두 취소되면 전송을 멈춥니다. 여러 프로세스가 캐시 파일을 함께 쓸 때는 잠금을 잡고 변경 사항을 병합합니다. 다른 프로세스가 저장한 뒤에는 디스크에 없는 메모리 전용 항목이 사라질 수 있습니다.

캐시는 본문 전체와 URL을 저장하며, 같은 캐시 경로를 쓰는 세션이 다시 사용합니다. URL 쿼리에 비밀값을 넣지 마세요. 쓰기에 실패하거나 잠금 대기 시간을 넘기면 디스크에 반영되지 않을 수 있습니다.

## 모델과 추론 수준

- 공급자 이름은 `ollama-cloud`, 접속 주소는 `https://ollama.com/v1`입니다.
- `/v1/models`와 `/api/show`에서 모델과 기능을 조회하고, 도구 호출을 지원하는 모델만 등록합니다.
- Pi는 시작할 때, `/model`을 열 때, `pi update --models`를 실행할 때 모델 목록을 갱신합니다. 인증 정보가 없으면 네트워크 갱신 없이 패키지에 포함된 기본 모델 목록을 사용합니다.
- 추론 수준은 `/api/show`가 반환한 유효한 `thinking.values`를 먼저 씁니다. 없으면 패키지에 포함된 models.dev 정보를 쓰고, 그것도 없으면 기본값 `off`·`low`·`medium`·`high`·`xhigh`(`xhigh`는 `max`로 전송)를 씁니다. 서버의 기본 수준으로 사용자가 고른 수준을 덮어쓰지 않습니다. 추론을 끌 수 없다고 확인된 모델(`gpt-oss` 계열, `minimax-m2.7`)에서는 `off`를 숨깁니다.
- 컨텍스트 길이를 알 수 없으면 128,000토큰, 출력 한도를 따로 측정하지 않은 모델은 32,768토큰을 기본값으로 씁니다.
- 정상 카탈로그는 4시간마다 갱신합니다. 일부·전체 실패나 빈 목록이 오면 마지막 정상 목록과 성공 시각을 그대로 두고, 기본 15분(`PI_OLLAMA_MODEL_FAIL_RETRY_MINUTES`) 뒤 다시 시도합니다. 강제 갱신은 이 간격을 건너뜁니다.
- 모델 목록은 Pi의 모델 저장소에 저장합니다. `~/.pi/agent/cache/pi-ollama-cloud/catalog-state.json`에는 실패·출처·재시도 정보만 저장합니다. 저장한 목록을 복원할 때 패키지의 최신 가격·출력 한도·호환 정책을 다시 적용합니다.
- 첫 실행용 모델·가격·추론 정보와 측정한 출력 한도는 패키지에 포함되어 있습니다. API가 제공하지 않는 값을 보완하는 데이터이므로, 실시간 모델 목록과 달리 새 배포가 있어야 바뀝니다.

### 가격 표시의 한계

가격은 [Ollama 가격표](https://ollama.com/pricing)의 토큰 100만 개당 표준 요율로 계산한 추정치입니다. 실제 청구액·크레딧 차감액을 보장하지 않으며, Off-Peak 할인 시간대는 계산하지 않습니다. 가격을 확인하지 못한 모델은 개발용 CLI의 모델 메타데이터 조회에서 `unknown (not free)`로 표시합니다. Pi의 숫자 비용 필드에는 0이 들어갈 수 있지만 **무료라는 뜻은 아닙니다**.

가격 데이터는 패키지에 고정되어 있어 새 배포 전까지 바뀌지 않습니다. 확인되지 않은 `:cloud` 별칭이나 날짜 태그에는 다른 ID의 가격·출력 한도를 추정해 물려주지 않습니다. API가 캐시 토큰 사용량을 보고하지 않으면 캐시 할인도 `/cost`에 반영되지 않습니다. `cacheWrite` 비용 필드는 항상 0입니다.

## 제한과 지원

이 확장은 `ollama launch pi`처럼 로컬 서버를 거치지 않으며 로컬 모델은 제공하지 않습니다. 공급자 이름이 `ollama`와 `ollama-cloud`로 다르므로 두 방식을 함께 사용할 수 있습니다. 다만 이 확장을 두 벌 이상 로드하지 마세요. 예를 들어 전역과 `--local` 설치, 또는 Git과 npm 사본을 함께 쓰지 마세요.

모델 상세 조회는 요청마다 10초 제한을 둡니다. 일부 조회만 실패해도 마지막 정상 카탈로그 전체를 보존합니다. 모델이 구조화된 도구 호출 대신 원시 마크업을 출력하면 다른 모델로 다시 시도하고, 재현 정보에서 키와 개인정보를 지운 뒤 [이슈](https://github.com/buYoung/pi-packages/issues)에 남겨 주세요.

## 이전 버전에서 옮기기

### Git 설치에서 npm 설치로

기존 npm 설치는 바꿀 것이 없습니다. 기존 **Git 설치**는 `pi list`에서 설치 항목을 확인하고, 그 항목을 제거한 뒤 npm으로 설치합니다.

```bash
pi remove git:github.com/buYoung/pi-ollama-cloud
pi install npm:@buyong/pi-ollama-cloud
```

프로젝트 설치라면 두 명령 모두 `--local`을 붙입니다. 다른 URL 표기나 버전 고정을 썼다면 `pi list`에 나온 선언 그대로 제거합니다. `~/.pi/agent/extensions/`에 직접 복제한 사본은 필요한 수정 사항을 먼저 보존한 뒤 자동 탐색 경로 밖으로 옮깁니다. Git·로컬·npm 사본을 동시에 로드하지 마세요.

전환한 뒤에도 `ollama-cloud` 인증 항목, 설정 파일, 캐시 경로와 공개 도구 이름은 그대로입니다. `pi install git:github.com/buYoung/pi-packages`는 이 앱이 아니라 저장소 루트를 설치합니다. 소스 체크아웃은 [Pi에서 직접 확인](#pi에서-직접-확인)의 명령으로 로드합니다.

### 제거된 명령과 파일

| 쓰던 버전 | 제거된 항목 | 대신 쓸 것 |
| --- | --- | --- |
| 0.13 이하 | `/ollama-cloud-usage`, `/ollama-usage-status`, `/ollama-webtools` | `/ollama usage`, `/ollama status`, `/ollama webtools` |
| 0.13 이하 | 루트의 `index.ts`, `usage.ts`, `utils.ts` 등 호환용 파일(0.14.0에서 제거) | `usage.ts`: `src/usage/api.ts`([다른 확장에서 사용량 API 쓰기](#다른-확장에서-사용량-api-쓰기) 참고). `index.ts`: 패키지 디렉터리나 `src/index.ts`([Pi에서 직접 확인](#pi에서-직접-확인) 참고). `utils.ts` 등 나머지 루트 파일은 내부용이어서 공개 대체 경로가 없습니다. |
| 0.8.0 이전 | `/ollama-cloud-refresh`, 모델 캐시 `~/.pi/agent/cache/ollama-cloud-models.json` | 자동 갱신과 `pi update --models`. 이전 캐시 파일은 더 이상 읽지 않습니다. |

## 다른 확장에서 사용량 API 쓰기

사용자 정의 상태 표시 등 다른 확장에서 이 패키지의 사용량 함수를 import할 수 있습니다. 런타임과 패키지에 포함된 데이터는 모두 `src/` 아래에 있습니다. TypeScript 소스를 그대로 배포하므로 `.ts` 확장자를 붙여 import합니다.

```ts
import { fetchUsage, fetchUsageStats, formatUsage, formatUsageStatusColored } from "@buyong/pi-ollama-cloud/src/usage/api.ts";
import { getCloudApiKey } from "@buyong/pi-ollama-cloud/src/auth/context.ts";
import type { UsageData } from "@buyong/pi-ollama-cloud/src/usage/api.ts";
```

| 함수 | 동작 |
| --- | --- |
| `fetchUsage(apiKey, signal?)` | `/api/balance`를 조회합니다. 기존 할당량 창 형식과 잔액 기반 응답을 모두 지원합니다. |
| `fetchUsageStats(apiKey, range?, signal?)` | `/api/usage` 요청 통계를 조회합니다. |
| `formatUsage(data, stats?, options?)` | 여러 줄의 사용량 문자열을 만듭니다. `options.title`로 첫 줄을 바꿉니다. |
| `formatUsageSummary(data)` | 한 줄 요약을 만듭니다. 예: `5h 40% used · purchased $5.00` |
| `formatUsageStatusColored(theme, data)` | TUI 상태 표시용 문자열을 만듭니다. |
| `getCloudApiKey(ctx)` | Pi 공급자 인증을 먼저 확인하고, 없으면 `OLLAMA_API_KEY`를 씁니다. |
| `isUsageResponse(data)`, `isUsageStats(data)` | 응답 형식을 확인합니다. |

`UsageData.included.period.until`에는 API가 알려 준 갱신 경계가 들어갑니다. 상태 표시 아이디어는 [pi-ollama-cloud-usage-tracker](https://github.com/Entelligentsia/pi-ollama-cloud-usage-tracker)에서 참고했지만, 이 확장은 브라우저 쿠키 대신 API 키와 `/api/balance`를 사용합니다.

## 개발과 검증

이 절은 소스 체크아웃에서 작업하는 기여자용입니다. 모노레포 루트에서 Node.js 22.19 이상과 `pnpm@10.34.9`로 실행합니다.

```bash
pnpm install --frozen-lockfile
pnpm --filter @buyong/pi-ollama-cloud check
pnpm --filter @buyong/pi-ollama-cloud test:unit
verification_dir="$(mktemp -d)"
pnpm --filter @buyong/pi-ollama-cloud exec tsx scripts/cli/verify.ts --offline --report "$verification_dir/offline.json"
pnpm --dir apps/pi-ollama-cloud pack --pack-destination "$verification_dir/package"
```

`check`는 파일을 수정하지 않는 린트와 타입 검사입니다. 단위 테스트와 `--offline` 검증은 실제 서비스에 요청하지 않습니다. `--offline` 검증은 실제 pnpm 압축 파일을 만들어 풀고, 이미 설치된 운영 의존성만 준비해 소스와 배포물의 등록·도구·취소·reload·요청 본문도 비교합니다. 마지막 명령은 압축 파일을 `$verification_dir/package`에 남겨 직접 확인할 수 있게 합니다. 종료 코드가 0이고 보고서의 모든 검사가 통과했는지 확인하세요. 테스트·CLI·Inquirer·검증 기록은 배포물에 포함하지 않으며, 컴파일·번들 단계는 없습니다.

### 리팩토링 전후 비교

비동기 실행·공유 요청·자원 정리에 Effect `4.0.6`을 사용합니다. 기존 Promise 함수, 공급자·명령·도구 이름, 설정과 저장 형식은 유지합니다. 순수 정책과 파일 잠금 안의 동기 갱신은 비동기로 바꾸지 않습니다.

`BEFORE_PACKAGE`와 `AFTER_PACKAGE`에 운영 의존성이 설치된 변경 전·후 패키지 디렉터리의 절대 경로를 지정합니다. 모노레포 루트에서 같은 fixture를 두 설치본에 실행해 등록·명령·도구·취소·reload·최종 요청 본문의 계약을 비교합니다. 실제 API는 호출하지 않습니다.

```bash
verification_dir="$(mktemp -d)"
pnpm --filter @buyong/pi-ollama-cloud exec tsx scripts/cli/parity-offline.ts \
  --before "${BEFORE_PACKAGE:?변경 전 패키지 경로 필요}" \
  --after "${AFTER_PACKAGE:?변경 후 패키지 경로 필요}" \
  --report "$verification_dir/parity.json"
```

### 실제 모델 요청 50회

**이 검사는 실제 사용량을 소비합니다.** 실행 환경에 테스트용 `OLLAMA_API_KEY`를 비공개로 설정한 뒤 실행합니다. 개인 인증 파일은 사용하지 않습니다. 아래 명령은 현재 소스를 검사하며, `--package-dir`에 압축 파일을 풀고 운영 의존성을 설치한 디렉터리를 지정하면 배포물을 검사합니다.

```bash
verification_dir="$(mktemp -d)"
pnpm --filter @buyong/pi-ollama-cloud exec tsx scripts/cli/parity-live.ts \
  --live-50 --package-dir "$PWD/apps/pi-ollama-cloud" \
  --report "$verification_dir/live-50.json"
```

`glm-5.3-flash:cloud`에 단일 응답 10회, 문맥 유지 10회, thinking 설정 생략/low 10회, 등록된 웹 도구 왕복 20회를 보냅니다. 도구 실행 뒤의 모델 요청도 50회에 포함합니다. 요청당 최대 1,024토큰·120초이며, 검색·fetch는 각각 최대 2회, 잔액은 최대 4회, 모델 상세는 1회로 별도 제한합니다. 횟수는 전송 전에 기록하고 실패도 차감합니다. 재시도·redirect·예산 외 전송은 차단합니다.

종료 코드 0과 보고서의 `status: "pass"`, `counts.chat: 50`, `blocked: 0`을 확인합니다. 실패하면 중단하며, 기존 보고서 경로로 재실행할 수 없습니다. 새 보고서로 다시 실행하면 새 요청 예산을 사용하므로 총사용량을 별도로 확인해야 합니다. 보고서에는 키·인증 헤더·전체 응답을 남기지 않습니다. 변경 전후 각각 실행하면 채팅은 총 100회입니다.

실서비스 비교는 생성 문장이나 thinking 블록의 동일성을 보장하지 않습니다. thinking 설정을 생략해도 모델 정책에 따라 추론이 꺼지지 않을 수 있으므로, 보고서의 `payload.reasoning`에서 실제 전달값을 확인합니다. 요청 옵션과 스트림 종료, 문맥 유지, 도구 호출·캐시 재사용을 확인하며, 오류·동시성·다중 계정 경계는 오프라인 테스트로 검증합니다.

### 대화형 기능 확인 CLI

모노레포 루트의 대화형 터미널에서 실행합니다. npm 설치본이 아니라 소스 체크아웃에서 쓰는 명령입니다.

```bash
pnpm --filter @buyong/pi-ollama-cloud cli
```

`@inquirer/prompts` 메뉴에서 다음 기능을 고릅니다.

- **모델 목록 조회**: Ollama의 `GET https://ollama.com/v1/models` 응답을 조회해 모델 ID와 개수를 표시합니다. 고정된 모델 목록으로 대체하지 않으며 API 키 없이도 조회할 수 있습니다.
- **모델을 선택해 1+1 채팅**: API 목록에서 모델을 고르면 확장과 같은 모델 구성 코드와 Pi 모델 런타임으로 `1+1`을 한 번 보내고 텍스트 응답을 표시합니다.
- **모델 ID를 직접 입력해 1+1 채팅**: `glm-5.3-flash:cloud`처럼 목록에 나오지 않는 유효한 ID도 입력할 수 있습니다. `/api/show`로 확인한 뒤 입력한 ID를 그대로 등록·전송하며, 지원하지 않는 모델은 호출 전에 알려 줍니다. API 목록의 이름과 허용되는 별칭이 항상 같지는 않습니다.
- **모델 메타데이터·출처 조회 (공개 API)**: 공개 API의 기능·추론 값과, 패키지 데이터·기본값 중 어디에서 왔는지를 표시합니다.
- **기능별 검증 (오프라인)** / **전체 기능·배포물 검증 (오프라인)**: 인증, 모델, 캐시, 렌더러, 취소, 생성 파이프라인을 모의로 검증합니다. 진단은 메뉴와 별도 프로세스에서 실행합니다.
- **종료**: 메뉴를 끝냅니다. `Ctrl+C`로 중단하고 종료할 수도 있습니다.

채팅은 실제 API 사용량을 발생시킵니다. 기존 생성·검증 스크립트와 같이 Pi의 `auth.json`에 저장된 `ollama-cloud` API 키를 먼저 쓰고, 없으면 `OLLAMA_API_KEY`를 씁니다. 키는 화면이나 파일에 출력하지 않습니다. 저장된 값·`$ENV`·`${ENV}`·`!command`는 Pi의 공식 해석기로 해석합니다. Pi 1.3.0은 `!command`를 최대 10초 동안 동기로 실행하므로 취소가 그만큼 늦어질 수 있습니다.

채팅은 선택한 모델의 설정을 Pi 모델 런타임에 임시로 등록하고, 보내기 직전에 요청 본문의 모델 ID가 입력과 같은지 확인합니다. 키는 런타임 메모리로만 넘기며 세션 파일이나 개인 설정을 저장하지 않습니다. 요청은 120초, 출력은 모델 한도와 4096토큰 중 작은 값으로 제한합니다. 오류는 화면에 표시한 뒤 메뉴로 돌아가며 임시 디렉터리는 정리합니다. 채팅이 성공하면 모델 구성 경로의 추론이 동작한다는 뜻입니다. 확장의 등록·명령·도구·이벤트는 별도의 소스·배포물 검사와 아래 Pi 직접 실행으로 확인합니다.

도움말은 `pnpm --filter @buyong/pi-ollama-cloud cli --help`로 확인합니다. CLI와 `@inquirer/prompts`는 개발용이며 런타임 배포물에는 포함하지 않습니다.

### Pi에서 직접 확인

Pi는 `package.json`의 `pi.extensions: ["./src/index.ts"]`로 진입점을 찾습니다. 루트 `index.ts`는 필요하지 않습니다. `-e .../index.ts`처럼 파일 경로를 지정해 로드했다면 패키지 디렉터리나 `src/index.ts`로 바꾸세요.

개인 설정과 분리해 로드하려면 앱 디렉터리에서 다음을 실행합니다.

```bash
cd apps/pi-ollama-cloud
node --version
pnpm exec pi --version
package_dir="$(pwd -P)"
pi_cli="$package_dir/node_modules/.bin/pi"
verification_dir="$(mktemp -d)"
mkdir -p "$verification_dir/agent" "$verification_dir/work"
(
  cd "$verification_dir/work" || exit 1
  PI_CODING_AGENT_DIR="$verification_dir/agent" PI_OFFLINE=1 \
    "$pi_cli" --no-extensions --no-skills --no-prompt-templates --no-themes \
    --no-context-files --no-mcp -e "$package_dir"
)
```

Pi 입력창에서 `/ollama`(설정 화면을 열고 Esc로 닫기), `/ollama webtools off`, `/ollama webtools on`, `/reload`를 실행하고, 오류 없이 도구 상태가 바뀌는지 확인합니다. `webtools` 명령 두 개는 격리한 agent 디렉터리의 `ollama-cloud.json`에 값을 저장합니다. 이 확인은 시작과 명령 동작만 확인하며, 모델이나 API 호출의 성공을 뜻하지 않습니다. 격리 디렉터리는 코드의 파일·네트워크 접근을 막는 보안 경계가 아닙니다.

실서비스 검사에는 API 키와 사용량이 필요합니다. CI의 `Smoke pi-ollama-cloud`는 포장한 확장의 모델 응답, thinking off, 웹 도구를 확인합니다. 로컬에서 웹 도구를 실제로 확인하려면 앱 디렉터리에서 `pnpm run smoke:web-tools`를 실행합니다. 웹 검색 1회, 페이지 읽기 1회, 구매 크레딧 보호를 위한 잔액 조회 1회를 호출해 도구 결과의 크기 상한과 캐시 재사용을 확인하며, 실패해도 다시 시도하지 않습니다.

생성 데이터 갱신, 배포 승인과 태그 절차는 [유지보수 가이드](https://github.com/buYoung/pi-packages/blob/main/apps/pi-ollama-cloud/docs/maintaining.md)에 있습니다.

## 라이선스

[MIT License](LICENSE). 원저작자 표기를 유지합니다.
