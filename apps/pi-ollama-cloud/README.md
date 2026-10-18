# @buyong/pi-ollama-cloud

로컬 Ollama 서버 없이 Pi를 Ollama Cloud API에 연결하는 확장입니다. 클라우드 모델 목록, 웹 검색·페이지 읽기, 사용량 조회를 제공합니다.

소스와 배포는 [`buYoung/pi-packages`](https://github.com/buYoung/pi-packages/tree/main/apps/pi-ollama-cloud)에서 관리합니다. npm 이름은 그대로입니다. [fgrehm/pi-ollama-cloud](https://github.com/fgrehm/pi-ollama-cloud)에서 시작한 포크이며, 기존 `buYoung/pi-ollama-cloud`의 Git 이력과 MIT 라이선스를 보존합니다.

## 설치와 첫 사용

Node.js 22.19 이상, Pi, [Ollama Cloud API 키](https://ollama.com)가 필요합니다. 개발 의존성은 모노레포의 Pi 1.2.0 기준이며, CI에서 최신 Pi와의 호환성도 별도로 검사합니다.

```bash
pi install npm:@buyong/pi-ollama-cloud
```

Pi를 시작한 뒤 다음 순서로 사용합니다.

1. `/login`에서 **Use an API key → Ollama Cloud**를 선택하고 키를 입력합니다. 이미 키를 등록했다면 생략합니다.
2. `/model`에서 `ollama-cloud` 모델을 선택합니다.
3. 짧은 질문을 보내 응답을 확인합니다. `/ollama-cloud-usage`로 잔액·할당량을 조회할 수도 있습니다.

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
- 모델의 추론 수준은 models.dev에서 생성한 `reasoning.generated.ts`와 `thinking-levels.ts`로 결정합니다. 추론을 끌 수 없는 것으로 확인된 모델은 `off`를 노출하지 않습니다.
- 컨텍스트 길이를 알 수 없으면 128000, 출력 한도를 별도로 측정하지 않은 모델은 32768을 사용합니다.
- `models.generated.ts`는 첫 실행용 기본값입니다. 모델 목록 갱신 자체에 새 패키지 배포가 필요한 것은 아니지만, 가격·출력 한도·은퇴 모델 처리는 생성 데이터와 코드를 갱신해 배포해야 합니다.

### 가격 표시의 한계

가격은 [Ollama 가격표](https://ollama.com/pricing)에서 생성한 토큰 100만 개당 요율입니다. `/cost`는 이 요율에 따른 추정치이며 구독 요금 청구액과 같지 않습니다. 가격표에 매칭되지 않은 모델은 비용이 0으로 표시될 수 있습니다.

가격 데이터는 패키지에 고정되어 있어 새 배포 전까지 변하지 않습니다. API가 캐시 토큰 사용량을 보고하지 않으면 캐시 할인도 `/cost`에 반영되지 않습니다. `cacheWrite`는 0입니다.

## 도구와 명령

| 이름 | 용도 |
| --- | --- |
| `ollama_web_search` | Ollama Cloud 웹 검색. `query` 필수, `max_results` 기본 5·최대 10 |
| `ollama_web_fetch` | 웹 페이지 제목·본문·링크 읽기. `url` 필수 |
| `/ollama-webtools [on\|off\|enable\|disable]` | 웹 도구 활성화 여부 변경. 인수 생략 시 전환 |
| `/ollama-cloud-usage` | 잔액·할당량, 확인 가능한 갱신일과 요청 통계 조회 |
| `/ollama-usage-status [on\|off\|enable\|disable]` | TUI 하단 사용량 표시 변경. 인수 생략 시 전환 |

웹 도구는 모델 공급자와 같은 API 키를 사용합니다.

- 검색 결과는 기본적으로 결과별 본문 500자를 보여 줍니다. `[truncated]` 결과는 같은 `query`와 `max_results`에 `expand=<1부터 시작하는 번호>`를 지정하면 캐시에서 전체 본문을 읽습니다. 해당 캐시가 없거나 만료되었다면 검색 API를 다시 호출합니다.
- 페이지 본문은 기본 3000자씩 반환합니다. `offset=N`으로 이어 읽거나 `full=true`로 남은 본문 전체를 받습니다.
- 두 도구 모두 `refresh=true`로 캐시를 무시하고 다시 요청합니다. 결과 끝의 `# live query`와 `# from cache`로 API 호출 여부를 구분합니다.

## 설정

전역 설정은 `~/.pi/agent/ollama-cloud.json`, 프로젝트 설정은 `.pi/ollama-cloud.json`입니다. Pi의 agent 디렉터리를 바꾸면 전역 설정 위치도 그 디렉터리를 따릅니다.

```json
{
  "webTools": true,
  "usageStatus": false
}
```

프로젝트 설정이 전역 설정보다 우선합니다. `PI_OLLAMA_WEB_TOOLS` 환경 변수는 두 파일보다 우선하며, `0`, `false`, `no`, `off` 또는 빈 문자열이면 웹 도구와 활성화 명령을 비활성화합니다. 설정 파일 변경 후에는 Pi를 재시작하거나 `/reload`합니다. 명령으로 바꾼 상태는 설정 파일에 저장되지 않습니다.

사용량 상태 표시는 기본적으로 꺼져 있습니다. 활성화하면 TUI에서 `ollama-cloud` 모델을 사용하는 동안 5분 간격으로 갱신합니다. 턴 종료 시 갱신도 같은 5분 제한을 따릅니다. 다른 공급자로 전환하거나 조회에 실패하면 표시를 지웁니다. 표시가 나타나지 않으면 `/ollama-cloud-usage`로 인증·응답 오류를 확인하세요.

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

인증 오류, 요청 제한, 통신 오류, 서버 오류와 잘못된 응답 형식은 실패 캐시에 저장하지 않습니다. 캐시 항목은 직렬화 기준 256 KiB, 파일 전체는 8 MiB로 제한하며 오래된 항목부터 제거합니다. 큰 결과는 현재 호출에서는 읽을 수 있지만 이후 호출에서 다시 가져올 수 있습니다.

캐시는 본문 전체와 URL을 저장합니다. URL 쿼리에 비밀값을 넣지 마세요. 여러 Pi 프로세스가 공유하면 마지막 저장이 다른 프로세스의 신규 항목을 덮어쓸 수 있습니다. 프로세스 간 잠금은 없으며, 이 경우 API를 다시 호출할 수 있습니다.

## 사용자 정의 상태 표시에서 사용

공개 하위 모듈 경로도 유지합니다. TypeScript 소스를 직접 배포하므로 import에는 `.ts` 확장자를 사용합니다.

```ts
import { fetchUsage, fetchUsageStats, formatUsage, formatUsageStatusColored } from "@buyong/pi-ollama-cloud/usage.ts";
import { getCloudApiKey } from "@buyong/pi-ollama-cloud/utils.ts";
import type { UsageData } from "@buyong/pi-ollama-cloud/usage.ts";
```

| 함수 | 동작 |
| --- | --- |
| `fetchUsage(apiKey, signal?)` | `/api/balance` 조회. 기존 할당량 창과 잔액 기반 응답을 지원 |
| `fetchUsageStats(apiKey, range?, signal?)` | `/api/usage` 요청 통계 조회 |
| `formatUsage(data, stats?)` | 여러 줄의 사용량 문자열 생성 |
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
pnpm --dir apps/pi-ollama-cloud pack --pack-destination /tmp/pi-ollama-cloud-pack
```

`check`는 파일을 수정하지 않는 린트와 타입 검사입니다. 단위 테스트에는 API 키가 필요 없습니다. 모두 종료 코드 0이어야 하며, `pack`은 지정 디렉터리에 npm 배포용 `.tgz`를 만듭니다. 테스트와 생성 스크립트는 배포물에 포함하지 않습니다. 컴파일·번들 단계는 없습니다.

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
    --no-context-files --no-mcp -e "$package_dir/index.ts"
)
```

Pi 입력창에서 `/ollama-webtools off`, `/ollama-webtools on`, `/reload`를 실행하고 오류 없이 도구 상태가 바뀌는지 확인합니다. 이 확인은 시작·명령 동작만 확인하며 모델/API 성공을 의미하지 않습니다. 격리 디렉터리는 코드의 파일·네트워크 접근을 차단하는 보안 경계가 아닙니다.

실서비스 검사는 API 키와 사용량을 필요로 합니다. CI의 `Smoke pi-ollama-cloud`는 포장된 확장의 모델 응답, thinking off, 웹 API를 확인합니다. 로컬 웹 API 검사는 앱 디렉터리에서 `pnpm run smoke:web-tools`로 실행합니다.

생성 데이터 갱신, 배포 승인과 태그 절차는 [유지보수 가이드](https://github.com/buYoung/pi-packages/blob/main/apps/pi-ollama-cloud/docs/maintaining.md)에 있습니다.

## 제한과 지원

이 확장은 `ollama launch pi`처럼 로컬 서버를 경유하지 않으며 로컬 모델은 제공하지 않습니다. 공급자 이름이 `ollama`와 `ollama-cloud`로 다르므로 두 방식을 함께 사용할 수 있습니다. 다만 같은 확장의 중복 설치는 피하세요.

모델 상세 조회는 요청별 10초 제한을 사용합니다. 일부 조회만 실패하면 성공한 결과와 기존 데이터를 활용합니다. 모델이 구조화된 도구 호출 대신 원시 마크업을 출력하면 다른 모델로 재시도하고, 재현 정보에서 키와 개인정보를 제거해 [이슈](https://github.com/buYoung/pi-packages/issues)에 남겨 주세요.

0.8.0 이전의 `/ollama-cloud-refresh` 명령은 더 이상 제공하지 않습니다. 이전 모델 캐시 `~/.pi/agent/cache/ollama-cloud-models.json`도 사용하지 않습니다.

[MIT License](LICENSE). 원저작자 표기는 유지합니다.
