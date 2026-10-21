# Pi에서 Computer Use·Browser Use 사용하기

[English](usage.md) | **한국어**

Codex Desktop에 설치된 런타임을 준비하고 Pi가 노출할 기능을 선택한 뒤, 런타임 승인으로 앱·브라우저 작업을 실행합니다. 패키지는 MCP 연결을 제공하며 자동화 엔진이나 OS 샌드박스가 아닙니다. Computer Use·Browser Use는 기본으로 둘 다 켜져 있습니다.

## 시작 전 준비

- Node.js 22.19 이상과 Pi 1.0.0 이상을 사용합니다. 기록된 실제 세션은 Pi 0.99.1이며 이후 호스트의 호환성을 뜻하지는 않습니다.
- Codex Desktop을 설치하고 Codex 접근이 가능한 계정으로 로그인합니다. Computer Use 플러그인을 한 번 활성화해 런타임 설정을 준비합니다. Codex CLI만으로는 부족합니다.
- macOS의 네이티브 앱 작업에는 `Codex Computer Use.app`의 손쉬운 사용·화면 기록 권한을 허용합니다.
- Browser Use에는 실행 중인 Google Chrome, 활성 ChatGPT Chrome 확장과 Desktop의 Chrome/Browser 플러그인·네이티브 메시징 호스트가 필요합니다.
- Desktop을 실행해 둡니다. macOS 실검증 기록은 있지만 Windows 탐색·점검은 구현했어도 실제 실행은 미검증입니다. Linux는 지원하지 않습니다.

패키지는 Codex 자격 증명을 읽거나 구독·로그인의 이용 가능 여부를 확인하지 않습니다. 사용자가 직접 확인해야 합니다. 활성 브라우저 백엔드는 Chrome뿐이며 `iab`·`mcpapps`·Edge는 이 연결에서 사용할 수 없습니다.

## 1. 패키지 설치와 로드

게시된 npm 릴리스는 다음과 같이 설치합니다.

```sh
pi install npm:@buyong/pi-codex-computer-use
pi list
pi
```

현재 소스 체크아웃은 대신 [pi-packages](https://github.com/buYoung/pi-packages) 저장소 루트에서 다음과 같이 실행합니다.

```sh
pnpm install
pnpm --filter @buyong/pi-codex-computer-use build
pnpm --filter @buyong/pi-codex-computer-use exec pi -ne -e ./dist/index.js
```

두 경로를 함께 로드하거나 `@buyong/pi-codex`의 같은 확장과 중복하지 마세요. 정상 로드된 확장은 `/computer-use`·`/computer-use-check`를 등록합니다. 기능이 켜져 있고 런타임 연결이 성공해야 도구가 나타납니다. 하단에는 기능·서버 상태를 표시합니다. 첫 연결 때 서버의 도구 목록을 저장합니다. 이후 런타임과 스위치가 같은 세션은 저장본으로 도구를 등록하고 처음 도구를 호출할 때 서버를 시작합니다(그 전까지 하단 `ready`). 시작한 서버의 도구 목록이 다르면 등록한 도구와 저장본을 새 목록으로 바꿉니다.

## 2. 요구 사항 점검과 해결

Pi에서 실행합니다.

```text
/computer-use-check
/computer-use status
```

첫 명령은 요구 사항과 순서가 있는 설정 안내를 보여 줍니다. 두 번째는 전체 진단 없이 현재 기능·런타임 출처·서버 상태를 보여 줍니다. `/computer-use check`는 첫 명령의 호환용 별칭입니다.

| 점검 상태 | 의미 |
| --- | --- |
| `ok` | 해당 검사를 통과했습니다. 자동화 작업 성공의 근거는 아닙니다. |
| `missing` | 필수 항목이 없거나 검증에 실패했습니다. 표시된 조치를 따릅니다. |
| `user-owned` | 계정·로그인·OS 권한을 직접 확인해야 합니다. |
| `unverified` | 구현·환경 증거가 충분하지 않습니다. 통과가 아닙니다. |
| `skipped` | 모의 플랫폼 등의 이유로 실행하지 않았습니다. |

점검은 설치 파일을 확인하며 설치된 런타임의 설정·검증 명령을 실행할 수 있습니다. 연결 코드 자체는 런타임 설치·복사, 네이티브 호스트 등록 복구, 개인정보 권한 허용, 기능 설정 변경이나 앱·탭 조작을 하지 않습니다. 검증 스크립트는 설치된 Desktop 런타임의 코드이므로 실패하면 Desktop을 갱신하세요.

Desktop 설치·로그인, Computer Use를 쓸 때의 네이티브 서비스·권한, Browser Use를 쓸 때의 Chrome 확장·네이티브 호스트 순서로 해결하고 다시 점검합니다. 사용하지 않는 기능은 요구 사항이 부족해도 꺼 두면 됩니다.

### 런타임 탐색 위치

1. `CODEX_HOME/plugins/cache/openai-bundled/unified-computer-use/<version>/.mcp.json`의 최신 활성 Desktop 설정
2. 사용 가능한 플러그인 캐시가 없는 macOS에서는 설치 앱의 `cua_node/manifest.json`

`CODEX_HOME`은 보통 `~/.codex`이며 Windows에서는 해당하는 경우 사용자 프로필 디렉터리를 사용합니다. Windows에는 Desktop이 만든 캐시가 필요하고 앱 번들 폴백은 없습니다. 탐색 결과를 Codex 설정에 다시 쓰지 않습니다.

macOS 앱 번들 폴백과 네이티브 서비스 최초 실행은 미검증입니다. 비표준 macOS 앱 번들은 `PI_CODEX_COMPUTER_USE_APP_PATH`로 선택할 수 있습니다. 실행 계획을 찾거나 파일 검사가 `ok`여도 Desktop 업데이트 후 비공개 런타임의 동작을 보장하지는 않습니다.

## 3. 필요한 기능만 선택

```text
/computer-use
```

TUI 목록 하나에서 **↑/↓**로 Computer Use·Browser Use를 선택하고 **Enter/Space**로 바꿉니다. 변경은 즉시 저장하고 런타임을 재시작하며 화면·선택한 항목은 유지합니다. Esc는 저장한 변경을 되돌리지 않고 닫습니다.

Browser Use만 사용하려면 다음과 같이 설정합니다.

```text
/computer-use computer off
/computer-use browser on
```

| 설정 | 노출 기능 | 서버·도구 |
| --- | --- | --- |
| 둘 다 켜짐 | `browser,computer` | 공용 서버와 `js`·`js_reset` |
| Computer만 | `computer` | 공용 서버와 `js`·`js_reset` |
| Browser만 | `browser` | 공용 서버와 `js`·`js_reset` |
| 둘 다 꺼짐 | 없음 | 서버 없음. 도구 숨김 |

RPC는 두 기능과 Close가 있는 반복 선택창을 사용합니다. print·JSON 모드는 인자 없는 명령에 상태를 출력하고 명시적 인자를 받습니다. 사용자 지정 설정 화면은 그리지 않습니다. 상태·점검 결과와 런타임 탐색·시작·종료 실패, 예기치 않은 서버 종료는 stderr로 출력합니다.

### 설정 파일

경로는 `<agentDir>/codex-computer-use/settings.json`입니다. `agentDir`은 `PI_CODING_AGENT_DIR`을 따르며 기본값은 `~/.pi/agent`입니다.

```json
{
  "computerUse": true,
  "browserUse": true
}
```

파일이 없으면 만들지 않고 두 기본값을 사용합니다. 기존 파일에는 불리언 키 두 개가 모두 있어야 하며 다른 키는 허용하지 않습니다. 잘못됐거나 읽을 수 없으면 세션에서 두 기능을 끄고 토글 명령은 덮어쓰기를 거부합니다. 파일을 고친 뒤 Pi를 다시 로드하거나 시작하세요.

기능 변경은 에이전트가 멈출 때까지 기다리고 공용 서버를 재시작합니다. **다른 기능의 바인딩을 포함한 모든 REPL 변수·앱·탭 바인딩이 사라집니다.** 직접 파일을 바꾼 뒤에도 다시 로드하거나 시작해야 합니다.

## 4. 작업 실행과 승인

먼저 조작 없이 목록만 확인하려면 다음과 같이 요청합니다.

```text
Use mcp__cua_repl__js to run await cua.getState(). Summarize the available apps and browsers without operating them.
```

범위를 제한한 브라우저 작업은 다음과 같이 요청할 수 있습니다.

```text
Use Browser Use to open https://example.com in Chrome, read its accessibility state, and close the tab. Do not submit forms or download anything.
```

모델은 첫 호출이 반환한 런타임 문서를 따라야 합니다. `cua`는 이미 초기화되어 있으므로 기존 `@oai/sky`나 browser-client 흐름을 수동 초기화하지 마세요.

### 진입 호출·출력·지속 바인딩

- 첫 `js` 호출과 초기화·설정 재시작 후에는 **지원하는 진입 API 하나만** 호출합니다. 결과를 변수에 할당할 수 있지만 다른 호출·대기·스냅샷과 합치지 않습니다. 반환한 문서·상태를 읽고 다음 호출로 진행합니다.
- 백엔드를 지정하지 않은 새 페이지는 `cua.createBrowserTab("chrome", url, { sessionName: "🔎 Task" })`를 사용합니다. 기존 탭은 관찰한 참조로 `cua.getTab`을 사용합니다. ID를 만들거나 모호한 참조 대신 새 탭을 열지 않습니다.
- 진입 API와 기본 `getAXState()`는 문서·상태를 이미 출력합니다. 결과를 `nodeRepl.write`·`emitImage`로 다시 감싸지 않습니다. 추가 값은 `nodeRepl.write()`, 추가 이미지는 await와 함께 `nodeRepl.emitImage()`를 사용합니다. 단순 식의 값은 출력하지 않습니다.
- 기존 바인딩을 재사용합니다. 초기화·서버 재시작 후에는 다시 얻고 문맥 압축 후에는 `await cua.rewriteDocumentation()`을 먼저 호출합니다.

연결은 런타임 원문 설명을 유지하고 도구 선언에 현재 Pi 호스트 지침을 더합니다. 사용자 지정 시스템 프롬프트에서도 지침을 제공합니다. 코드를 다시 쓰거나 자동 재시도·REPL 초기화를 하지 않으며 지원하지 않는 브라우저를 설명 없이 대체하지 않습니다.

### 승인이 허용하는 작업

런타임 권한은 선택한 앱·출처의 읽기뿐 아니라 **조작**도 허용할 수 있습니다. 의도한 범위의 가장 좁은 저장 방식을 선택하세요.

| 선택 | 효과 |
| --- | --- |
| **Allow** | 이번 요청 한 번 |
| **Allow for this session** | 런타임이 제공하면 세션 동안 기억 |
| **Always allow** | 제공하면 이후 요청에도 기억. 런타임이 관리하는 권한을 바꿀 수 있습니다. |
| **Cancel** | 요청 취소. 도구 외 요청에는 **Deny**도 있을 수 있습니다. |

모든 요청에 모든 선택지가 있는 것은 아닙니다. 별도 권한 저장소는 없습니다. 기록된 실검증에서는 영구 승인을 실행하지 않았습니다.

`node_repl`의 일반적인 빈 폼 `js` 실행 승인은 민감 작업이나 사용자 입력이 아니면 Codex 사용자 검토자의 자동 승인 규칙을 따릅니다. 지원하는 일반 폼 필드는 Pi 대화상자를 사용합니다. 브라우저 로그인·QR, 이메일 OTP, URL 요청과 지원하지 않는 폼은 거부합니다. Guardian 자동 검토는 구현하지 않아 해당 사전 검사는 실패할 수 있습니다.

print·JSON 모드는 사용자 인터페이스가 필요한 요청을 거부합니다. RPC 클라이언트는 UI 요청에 응답해야 합니다. 클라이언트가 승인 대기에 고정된 30초 한도를 두지는 않지만 런타임 자체 실행 제한은 적용됩니다.

Esc·호출자 취소는 MCP 취소를 보내고 대기 승인을 닫습니다. **이미 실행 중인 JavaScript는 완료·런타임 제한 시간까지 계속될 수 있습니다.** OS 수준의 즉시 종료가 아니며 후속 호출이 기다릴 수 있습니다.

## 5. 작업 중 만든 자원 닫기

모델에게 만든 탭을 닫도록 요청하고 기능 변경 후 `/computer-use status`를 확인합니다. 에이전트가 완전히 끝나면 `turn_ended`를 한 번 보냅니다. 정상은 `Stop`, 중단은 `Interrupt`입니다. 취소된 호출이 아직 실행 중이면 알림도 늦어질 수 있습니다.

Pi 종료·다시 로드는 연결 서버의 프로세스 트리를 종료하지만 Desktop 자체 프로세스를 종료하지 않습니다. REPL 초기화는 바인딩을 없애므로 탭을 닫았다는 근거로 삼지 마세요.

JSON-RPC 오류 메시지와 데이터를 포함한 긴 텍스트는 탐색한 런타임 출력 한도에 따라 중간을 생략합니다. 기본 한도는 약 25,000토큰을 100,000바이트로 계산합니다. 저장에 성공하면 사용자만 읽는 시스템 임시 디렉터리의 전체 출력 파일을 결과에 표시합니다. 이미지 블록은 이미지 콘텐츠로 전달합니다. 전체 출력 파일은 연결이 자동 삭제하지 않습니다.

## 문제 해결

| 증상 | 조치 |
| --- | --- |
| 런타임 없음 | Desktop을 설치·갱신하고 플러그인을 한 번 활성화한 뒤 `/computer-use status`를 확인합니다. 비표준 macOS 앱은 `PI_CODEX_COMPUTER_USE_APP_PATH`로 지정합니다. |
| `platform-unsupported` | 지원 플랫폼을 사용합니다. Windows 구현은 실제 기기 검증이 더 필요합니다. |
| 잘못된 설정 | 표시한 경로의 정확한 불리언 키 두 개를 고치고 다시 로드·시작합니다. |
| 설정 스크립트가 `bin/npm`·`bin/npx` 부재로 멈춤 | 기록된 Desktop 빌드에는 해당 실행기가 없습니다. 스크립트는 미검증으로 표시하고 런타임을 별도로 검증합니다. 이 메시지만으로 Desktop 안에 실행기를 설치·복사하지 마세요. |
| Chrome 요구 사항 부족 | 보고서에 따라 Chrome을 설치·실행하고 ChatGPT 확장이나 Desktop의 Chrome/Browser 플러그인을 설정합니다. 연결은 네이티브 호스트를 복구하지 않습니다. |
| `Browser is not available: iab` / `mcpapps` | Chrome을 사용합니다. Desktop 예시에는 Pi에서 사용할 수 없는 백엔드가 있습니다. |
| print·JSON의 승인 UI 부재 | 대화형 Pi나 UI를 지원하는 RPC 클라이언트를 사용합니다. 도구 오류가 거부 이유를 설명합니다. |
| 로그인·OTP·URL 요청 거부 | 지원하는 앱·브라우저 흐름에서 직접 로그인합니다. 이 연결은 해당 확인 요청을 처리하지 못합니다. |
| 취소한 호출 때문에 후속 호출이 지연됨 | JavaScript 호출을 순서대로 실행하므로 완료·시간 초과를 기다립니다. 서버가 종료됐다면 상태를 확인합니다. |
| 호출이 `MCP stdio message exceeds 16777216 bytes`로 실패 | 응답이 16 MiB를 넘어 버려졌습니다. 연결은 유지되므로 더 작은 결과를 요청하세요. 클라이언트가 승인 대기 시간을 줄이지는 않습니다. |

로그는 `<agentDir>/codex-computer-use/mcp.log`에서 5 MiB마다 순환합니다. 저장한 도구 목록은 `<agentDir>/codex-computer-use/tool-catalog.json`이며, 지우면 다음 세션이 서버를 바로 시작할 뿐입니다. JSON으로 직렬화하기 전에 이미지 데이터를 base64 문자 수로 치환합니다. 키 기반 가림 후에도 페이지·앱 내용이 남을 수 있습니다. 공유 전에 확인하세요. Desktop 밖의 비공개 인터페이스·사용 정보 전송은 이 연결이 보장하지 않습니다.

## 기록된 검증과 남은 한계

저장소에는 2026-10-05 macOS `ChatGPT.app` `26.930.31730`·Pi `0.99.1`의 실행이 기록되어 있습니다. 앱·브라우저 목록, Finder 일회·세션·취소·지연 승인, RPC 중단, Chrome `example.com`의 출처 승인·접근성·닫기, 네 가지 기능 조합, 이미지 전달과 출력 생략을 다룹니다.

같은 기록에는 실제 Pi TUI·RPC의 단일 설정 목록, 사용자 지정 프롬프트의 Chrome 지침과 별도 설정 점검 명령도 있습니다. 후속 탭 생성·읽기·닫기 성공은 한 번의 관찰이며 전체 실패율 감소를 측정하지 않았습니다. 과거 기록이며 이 안내를 따른 새 실검증 결과가 아닙니다.

미검증 범위는 Windows 실행, 앱 번들 폴백의 최초 네이티브 서비스 실행, Desktop 종료 상태, 영구 **Always allow**, 다운로드·업로드·전체 CDP·WebMCP와 Guardian 의존 흐름입니다.

근거 문서는 [호스트 지침·설정](https://github.com/buYoung/pi-packages/blob/main/docs/verification/computer-use/09-guidance-and-settings.json), [설정 점검](https://github.com/buYoung/pi-packages/blob/main/docs/verification/computer-use/10-setup-check.json)과 이전 [Computer Use 인계 기록](https://github.com/buYoung/pi-packages/blob/main/docs/verification/computer-use)입니다. OpenAI 런타임은 배포·재허가하지 않습니다. 계정 이용 가능 여부와 적용 약관은 사용자가 확인합니다.

패키지 릴리스는 [저장소 배포 절차](https://github.com/buYoung/pi-packages#공통-ci와-패키지별-배포)를 사용하세요.
