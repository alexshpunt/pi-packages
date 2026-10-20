# @buyong/pi-ollama-cloud

로컬 Ollama 서버 없이 Pi를 Ollama Cloud API에 연결하는 확장입니다. 클라우드 모델 목록, 웹 검색·페이지 읽기, 사용량 조회와 여러 계정의 세션별 순환 사용을 제공합니다.

소스와 배포는 [`buYoung/pi-packages`](https://github.com/buYoung/pi-packages/tree/main/apps/pi-ollama-cloud)에서 관리합니다. npm 이름은 그대로입니다. [fgrehm/pi-ollama-cloud](https://github.com/fgrehm/pi-ollama-cloud)에서 시작한 포크이며, 기존 `buYoung/pi-ollama-cloud`의 Git 이력과 MIT 라이선스를 보존합니다.

> 이 문서의 변경 동작은 현재 checkout의 `[Unreleased]` 기준입니다. npm에 이미 설치된 버전에 포함되었다는 뜻은 아닙니다.

## 설치와 첫 사용

Node.js 22.19 이상, Pi, [Ollama Cloud API 키](https://ollama.com)가 필요합니다. 개발 의존성은 모노레포의 Pi 1.2.0 기준이며, CI에서 최신 Pi와의 호환성도 별도로 검사합니다.

```bash
pi install npm:@buyong/pi-ollama-cloud
```

Pi를 시작한 뒤 다음 순서로 사용합니다.

1. `/login`에서 **Use an API key → Ollama Cloud**를 선택하고 키를 입력합니다. 이미 키를 등록했다면 생략합니다.
2. `/model`에서 `ollama-cloud` 모델을 선택합니다.
3. 짧은 질문을 보내 응답을 확인합니다. `/ollama`에서 계정별 사용량과 설정을 확인할 수 있습니다.

계정을 더 쓰려면 [여러 계정 사용](#여러-계정-사용)을 참고해 `/ollama`의 **+ Add account**로 추가합니다.

`/login` 대신 Pi를 실행하는 환경에 `OLLAMA_API_KEY`를 설정할 수 있습니다. 키를 저장소나 설정 예제에 넣지 마세요. 모델 응답과 웹 도구는 실제 API 사용량을 발생시킵니다.

프로젝트에만 설치하려면 `pi install npm:@buyong/pi-ollama-cloud --local`을 사용합니다. 프로젝트 리소스는 Pi의 프로젝트 신뢰 설정을 따릅니다.

### 업데이트와 이전 설치 전환

```bash
pi update npm:@buyong/pi-ollama-cloud
```

`pi update`만 실행하면 Pi 자체를 업데이트합니다. 모든 확장 업데이트는 `pi update --extensions`입니다. 정확한 버전에 고정한 설치는 자동으로 새 버전으로 바뀌지 않으므로, 새 버전을 지정해 `pi install`을 다시 실행합니다.

기존 npm 설치는 소스 변경이 필요 없습니다. 기존 **Git 설치**는 `pi list`에서 설치 선언을 확인한 뒤 해당 선언을 제거하고 npm으로 전환합니다.

```bash
pi remove git:github.com/buYoung/pi-ollama-cloud
pi install npm:@buyong/pi-ollama-cloud
```

프로젝트 설치라면 두 명령 모두 `--local`을 붙입니다. 다른 URL 표기나 버전 고정을 사용했다면 `pi list`에 나온 기존 선언으로 제거합니다. 수동으로 `~/.pi/agent/extensions/`에 복제한 사본은 필요한 수정사항을 먼저 보존하고 자동 탐색 경로 밖으로 옮깁니다. Git·로컬·npm 사본을 동시에 로드하지 마세요.

`pi install git:github.com/buYoung/pi-packages`로는 이 앱 하나를 설치할 수 없습니다. 모노레포 개발 사본은 아래 개발 명령으로 로드합니다. 이전 후에도 `ollama-cloud` 인증 항목, 설정 파일, 캐시 경로와 공개 도구 이름은 유지됩니다.

## 모델과 추론 수준

- 공급자 이름은 `ollama-cloud`, 접속 주소는 `https://ollama.com/v1`입니다.
- `/v1/models`와 `/api/show`에서 모델과 기능을 조회하고, 도구 호출을 지원하는 모델만 등록합니다.
- Pi는 시작, `/model` 열기, `pi update --models` 때 `refreshModels`를 호출합니다. 인증 정보가 없으면 네트워크 갱신 없이 패키지의 기본 모델 목록을 사용합니다.
- 추론 수준은 `/api/show`의 유효한 `thinking.values`를 우선합니다. 없으면 생성된 models.dev 정보와 보수적인 기본값을 사용합니다. 서버의 기본 수준으로 호출자의 선택을 덮어쓰지 않으며, 확인된 `off` 제한도 유지합니다.
- 컨텍스트 길이를 알 수 없으면 128000, 출력 한도를 별도로 측정하지 않은 모델은 32768을 사용합니다.
- 정상 카탈로그의 갱신 간격은 4시간입니다. 부분·전체 실패나 빈 목록은 마지막 정상 목록과 성공 시각을 보존하며, 실패 후 재시도는 기본 15분(`PI_OLLAMA_MODEL_FAIL_RETRY_MINUTES`)입니다. 강제 갱신은 간격을 우회합니다.
- 모델 목록은 Pi의 ModelsStore에 저장합니다. `cache/pi-ollama-cloud/catalog-state.json`은 실패·출처·재시도 진단만 저장합니다. 복원할 때 최신 가격·출력 한도·호환 정책을 다시 적용합니다.
- 첫 실행용 모델·가격·추론 데이터는 `src/generated/catalog.generated.ts`, 측정 출력 한도는 `src/generated/limits.generated.ts`에 있습니다. API에서 제공하지 않는 값과 초기 카탈로그를 보완하는 데이터입니다. 실시간 모델 목록과 달리 생성 데이터 변경은 새 배포가 필요합니다.

### 가격 표시의 한계

가격은 [Ollama 가격표](https://ollama.com/pricing)의 토큰 100만 개당 표준 요율을 사용한 추정치입니다. 실제 청구액·크레딧 차감액을 보장하지 않으며, Off-Peak 할인 시간대는 계산하지 않습니다. 미확인 가격은 진단에서 `unknown`으로 표시합니다. Pi의 숫자 비용 필드에는 0이 들어갈 수 있지만 **무료라는 뜻은 아닙니다**.

가격 데이터는 패키지에 고정되어 있어 새 배포 전까지 변하지 않습니다. 미확인 `:cloud` 별칭이나 날짜 태그에 다른 ID의 가격·출력 한도를 추정 상속하지 않습니다. API가 캐시 토큰 사용량을 보고하지 않으면 캐시 할인도 `/cost`에 반영되지 않습니다. `cacheWrite`는 0입니다.

## 도구와 명령

| 이름 | 용도 |
| --- | --- |
| `ollama_web_search` | Ollama Cloud 웹 검색. `query` 필수, `max_results` 기본 5·최대 10 |
| `ollama_web_fetch` | 웹 페이지 제목·본문·링크 읽기. `url` 필수 |
| `/ollama` | TUI에서 [설정 화면](#설정-화면)을 엽니다. TUI가 아니면 설정과 계정 요약을 출력합니다 |
| `/ollama usage` | 모든 계정의 잔액·할당량·상태, 확인 가능한 갱신일과 현재 세션 계정의 요청 통계 조회 |
| `/ollama status [on\|off]` | TUI 하단 사용량 표시 변경. 인수 생략 시 전환. 전역 설정에 저장 |
| `/ollama webtools [on\|off]` | 웹 도구 활성화 여부 변경. 인수 생략 시 전환. 전역 설정에 저장 |

0.13 이하의 `/ollama-cloud-usage`, `/ollama-usage-status`, `/ollama-webtools`는 제거했습니다. 각각 `/ollama usage`, `/ollama status`, `/ollama webtools`를 사용합니다.

웹 도구는 모델 요청과 같은 계정, 즉 현재 세션에 배정된 계정의 API 키를 사용합니다.

- 검색 미리보기는 기본 500자입니다. 같은 `query`와 `max_results`에 `expand=<1부터 시작하는 번호>`를 지정해 본문을 읽고, 반환된 `nextOffset`을 `offset`으로 전달해 이어 읽습니다. `expand`가 없을 때의 `offset`은 결과 목록 문자열의 위치입니다.
- 페이지 본문은 기본 3000자입니다. `full=true`도 무제한 반환이 아니라 출력 상한 내에서 가장 큰 조각을 요청합니다. `nextOffset`이 없을 때까지 같은 URL로 이어 읽습니다.
- `content`와 `details`를 합친 직렬화 결과는 Pi의 바이트·줄 수 상한을 따릅니다(검증한 Pi 1.2.0: 51,200바이트·2,000줄). 제목·URL·링크·details의 본문도 제한된 미리보기입니다.
- `offset`은 기존 JavaScript 문자열과 같은 UTF-16 위치입니다. 직접 계산하기보다 `nextOffset`을 사용하세요. 캐시가 신선하고 보관되어 있을 때만 추가 API 호출이 없습니다. 만료·제거·다른 refresh 뒤에는 재호출이나 원문 변경이 있을 수 있습니다.
- 두 도구 모두 `refresh=true`로 다시 요청합니다. `# live query`는 새 요청 또는 공유 중인 요청의 결과, `# from cache`는 캐시 결과입니다.

## 여러 계정 사용

계정을 여러 개 등록하면 각 세션이 계정 하나를 고정해 쓰고, 새 세션은 다음 계정을 받습니다. 한 계정의 사용량 한도에 도달하면 그 세션은 다음 계정으로 넘어갑니다.

### 계정 구성

- **기본 계정(`default`)**: Pi의 `ollama-cloud` 자격 증명입니다. `/login`이나 `OLLAMA_API_KEY`로 설정하며 Pi가 모델을 사용 가능으로 표시하려면 필요합니다. 제거는 `/logout`으로 합니다.
- **추가 계정**: `~/.pi/agent/ollama-cloud-accounts.json`에 저장합니다. Pi의 agent 디렉터리를 바꾸면 이 파일도 그 디렉터리를 따릅니다. 형식은 Pi의 `auth.json`과 같고, Pi의 자격 증명 저장 계층으로 읽고 써서 파일 권한 `0600`과 잠금도 같습니다. 키는 리터럴 외에 `$ENV`·`${ENV}`·`!command` 참조로 둘 수 있습니다.
- 계정 ID는 영문 소문자·숫자·`-`·`_`로 된 1~32자입니다. `default`, `ollama-cloud`와 Pi 내장 공급자 이름(예: `anthropic`)은 쓸 수 없습니다.

TUI에서는 `/ollama`의 **+ Add account**에서 키 또는 참조를 먼저 입력하고, 이어서 계정 이름을 정합니다. 이름을 비워 두면 `account-1`처럼 쓰지 않은 이름을 씁니다. 입력 중인 키와 계정 목록의 키는 앞 6자리만 표시하며, 이름 칸에 키를 잘못 붙여 넣어도 전체를 표시하지 않습니다. 저장 뒤 `/api/balance`로 키를 확인하며, Ollama가 키를 거부하거나 이미 등록한 키와 같으면 저장하지 않습니다. TUI가 아닌 환경에서는 파일을 직접 편집합니다.

```json
{
  "work": { "type": "api_key", "key": "$OLLAMA_WORK_API_KEY" },
  "personal": { "type": "api_key", "key": "!op read op://Private/ollama/credential" }
}
```

### 세션 고정 순환

- 세션의 첫 Ollama Cloud 요청(모델 응답 또는 웹 도구)에서 순번상 다음 계정을 배정합니다. 순번은 `default` 다음 파일에 적힌 순서이며 마지막 계정 뒤에는 처음으로 돌아갑니다.
- 배정은 세션 파일에 기록됩니다. Pi를 재시작하거나 `/resume`·`/reload`해도 같은 세션은 같은 계정을 씁니다. `/new`와 fork는 새 세션이므로 다음 계정을 받습니다.
- 같은 세션의 압축 요청과 웹 도구도 그 계정을 씁니다. 여러 Pi 프로세스와 서브에이전트는 `~/.pi/agent/ollama-cloud-account-state.json`으로 순번과 계정 상태를 공유합니다. 이 파일에는 키가 아니라 키 지문, 한도 도달 시각과 잔액 응답만 저장합니다.
- `/ollama`에서 계정을 선택하고 **Use for this session**을 고르면 현재 세션의 계정을 직접 바꿉니다.

### 계정 전환과 한도

응답이 시작되기 전에 다음 오류가 오면 계정을 표시하고 같은 요청을 다음 계정으로 다시 보냅니다. 세션은 새 계정으로 넘어가며 한 번 알림을 표시합니다.

| 응답 | 처리 |
| --- | --- |
| 429 `session`·`weekly`·`monthly usage limit` | `/api/balance`가 알려 준 재설정 시각까지 제외합니다. 시각이 없으면 session 30분, weekly 6시간, monthly 24시간 뒤 다시 시도합니다. |
| 401 키 거부 | `/ollama`의 **Clear limit markers**나 키 변경 전까지 제외합니다. 참조로 둔 키는 다시 해석합니다. |
| 403 모델 거부 | 그 모델 요청에서만 6시간 제외합니다. 웹 도구의 403은 전환하지 않습니다. |

일반 요청 제한(429), 서버 오류와 응답이 시작된 뒤의 오류는 계정을 바꾸지 않고 Pi의 기본 재시도에 맡깁니다. 쓸 수 있는 계정이 없으면 계정별 사유와 `quota exceeded`를 담은 오류를 반환하며, Pi는 이 오류를 자동 재시도하지 않습니다.

### 구매 크레딧 보호

Ollama는 포함 사용량을 먼저 쓰고, 다 쓰면 구매 크레딧에서 차감합니다. 구매 크레딧이 남아 있으면 한도 오류 없이 요청이 계속 처리되므로 구매 크레딧이 있는 계정은 포함 사용량이 3% 이하로 남으면 요청을 보내지 않습니다. 계정이 하나여도 적용됩니다.

- 계정마다 첫 요청 전에 `/api/balance`를 한 번 조회합니다. 구매 크레딧이 없는 계정은 새 구매를 알아차리려고 15분마다, 있는 계정은 남은 양에 따라 30초~10분마다 다시 조회합니다.
- 조회 간격 사이의 사용량은 막지 못합니다. 남은 포함 사용량이 적을수록 자주 조회해 차이를 줄입니다.
- 잔액 조회가 한 번도 성공하지 못한 계정은 요청을 막지 않고 `available (balance not verified)`로 표시합니다. 구매 크레딧이 확인된 계정은 잔액을 다시 확인할 수 없으면 차단합니다.

### 설정 화면

TUI에서 `/ollama`를 실행하면 설정 화면이 열립니다. 위아래 화살표로 이동하고 Enter나 Space로 바꾸며, Esc로 닫습니다.

제목 바로 아래에는 사용량 보고서가 표시됩니다. 계정마다 할당량 막대, 포함 잔액과 갱신일, 구매 크레딧을 보여 주고, 현재 세션 계정(배정 전에는 첫 계정)에는 7일 요청 수도 보여 줍니다. 보고서는 화면이 열려 있는 동안에만 갱신하고, 닫으면 조회를 멈춥니다.

- 잔액(`/api/balance`)은 5초마다 모든 계정을 다시 조회합니다. 이전 조회가 끝난 뒤에 다음 조회를 예약하므로 요청이 겹치지 않습니다.
- 요청 통계(`/api/usage`)는 조회 제한이 낮아 15초에 한 번만 조회합니다. 외부 관찰에 따르면 분당 약 5회를 넘으면 429를 반환합니다.
- 잔액 조회가 429를 받으면 30초 뒤에 다시 조회하고 보고서에 그 사실을 표시합니다.

| 항목 | 동작 |
| --- | --- |
| Usage status bar | 하단 사용량 표시를 켜고 끕니다. 전역 설정 파일에 저장합니다. |
| Web tools | `ollama_web_search`·`ollama_web_fetch`를 켜고 끕니다. 전역 설정 파일에 저장하며 `PI_OLLAMA_WEB_TOOLS=off`이면 잠깁니다. |
| 계정 행 | 계정 ID(현재 세션 계정은 `*`), 키 앞 6자리, 마지막 사용량, 상태를 표시합니다. 사용량은 보고서와 함께 갱신됩니다. Enter로 **Use for this session**, **Disable**/**Enable**, **Clear limit markers**, **Remove account**(추가 계정만, 확인 후 삭제)를 고릅니다. |
| + Add account | 키 또는 `$ENV`·`!command` 참조를 입력한 뒤 계정 이름을 정합니다(비우면 `account-N`). 키는 앞 6자리만 표시합니다. |

`default` 계정은 여기서 삭제할 수 없으며 `/logout`으로 제거합니다.

같은 Ollama 계정의 키 여러 개는 구분할 수 없어 사용량 한도를 함께 씁니다. 각자 정당하게 보유한 계정에 사용하세요. 한도를 피하려고 계정을 여러 개 만드는 사용은 Ollama가 남용으로 판단할 수 있으며, 여러 사람이 함께 쓰려면 Team 요금제를 검토하세요.

## 설정

전역 설정은 `~/.pi/agent/ollama-cloud.json`, 프로젝트 설정은 `.pi/ollama-cloud.json`입니다. Pi의 agent 디렉터리를 바꾸면 전역 설정 위치도 그 디렉터리를 따릅니다.

```json
{
  "webTools": true,
  "usageStatus": false
}
```

프로젝트 설정이 전역 설정보다 우선합니다. `PI_OLLAMA_WEB_TOOLS` 환경 변수는 두 파일보다 우선하며, `0`, `false`, `no`, `off` 또는 빈 문자열이면 웹 도구를 비활성화하며 `/ollama`에서도 켤 수 없습니다. 설정 파일을 직접 바꾼 뒤에는 Pi를 재시작하거나 `/reload`합니다.

`/ollama`에서 바꾼 사용량 상태 표시와 웹 도구 설정은 즉시 적용되고 전역 설정 파일에 저장됩니다. 파일의 다른 키는 유지합니다. 프로젝트 설정이나 `PI_OLLAMA_WEB_TOOLS`가 같은 값을 정하면 다음 시작 때 그 값이 우선하며, 변경 시 안내합니다. 전역 설정 파일이 올바른 JSON이 아니면 덮어쓰지 않고 이번 실행에만 적용합니다.

사용량 상태 표시는 기본적으로 꺼져 있습니다. TUI에서 `ollama-cloud` 모델을 사용하는 동안만 5분 간격으로 갱신하며 턴 종료도 같은 제한을 따릅니다. 끄기·공급자 전환·종료는 진행 중 조회와 타이머를 취소합니다. non-TUI에서는 background 조회를 시작하지 않습니다. 계정이 여러 개면 현재 세션 계정의 사용량을 이름과 함께 표시하고, 배정 전에는 `default`를 표시합니다. 조회 결과는 구매 크레딧 보호의 잔액 정보로도 씁니다. `/ollama usage`와 설정 화면의 사용량 보고서는 별도의 명시적 조회이므로 상태 표시가 꺼져 있어도 API를 호출합니다.

### 웹 도구 캐시

기본 파일은 `~/.pi/agent/cache/pi-ollama-cloud/cache.json`이며 파일 권한은 `0600`입니다.

| 환경 변수 | 기본값 | 의미 |
| --- | --- | --- |
| `PI_OLLAMA_SEARCH_TTL_HOURS` | `24` | 성공 결과 유지 시간 |
| `PI_OLLAMA_SEARCH_FAIL_TTL_MINUTES` | `15` | 캐시 가능한 페이지 실패 유지 시간 |
| `PI_OLLAMA_SEARCH_CACHE_PATH` | agent 디렉터리의 `cache/pi-ollama-cloud/cache.json` | 캐시 파일 위치 |
| `PI_OLLAMA_SEARCH_MAX_ENTRIES` | `500` | 검색·페이지 각각의 최대 항목 수 |
| `PI_OLLAMA_SEARCH_SNIPPET_CHARS` | `500` | 검색 결과 미리보기 길이 |
| `PI_OLLAMA_SEARCH_CHUNK_CHARS` | `3000` | 페이지 본문 조각 길이 |

인증 오류, 요청 제한, 통신 오류, 서버 오류와 잘못된 응답 형식은 실패 캐시에 저장하지 않습니다. 이런 refresh 실패는 이전 항목도 무효화해 정상 재시도를 막지 않도록 합니다.

메모리 보관 데이터는 직렬화 기준 8 MiB, 디스크는 항목 256 KiB·전체 8 MiB로 제한합니다. 메모리 수치는 프로세스 heap/RSS나 응답 수신 순간의 상한이 아닙니다. 원문을 잘라 저장하지 않고 오래된 항목 전체를 제거하므로 큰 결과는 다음 접근에서 다시 가져올 수 있습니다.

동등한 진행 중 요청은 같은 캐시·인증 실행 범위에서 공유합니다. 한 호출의 취소는 그 호출만 종료하고, 모두 취소되면 전송을 중단합니다. 프로세스 간 저장은 잠금 아래 변경분을 병합합니다. 외부 저장 뒤 디스크에 없는 메모리 전용 항목은 보수적으로 무효화할 수 있습니다.

캐시는 본문 전체와 URL을 저장하고 같은 경로의 세션이 재사용합니다. URL 쿼리에 비밀값을 넣지 마세요. 쓰기 실패나 잠금 제한 시간 초과 시 디스크 반영은 보장되지 않습니다.

## 사용자 정의 상태 표시에서 사용

런타임과 생성 데이터는 모두 `src/` 아래에 있습니다. 루트의 `usage.ts`, `utils.ts` 등 호환용 파일은 제거했으므로 기존 직접 import는 아래 경로로 변경해야 합니다. TypeScript 소스를 직접 배포하므로 `.ts` 확장자를 사용합니다.

```ts
import { fetchUsage, fetchUsageStats, formatUsage, formatUsageStatusColored } from "@buyong/pi-ollama-cloud/src/usage/api.ts";
import { getCloudApiKey } from "@buyong/pi-ollama-cloud/src/auth/context.ts";
import type { UsageData } from "@buyong/pi-ollama-cloud/src/usage/api.ts";
```

| 함수 | 동작 |
| --- | --- |
| `fetchUsage(apiKey, signal?)` | `/api/balance` 조회. 기존 할당량 창과 잔액 기반 응답을 지원 |
| `fetchUsageStats(apiKey, range?, signal?)` | `/api/usage` 요청 통계 조회 |
| `formatUsage(data, stats?, options?)` | 여러 줄의 사용량 문자열 생성. `options.title`로 첫 줄 변경 |
| `formatUsageSummary(data)` | 한 줄 요약 생성. 예: `5h 40% used · purchased $5.00` |
| `formatUsageStatusColored(theme, data)` | TUI 상태 표시용 문자열 생성 |
| `getCloudApiKey(ctx)` | Pi 공급자 인증을 먼저 확인하고 `OLLAMA_API_KEY`로 대체 |
| `isUsageResponse(data)`, `isUsageStats(data)` | 응답 형식 확인 |

`UsageData.included.period.until`에는 API가 제공한 갱신 경계가 들어갑니다. 상태 표시 아이디어는 [pi-ollama-cloud-usage-tracker](https://github.com/Entelligentsia/pi-ollama-cloud-usage-tracker)에서 참고했지만, 이 확장은 브라우저 쿠키 대신 API 키와 `/api/balance`를 사용합니다.

## 개발과 검증

모노레포 루트에서 Node.js 22.19 이상과 `pnpm@10.29.2`로 실행합니다.

```bash
pnpm install --frozen-lockfile
pnpm --filter @buyong/pi-ollama-cloud check
pnpm --filter @buyong/pi-ollama-cloud test:unit
verification_dir="$(mktemp -d)"
pnpm --filter @buyong/pi-ollama-cloud exec tsx scripts/cli/verify.ts --offline --report "$verification_dir/offline.json"
pnpm --dir apps/pi-ollama-cloud pack --pack-destination "$verification_dir/package"
```

`check`는 파일을 수정하지 않는 린트와 타입 검사입니다. 단위 테스트와 `--offline` 검증은 실제 서비스 요청 없이 실행합니다. 통합 검증은 실제 pnpm archive를 추출하고, 이미 설치된 생산 의존성만 준비해 source/artifact의 등록·도구·취소·reload·payload를 비교합니다. 종료 코드 0과 보고서의 모든 check 통과를 확인하세요. 테스트·CLI·Inquirer·검증 기록은 배포물에 포함하지 않습니다. 컴파일·번들 단계는 없습니다.

### 대화형 기능 확인 CLI

모노레포 루트의 대화형 터미널에서 실행합니다. npm 설치본이 아니라 소스 checkout용 명령입니다.

```bash
pnpm --filter @buyong/pi-ollama-cloud cli
```

`@inquirer/prompts` 메뉴에서 다음 기능을 선택합니다.

- **모델 목록 조회**: Ollama의 `GET https://ollama.com/v1/models` 응답을 조회해 모델 ID와 개수를 표시합니다. 고정된 모델 목록으로 대체하지 않으며 API 키 없이도 조회할 수 있습니다.
- **모델을 선택해 1+1 채팅**: API 목록에서 모델을 고르면 확장의 공용 모델 조립 로직과 Pi 모델 런타임으로 `1+1`을 한 번 보내고 텍스트 응답을 표시합니다.
- **모델 ID를 직접 입력해 1+1 채팅**: `glm-5.3-flash:cloud`처럼 목록에 노출되지 않은 유효한 ID도 입력할 수 있습니다. `/api/show`로 확인한 뒤 입력한 ID를 그대로 등록·전송하며, 지원하지 않는 모델은 호출 전에 안내합니다. API 목록의 이름과 허용되는 별칭이 항상 일치하는 것은 아닙니다.
- **모델 메타데이터·출처 조회**: 공개 API의 기능·추론 값과 생성 데이터·기본값의 출처를 표시합니다.
- **기능별 검증 / 전체 기능·배포물 검증**: 인증, 모델, 캐시, 렌더러, 취소, 생성 파이프라인의 모의 검증을 실행합니다. 진단은 부모 메뉴와 별도 프로세스에서 실행합니다.
- **종료**: 메뉴를 끝냅니다. `Ctrl+C`로 실행을 중단하고 종료할 수도 있습니다.

채팅에는 실제 API 사용량이 발생합니다. 기존 생성·검증 스크립트와 같이 Pi의 `auth.json`에 저장된 `ollama-cloud` API 키를 먼저 사용하고, 없으면 `OLLAMA_API_KEY`를 사용합니다. 키를 화면이나 파일에 출력하지 않습니다. 저장된 리터럴·`$ENV`·`${ENV}`·`!command`는 Pi의 공식 resolver로 해석합니다. Pi 1.2의 동기 인증 명령은 취소가 최대 10초 늦어질 수 있습니다.

채팅은 선택한 모델의 설정을 Pi 모델 런타임에 임시 등록합니다. 전송 직전에 요청 본문의 모델 ID가 입력과 같은지도 확인합니다. 키는 런타임 메모리로 전달하고, 세션 파일이나 개인 설정을 저장하지 않습니다. 요청은 120초, 출력은 모델 한도와 4096토큰 중 작은 값으로 제한합니다. 오류는 화면에 표시한 뒤 메뉴로 돌아가며 임시 디렉터리는 정리합니다. 채팅 성공은 공용 모델 경로의 추론 검증입니다. 확장의 등록·명령·도구·이벤트는 별도의 source/artifact 검사와 아래 Pi 직접 실행으로 확인합니다.

도움말은 `pnpm --filter @buyong/pi-ollama-cloud cli --help`로 확인합니다. CLI와 `@inquirer/prompts`는 개발용이며 런타임 배포물에는 포함하지 않습니다.

### Pi에서 직접 확인

Pi는 `package.json`의 `pi.extensions: ["./src/index.ts"]`로 진입점을 찾습니다. 루트 `index.ts`는 필요하지 않습니다. 기존 `-e .../index.ts`나 정확한 파일 경로 필터는 패키지 디렉터리 또는 `src/index.ts`로 변경하세요.

앱 디렉터리에서 개인 설정과 분리해 로드하려면 다음을 실행합니다.

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

Pi 입력창에서 `/ollama`(설정 화면을 열고 Esc로 닫기), `/ollama webtools off`, `/ollama webtools on`, `/reload`를 실행하고 오류 없이 도구 상태가 바뀌는지 확인합니다. 이 두 명령은 격리한 agent 디렉터리의 `ollama-cloud.json`에 값을 저장합니다. 이 확인은 시작·명령 동작만 확인하며 모델/API 성공을 의미하지 않습니다. 격리 디렉터리는 코드의 파일·네트워크 접근을 차단하는 보안 경계가 아닙니다.

실서비스 검사는 API 키와 사용량을 필요로 합니다. CI의 `Smoke pi-ollama-cloud`는 포장된 확장의 모델 응답, thinking off, 웹 도구를 확인합니다. 로컬 웹 검사는 앱 디렉터리에서 `pnpm run smoke:web-tools`로 실행합니다. 검색·fetch 각 1회와 구매 크레딧 보호를 위한 잔액 조회 1회를 사용하고, 등록된 execute의 반환 상한과 보관된 캐시 재사용을 확인합니다. 실패는 재시도하지 않습니다.

생성 데이터 갱신, 배포 승인과 태그 절차는 [유지보수 가이드](https://github.com/buYoung/pi-packages/blob/main/apps/pi-ollama-cloud/docs/maintaining.md)에 있습니다.

## 제한과 지원

이 확장은 `ollama launch pi`처럼 로컬 서버를 경유하지 않으며 로컬 모델은 제공하지 않습니다. 공급자 이름이 `ollama`와 `ollama-cloud`로 다르므로 두 방식을 함께 사용할 수 있습니다. 다만 같은 확장의 중복 설치는 피하세요.

모델 상세 조회는 요청별 10초 제한을 사용합니다. 일부 조회만 실패해도 마지막 정상 카탈로그 전체를 보존합니다. 모델이 구조화된 도구 호출 대신 원시 마크업을 출력하면 다른 모델로 재시도하고, 재현 정보에서 키와 개인정보를 제거해 [이슈](https://github.com/buYoung/pi-packages/issues)에 남겨 주세요.

0.8.0 이전의 `/ollama-cloud-refresh` 명령은 더 이상 제공하지 않습니다. 이전 모델 캐시 `~/.pi/agent/cache/ollama-cloud-models.json`도 사용하지 않습니다.

[MIT License](LICENSE). 원저작자 표기는 유지합니다.
