# Codex Computer Use·Browser Use를 pi에서 쓰기 위한 인수인계

`@buyong/pi-codex-computer-use` 패키지로 Codex 데스크톱이 쓰는 Computer Use·Browser Use 런타임을 pi에서 Codex와 같은 흐름으로 사용하는 것이 목표다. Computer Use와 Browser Use는 각각 켜고 끌 수 있어야 하고, 켜진 기능에 맞춰 MCP 서버를 추가한다. 구현은 TypeScript로 하고 `packages/pi-codex-auto-review`와 같은 workspace 패키지 구조를 따른다. 이 문서는 2026-10-05에 이 Mac에서 직접 확인한 사실과 구현 방향을 정리한다. 구현은 아직 시작하지 않았다.

## 결론

- 실제 조작 엔진은 OpenAI의 비공개 런타임이다. ChatGPT.app 안의 `cua_node`(`@oai/cua-repl`, `@oai/cua`, `@oai/sky`, `@oai/browser-desktop`, `node_repl`)와 `Codex Computer Use.app`(`SkyComputerUseService`)으로 구성된다. 오픈소스 `cua`(trycua, `cua-driver`)와는 관계가 없다.
- Codex(`codex-rs`)에는 조작 코드가 없다. 이 런타임을 MCP 서버로 띄우는 호스트 역할만 한다. 호스트가 하는 일은 서버 실행, 호출 `_meta` 전달, 확인 요청(elicitation) 처리, 턴 종료 알림, 결과 이미지 전달이다.
- 패키지는 엔진을 포함하지 않는다. 사용자 Mac에 설치된 런타임을 찾아 실행하고, 위 호스트 역할을 pi 위에서 재현한다. 번들 플러그인은 `Proprietary`, 서비스 앱은 "All rights reserved"이고 `@oai` 패키지에는 라이선스 표기가 없으므로, 패키지에 넣거나 다른 곳에서 내려받아 배포하지 않는다.
- 사전 요구사항은 Codex 구독과 ChatGPT 데스크톱 앱(Codex 데스크톱 앱) 설치·로그인이다. 앱이 있으면 앱이 하는 파일 설치 단계 일부를 패키지가 대신할 수 있다. 앱 설치, 로그인, macOS 권한 허용, Chrome 확장 설치는 대신할 수 없다 ([설치](#설치)).
- 두 기능의 켜기·끄기는 런타임 실행기가 지원하는 `cua_repl` 서버 하나의 `CUA_REPL_ENABLED_SURFACES` 값으로 처리한다. 데스크톱 앱이 이 값을 어떻게 정하는지는 확인하지 못했다. 둘 다 꺼지면 서버를 띄우지 않는다 ([기능별 켜기·끄기](#기능별-켜기끄기)).
- Codex 밖의 일반 Node 프로세스에서 `cua_repl`을 띄워 `initialize`와 `tools/list`가 정상 응답하는 것까지 확인했다. 기능 조합 네 가지 모두 서버가 시작된다. 실제 `js` 실행으로 네이티브 서비스에 연결되는지는 아직 확인하지 않았다. 이것이 구현 전 첫 검증 항목이다.

## 사전 요구사항

| 항목 | 필요 조건 | 패키지가 확인하는 방법 |
| --- | --- | --- |
| Codex 구독 | Codex를 쓸 수 있는 ChatGPT 구독 | 직접 확인할 공개 방법이 없다. 설치 안내에 요구사항으로 적고, 서비스가 거부하면 그 오류를 그대로 알린다 |
| macOS | 런타임과 서비스가 macOS 앱 안에 있다. 이 Mac은 arm64 | `process.platform`, `process.arch` |
| ChatGPT 데스크톱 앱 | `/Applications/ChatGPT.app`, 번들 ID `com.openai.codex`. 표시 이름은 ChatGPT지만 Codex 데스크톱 앱이다 | 번들 ID와 `Contents/Resources/cua_node/manifest.json` |
| 로그인 | ChatGPT 앱에서 Codex 구독 계정으로 로그인 | 직접 확인하지 않는다. 자격 증명 파일(`~/.codex/auth.json`)을 읽지 않는다 |
| Computer Use 권한 | `Codex Computer Use.app`에 손쉬운 사용·화면 기록 권한 | 서비스 오류로 확인하고 허용 방법을 안내한다 |
| Browser Use (`chrome` 백엔드) | Chrome, ChatGPT Chrome 확장, 네이티브 호스트 `com.openai.codexextension` 등록 | 네이티브 호스트 매니페스트 파일 존재 |
| pi | `@earendil-works/pi-coding-agent` 0.99.1 이상, Node `>=22.19.0` | `package.json`의 `peerDependencies`, `engines` |

구독과 로그인이 실제로 필요하다는 근거는 간접적이다. 네이티브 서비스 바이너리(`SkyComputerUseService`)에 `CODEX_HOME`, `access_token`, `chatgpt_account_id`, `plan_type` 문자열과 Codex 로그인·플랜 업그레이드 분석 이벤트 이름이 있어 계정 정보를 읽는 것으로 보인다. `node_repl` 바이너리에도 `getAuthStatus`, `authToken`, `Codex auth method is unavailable` 문자열이 있다. 구독이나 로그인이 없을 때 어디서 막히는지는 확인하지 않았다. `codex-rs`에는 원격 플러그인의 `eligible_plan_types`만 있고, 번들 플러그인에 플랜 조건을 거는 코드는 없다. 지원 플랜 범위도 확인하지 않았다.

## 확인 환경

| 항목 | 값 |
| --- | --- |
| OS | macOS, arm64 |
| ChatGPT 데스크톱 앱 | `/Applications/ChatGPT.app` 26.930.31730, 번들 ID `com.openai.codex`. 5월 기록(`~/.codex/chrome-native-hosts.json`)에는 `/Applications/Codex.app`으로 남아 있어 이후 이름이 바뀐 것으로 보인다 |
| 런타임 위치 | `/Applications/ChatGPT.app/Contents/Resources/cua_node`. `manifest.json` 기준 런타임 아카이브 `cua-node-0.0.27-20260927214556-b77d38801cca-darwin-arm64`, Node `24.21.0-cua.1` |
| 번들 플러그인 버전 | `unified-computer-use`, `browser`, `chrome` 26.930.31730, `computer-use` 1.0.1001365 |
| 네이티브 서비스 | `~/.codex/computer-use/Codex Computer Use.app` 26.929.1001365, 번들 ID `com.openai.sky.CUAService`, 팀 ID `2DC432GLL2` |
| `@oai` 패키지 | `cua-repl` 0.1.0, `cua` 0.2.5, `sky` 0.7.5, `browser-desktop` 0.1.1 |
| Codex | `codex-cli` 0.160.0, 참조 소스 `tmp/codex-main` 커밋 `9a7c5e2` |
| pi | `@earendil-works/pi-coding-agent` 0.99.1 (auto-review의 `devDependencies` 기준. 루트 `overrides`는 pi-ai·pi-agent-core·pi-tui만 고정). 하위 설치된 `@earendil-works/pi-mcp`도 0.99.1 |

경로와 버전은 ChatGPT 앱이 업데이트되면 바뀐다. 구현에서는 고정하지 말고 매번 탐색한다.

## 기존 pi 패키지

npm 검색 API로 찾은 패키지다. 설명과 의존성만 확인했고, 저장소 코드는 열어 보지 않았다. README 확인을 시도했지만 자동 검토가 네트워크 요청을 거부해 실행하지 못했다. 따라서 Codex 런타임을 재사용하는 패키지가 있는지는 확인하지 못했다.

| 패키지 | 설명에 적힌 방식 |
| --- | --- |
| `@amaster.ai/pi-computer-use` | 오픈소스 `cua-driver`를 MCP로 연결 |
| `@injaneity/pi-computer-use` | macOS·Windows·Linux 접근성 API 기반 |
| `@monotykamary/pi-computer-use` | macOS 전용, 자체 하네스 서버와 CLI |
| `@agimon-ai/doompi-computer-use` | DoomPi 전용, 알파 단계 |
| `pi-agent-browser-native` | `agent-browser` CLI |
| `pi-browser-use`, `@amaster.ai/pi-browser-use` | `chrome-devtools-mcp` |

## Codex의 구조

```
[경로 A] unified-computer-use 플러그인 (현재 주 경로)
  모델 → MCP 서버 cua_repl의 js 도구
       → 시작 시 await import("@oai/cua/tinyskyAlt") 로 전역 cua 객체 생성
          ├ computer: @oai/cua 안에 포함된 sky_js
          └ browser : @oai/cua 안에 포함된 browser-client

[경로 B] computer-use 플러그인 (스킬 문서만 있음)
  모델 → MCP 서버 node_repl의 js 도구 → await import("@oai/sky") → sky.click() 등

[공통] sky_js (macOS)
  → Unix 소켓 ~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/IPC/computeruse.sock
     (JSON-RPC 2.0, 서비스가 꺼져 있으면 ensureService 또는 앱 실행)
  → SkyComputerUseService
```

- 경로 A의 근거는 `@oai/cua-repl/README.md`("launches NodeREPL with the `cua` API from `@oai/cua/tinyskyAlt`")와 `instructions/banner.js`다. 플러그인 설정은 `~/.codex/plugins/cache/openai-bundled/unified-computer-use/<버전>/.mcp.json`에 있다.
- 경로 B의 근거는 `~/.codex/.tmp/bundled-marketplaces/openai-bundled/plugins/computer-use/skills/computer-use/SKILL.md`다.
- 두 경로의 sky 코드가 같다는 근거: `@oai/cua` 안의 `project/cua/sky_js/.../native-pipe.js`와 `@oai/sky` 안의 같은 파일이 바이트 단위로 같다.
- 실제 사용 기록(`~/.codex/sessions`): `cua_repl/js` 1,343회(9/12~10/5), `node_repl/js` 790회(8/18~10/4). `node_repl`은 브라우저 플러그인도 사용한다.
- `.mcp.template.json`은 앱을 만들 때 `.mcp.json`으로 이름이 바뀐다(`@oai/cua-repl/README.md`). 앱 번들과 `.tmp/bundled-marketplaces`의 `.mcp.json`은 `enabled: false`이고 인자가 비어 있으며, 데스크톱 앱이 플러그인을 설치할 때 Node 경로·실행 인자·환경변수를 채우고 `enabled: true`로 바꾼다.
- Codex 소스에서 이 런타임을 특별 취급하는 기준은 서버 이름이다. `node_repl`, `cua_repl` 서버와 `codex_apps`의 `connector_openai_browser` 커넥터가 대상이다 (`codex-rs/protocol/src/mcp.rs`의 `is_node_repl_backed_server`, `is_node_repl_backed_connector`).

### `cua_repl` 실행 설정

`.mcp.json`의 실행 명령은 `cua_node/bin/node`로 `@oai/cua-repl/bin/cua-repl.mjs`를 실행한다. 노출 도구는 `enabled_tools`로 `js`, `js_reset`, `turn_ended`만 허용하고, `js` 결과는 `output_token_limit: 25000`이다. 시작 대기 시간은 120초다.

주요 환경변수:

| 변수 | 이 Mac의 값 | 역할 |
| --- | --- | --- |
| `CUA_REPL_ENABLED_SURFACES` | `browser,computer` | 필수. 없거나 모르는 값이면 시작 실패 |
| `CUA_REPL_NODE_REPL_PATH` | `cua_node/bin/node_repl` | 실제 REPL 실행 파일 |
| `NODE_REPL_NODE_PATH`, `NODE_REPL_NODE_MODULE_DIRS` | `cua_node/bin/node`, `cua_node/lib/node_modules` | 실행 Node와 모듈 경로 |
| `NODE_REPL_TRUSTED_CODE_PATHS` | `~/.codex`, `cua_node/lib/node_modules` | 신뢰 코드 경로 |
| `NODE_REPL_TRUSTED_SERVICES` | `{"browser":"@oai/browser-desktop/service","sky":"@oai/sky/service"}` | 신뢰 서비스 |
| `SKY_CUA_SERVICE_PATH` | `~/.codex/computer-use/Codex Computer Use.app` | 네이티브 서비스 앱 |
| `BROWSER_USE_AVAILABLE_BACKENDS` | `chrome,iab,mcpapps` | 브라우저 백엔드 |
| `CODEX_HOME` | `~/.codex` | Codex 상태 디렉터리 |
| `CODEX_CLI_PATH` | ChatGPT.app 안의 `codex` | 추정: 샌드박스 실행과 인증 상태 조회. `node_repl` 바이너리에 `CODEX_CLI_PATH--allow-unix-socket`, `getAuthStatus` 문자열이 있다 |
| `BROWSER_USE_CODEX_APP_VERSION`, `BROWSER_USE_CODEX_APP_BUILD_FLAVOR` | `26.930.31730`, `prod` | 앱 버전 표시 |

`NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS=1000`, `BROWSER_USE_TINYSKY_ENABLED=1`, 용도별 안내 문구(`NODE_REPL_INSTRUCTIONS_USE_CASE_*`)도 함께 전달된다. README에 따르면 `CUA_REPL_BROWSER_ENV`(`codex-app` 기본), `NODE_REPL_JS_BANNER`도 받을 수 있다.

## 직접 확인한 `cua_repl` MCP 계약

일반 Node 스크립트로 위 `.mcp.json`의 명령과 환경변수를 그대로 사용해 `initialize`, `notifications/initialized`, `tools/list`만 보냈다. 도구는 호출하지 않았다.

- 서버 정보: `{"name":"rmcp","version":"1.5.0"}`, 프로토콜 `2025-06-18`
- 서버 기능: `{"experimental":{"codex/sandbox-state-meta":{}},"tools":{"listChanged":true}}`
- 서버 instructions: `UI automation through cua_repl using the initialized cua API.`

| 도구 | annotations | 입력 |
| --- | --- | --- |
| `js` | `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false` | `code`(필수), `timeout_ms`(기본 30000), `title`(1~80자) |
| `js_reset` | 위와 같음 | 없음 |
| `js_add_node_module_dir` | 위와 같음 | `path`. `.mcp.json`의 `enabled_tools`에는 없음 |
| `turn_ended` | `idempotentHint: true`, `_meta.ui.visibility: []` | `hook_event_name`, `session_id`, `turn_id` (모두 필수) |

`js` 설명(2,952자)은 모델에게 첫 호출에서 진입 API 하나만 실행하라고 지시한다. 진입 API는 `cua.getState()`, `cua.getTab()`, `cua.createBrowserTab()`, `cua.getBrowser()`, `cua.getApp()`이다. 결과에는 문서와 초기 UI 상태가 포함되고, 추가 출력은 `nodeRepl.write()`와 `nodeRepl.emitImage()`로 낸다. 설명은 런타임이 제공하므로 패키지가 다시 작성하지 않고 그대로 전달한다.

단, 브라우저 안내(`@oai/cua-repl/instructions/macos/browser.md`)는 `iab`, `mcpapps`, @-mention을 조건 없이 설명한다. `BROWSER_USE_AVAILABLE_BACKENDS`를 줄여도 설명은 바뀌지 않는다. README의 `CUA_REPL_BROWSER_ENV`로 문서 변형을 고를 수 있는데, pi에 맞는 변형이 있는지는 5단계에서 검토한다.

## Codex 호스트가 하는 일

pi 패키지가 재현해야 하는 흐름이다. 근거는 `tmp/codex-main/codex-rs`와 설치된 런타임 코드다.

### 1. 연결

- `initialize`는 프로토콜 `2025-06-18`, `clientInfo`는 `codex-mcp-client`(title `Codex`)로 보낸다. `capabilities.elicitation`을 선언하고, 앱 서버 호스트가 지원하면 `openai/elicitation`, `openai/form` 같은 확장도 `capabilities.extensions`에 넣는다 (`codex-mcp/src/rmcp_client.rs`의 `mcp_initialize_request_params`, `codex-mcp/src/client_capabilities.rs`). Codex CLI와 데스크톱에서 실제로 어떤 확장이 선언되는지는 확인하지 않았다.

### 2. 도구 호출과 `_meta`

`tools/call`의 `params._meta`에 다음을 넣는다 (`core/src/mcp_tool_call.rs`의 `build_mcp_tool_call_request_meta`, `with_mcp_tool_call_ids_meta`, `augment_mcp_tool_request_meta_with_sandbox_state`).

| 키 | 내용 | 런타임 쪽 사용 |
| --- | --- | --- |
| `callId` | 모델 도구 호출 ID | Codex는 확인 요청 `_meta`의 `callId`로 원래 호출을 찾는다(`session/mcp.rs`). 런타임이 이 값을 돌려주는지는 미확인 |
| `x-codex-turn-metadata` | Codex 응답 메타데이터에서 `agent_name`, `parent_turn_id`, `root_turn_id`를 빼고 `codex_version`을 더한 객체. `session_id`, `thread_id`, `turn_id`, `model`, `reasoning_effort`, `auto_review_enabled`, `node_repl_auto_review_required`, `node_repl_disabled`, `turn_started_at_unix_ms` 등이 들어간다 (`core/src/turn_metadata.rs`, `core/src/responses_metadata.rs`) | sky가 `nodeRepl.requestMeta`에서 읽어 네이티브 서비스 요청의 `codexTurnMetadata`로 전달하고, `call_id`/`item_id`에서 `tool_call_id`를 얻는다. `node_repl`은 `node_repl_auto_review_required`가 `true`이면 실행 승인 요청을 보낸다(아래 표) |
| `openai/confirmation_policies` | 모델 메타데이터의 `browser_use`, `computer_use` 정책 문서. 없으면 빈 객체. node_repl 계열 서버(또는 브라우저 커넥터)에, Guardian 세션이 아닐 때만 넣는다 | `@oai` JS 3개 파일에서 참조 |
| `threadId`, `sessionId` | 스레드·세션 식별자 | 미확인 |
| `windowId`, `itemId` | 호출을 발생시킨 창·항목. 해당 정보가 있을 때만 | 미확인 |
| `plugin_id` | 도구를 제공한 플러그인 ID. 있을 때만 | 미확인 |
| `codex/sandbox-state-meta` | 권한 프로필과 sandbox cwd. 서버가 이 기능을 선언했을 때만 | 추정: `node_repl`이 Codex CLI로 샌드박스 실행할 때 사용. 바이너리에 `permissionProfile`, `sandboxCwd`, `useLegacyLandlock` 문자열이 있다 |

### 3. 바깥 호출 승인

`js`는 `readOnlyHint: true`라서 Codex의 기본 승인 모드(`auto`)에서는 호출 전에 사용자에게 묻지 않는다 (`requires_mcp_tool_approval`). 실제 승인은 런타임이 실행 도중 보내는 확인 요청으로 처리한다.

### 4. 확인 요청 처리

런타임 JS가 `nodeRepl.createElicitation()`을 부르면 `node_repl`이 호스트에 MCP `elicitation/create`를 보낸다. sky의 `withSuspendedTimeout`은 확인 요청이 아니라 승인 뒤의 실제 앱 조작을 감싼다(`computer-use-policy.js`). 이름으로 보아 조작이 끝날 때까지 `js` 실행 제한 시간을 멈추는 것으로 추정한다.

런타임(sky), 브라우저 서비스 코드(`browser-service.mjs`), Codex 테스트에서 확인한 요청 종류:

| 요청 | `_meta` 특징 |
| --- | --- |
| `js` 실행 승인 | `connector_id: node_repl`, `tool_name: js`, `codex_approval_kind: mcp_tool_call`, `codex_strict_auto_review: true`, `codex_request_type: approval_request`. `x-codex-turn-metadata.node_repl_auto_review_required`가 `true`일 때 온다. 근거는 실제 `node_repl` 동작을 흉내 낸다는 Codex 테스트 서버(`app-server/tests/suite/v2/mcp_tool.rs`)다 |
| 앱 사용 허용 ("Allow Computer Use to use X?") | `connector_id: computer-use`, `persist`(`session`, 허용 시 `always`도), `riskLevel`, `tool_params.app` |
| 컴퓨터 오디오 녹음 허용 | `connector_id: computer-use`, `codex_request_type: approval_request`, `riskLevel: high` |
| 브라우저 방문 기록 사용 | `connector_id: browser-use`, `sensitive_data: browsing_history` |
| 출처(origin) 접근 | `codex_sensitive_action: true`, 자동 검토 대상이면 `codex_request_type: approval_request` |
| 다운로드·업로드 | `persist`, `file_transfer`, `origin` |
| 페이지 자원 다운로드 | `persist`, `tool_params.asset_origins` |
| Chrome DevTools Protocol 전체 접근 | `riskLevel: high`, `full_cdp_access: true` |
| WebMCP 도구 호출 | `codex_strict_auto_review: true`, `codex_sensitive_action: true` |
| 자동 안전 사전 검사 | `codex_strict_auto_review: true`. 자동 검토를 지원하지 않는 환경이면 "not supported in this environment" 오류로 실패하도록 되어 있음 |
| 이메일 OTP 입력 | `codex_requires_user_input: true`, 스키마에 `approved` boolean 필드 |
| 브라우저 인증(QR 등) | `codex_approval_kind: browser_auth`, `codex_requires_user_input: true` |

대부분 `codex_approval_kind`(대부분 `mcp_tool_call`), `connector_name`, `tool_params`가 붙고, 요청에 따라 `tool_name`, `tool_title`, `tool_params_display`가 붙는다. 예를 들어 방문 기록 요청에는 `tool_name`이 없고, 앱 사용 허용 요청에는 `tool_title`이 없다.

Codex TUI의 응답 방식 (`tui/src/bottom_pane/mcp_server_elicitation.rs`):

- 스키마에 필드가 없는 요청이면 선택지를 `Allow`, `Allow for this session`(`persist`에 `session`이 있을 때), `Always allow`(`always`가 있을 때)로 보여 준다.
- 도구 승인 요청(`codex_approval_kind: mcp_tool_call`)이면 여기에 `Cancel`만 더하고, 그 밖의 요청이면 `Deny`와 `Cancel`을 더한다. 런타임 요청 대부분이 `mcp_tool_call`이므로 Codex TUI는 이 요청들에 `decline`을 보내지 않는다. 브라우저 서비스는 `cancel`을 "닫음(명시적 거부 아님)", `decline`을 거부로 구분해 처리한다.
- 응답은 `Allow` → `{action: "accept"}`, 세션 허용 → `{action: "accept", _meta: {persist: "session"}}`, 항상 허용 → `{action: "accept", _meta: {persist: "always"}}`, `Deny` → `decline`, `Cancel` → `cancel`이다. 영구 기억은 런타임이 `_meta.persist`를 보고 처리한다.
- 필드가 있는 폼이면 입력값을 `content`에 담아 `accept`로 보낸다.

Codex 코어의 자동 처리 (`core/src/session/mcp.rs`의 `review_guardian_mcp_elicitation`):

- **사용자 승인자의 `js` 자동 승인.** 승인자가 사용자이고, 서버가 `node_repl`/`cua_repl`이고, `_meta`가 `tool_name: js`, `connector_id: node_repl`, `codex_approval_kind: mcp_tool_call`이며 `codex_sensitive_action`·`codex_requires_user_input`이 없고, 스키마가 빈 폼 요청이면 묻지 않고 승인한다. 즉 위 표의 `js` 실행 승인을 사용자에게 다시 묻지 않는 규칙이다. 응답은 `{action: "accept", content: {}, _meta: {approvals_reviewer: "auto_review"}}`이고, 턴이 취소된 상태면 `cancel`로 응답한다.
- **Full Access.** 스키마가 빈 요청은 같은 방식으로 자동 승인한다.
- **`codex_strict_auto_review: true` 요청.** 승인자 설정과 관계없이 사용자 대신 Guardian 검토를 요구한다. 단 GuardianApproval 기능이 꺼져 있거나, 요구사항상 자동 검토를 쓸 수 없거나, 요청에 `persist` 키가 있으면 일반 사용자 흐름으로 넘긴다.
- **그 밖의 요청.** 승인 정책이 `Never`면 권한 프로필에 따라 자동 승인하거나 거부한다. 아니면 `codex_request_type: approval_request`가 있고 승인자가 자동 검토일 때 Guardian에 넘기고, 나머지는 사용자에게 묻는다.
- **동기 검토.** `codex_sensitive_action: true`만 동기 검토를 강제한다. 자동 검토의 응답 `_meta`에는 `approvals_reviewer`가 들어가고, 거부 사유는 `_meta.message`로 전달된다.
- **자동 안전 사전 검사.** 브라우저 서비스는 응답 `_meta.approvals_reviewer`가 자동 검토(`auto_review`/`guardian_subagent`)일 때만 통과시킨다. 사용자 승인만 구현하면 이 경로를 쓰는 기능은 항상 실패한다.

### 5. 결과 전달

결과의 텍스트와 이미지 블록을 모델에 전달한다. Codex는 승인 검토 근거로 텍스트와 스크린샷을 스레드당 최대 8MB까지 보관한다 (`core/src/context/node_repl_review_evidence.rs`). TUI는 `cua_repl` 호출이 연달아 오면 한 묶음으로 보여 준다 (`tui/src/history_cell/computer_activity.rs`). 둘 다 동작에 필수는 아니다.

### 6. 턴 종료

플러그인 hook이 `Stop`, `Interrupt`, `SubagentStop` 이벤트에서 `turn_ended`를 호출한다. 입력은 `{hook_event_name, session_id, turn_id}`이고, `SubagentStop`은 `session_id` 자리에 `agent_id`를 넣는다. 도구 설명은 "Notify trusted libraries that a Codex turn ended"다. 사용자 `~/.codex/config.toml`에는 이전 방식으로 `notify = [SkyComputerUseClient, "turn-ended"]`도 남아 있다.

## 설치

### Codex 데스크톱 앱의 설치 결과

데스크톱 앱 코드는 없으므로, 설치 후 남은 파일로 단계를 역추적했다.

| 단계 | 확인한 결과 |
| --- | --- |
| 1. 앱에 런타임 포함 | `ChatGPT.app/Contents/Resources/cua_node`(런타임)와 `Contents/Resources/plugins/openai-bundled`(번들 플러그인). 런타임에는 검증 스크립트 `bin/setup.sh`가 있다. 이 스크립트는 `@oai/sky` 불러오기, node·npm·corepack 버전, `node_repl --help`만 확인한다 |
| 2. 플러그인 목록 전개 | `~/.codex/.tmp/bundled-marketplaces/openai-bundled`. `.materialization-key`에 앱 버전과 기능 플래그(`computerUseAudioEnabled` 등)가 있다 |
| 3. 플러그인 설치 | `~/.codex/plugins/cache/openai-bundled/<이름>/<버전>/`. 비활성 `.mcp.json`에 실행 경로와 환경변수를 채우고 `enabled: true`로 바꾼다 |
| 4. 서비스 앱 배치 | `~/.codex/computer-use/Codex Computer Use.app`. 앱 안 `@oai/sky/Codex Computer Use.app`과 `diff -rq` 결과 완전히 같다. 같은 폴더에 `config.json`("ChatGPT is using your computer" 등 UI 문자열)과 `sessions/`도 있다. 번들에는 `embedded.provisionprofile`, 부모 프로세스 제약(`*_Parent.coderequirement`), `SharedSupport/Codex Computer Use Installer.app`이 들어 있어, 단순 복사만으로 배치하는지는 알 수 없다 |
| 5. Codex 설정 기록 | `~/.codex/config.toml`의 `[marketplaces.openai-bundled]`, `[plugins."...@openai-bundled"]`, `[mcp_servers.node_repl]`, `notify` |
| 6. Chrome 연결 | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json`. 실행 파일은 `~/.codex/plugins/cache/openai-bundled/chrome/latest/extension-host/macos/arm64/ChatGPT for Chrome`이고, 허용 확장 ID는 `hehggadaopoacecdllhhajmbjkdcmajg`, `odlomjlbamekndcpllcnffbgeohgkmjh`다. 등록 내역은 `~/.codex/chrome-native-hosts-v2.json`에도 남는다 |
| 7. 사용자 작업 | 앱 로그인, macOS 권한 허용, Chrome 확장 설치 |

`codex-rs`(오픈소스 CLI)에는 이 설치 코드가 없다. 플러그인 ID와 정리용 hook 허용 목록만 있다. 런타임을 내려받는 공개 주소도 찾지 못했다. `manifest.json`의 `node_archive_path`는 기준 주소 없는 상대 경로다.

### 패키지가 대신할 수 있는 범위

| 작업 | 가능 여부 | 방법 |
| --- | --- | --- |
| ChatGPT 데스크톱 앱 설치 | 대신하지 않음 | 없으면 공식 설치 안내를 보여 준다. 런타임을 다른 곳에서 내려받지 않는다 |
| 런타임 검증 | 가능 | 앱의 `cua_node/bin/setup.sh`를 실행하고 `manifest.json`을 읽는다. `setup.sh`가 확인하지 않는 `@oai/cua-repl`, `@oai/cua`, `@oai/browser-desktop`은 따로 확인한다 |
| 서비스 앱 위치 지정 | 가능 (우선 시험) | sky는 서비스 앱을 `SKY_CUA_SERVICE_PATH` → `$CODEX_HOME/computer-use/Codex Computer Use.app` → 번들 ID 순서로 찾는다(`native-pipe.js`). `~/.codex/computer-use`에 앱이 없으면 앱 안 사본 경로를 `SKY_CUA_SERVICE_PATH`로 지정해 복사 없이 쓸 수 있는지 0단계에서 시험한다 |
| 서비스 앱 복사 | 보류 | 위 방법이 안 될 때만 검토한다. 복사한다면 `codesign --verify`로 서명을 확인하고 사용자 확인 후 실행한다. `~/.codex/computer-use`는 데스크톱 앱이 관리하는 위치다 |
| MCP 실행 설정 | 가능 | 플러그인 캐시의 `.mcp.json`이 있으면 그것을 쓰고, 없으면 앱의 `cua_node` 경로와 데스크톱 앱이 넣는 것과 같은 환경변수로 직접 만든다. 파일로 저장하지 않고 실행할 때마다 만든다 |
| Codex 설정·플러그인 캐시 | 바꾸지 않음 | `~/.codex/config.toml`과 `~/.codex/plugins`는 데스크톱 앱이 관리한다 |
| Chrome 네이티브 호스트 등록 | 대신하지 않음 (제안) | 매니페스트가 데스크톱 앱이 관리하는 실행 파일을 가리킨다. 없으면 ChatGPT 앱에서 Chrome 플러그인을 켜도록 안내한다 |
| 로그인·구독 | 대신할 수 없음 | 사용자가 ChatGPT 앱에서 한다 |
| macOS 권한 | 대신할 수 없음 | macOS가 사용자 동의를 요구한다. 서비스가 권한 오류를 내면 허용 위치를 안내한다 |
| ChatGPT Chrome 확장 설치 | 대신할 수 없음 | Chrome 웹 스토어에서 사용자가 설치한다 |

사용자 흐름 제안:

1. `pi install npm:@buyong/pi-codex-computer-use`로 패키지를 설치한다.
2. `/codex-computer-use`를 실행하면 사전 요구사항을 점검하고, 빠진 항목과 다음 할 일을 보여 준다.
3. 패키지가 대신할 수 있는 항목(런타임 검증, 서비스 앱 위치 지정)은 자동으로 처리하고, 파일을 바꾸는 작업은 사용자가 확인해야 실행한다.
4. 사용자가 기능을 켜면 서버를 띄운다. 처음 실행할 때 macOS 권한 요청이 나오면 사용자가 허용한다.

런타임 경로를 읽기 전용으로 쓰고 Codex 설정을 바꾸지 않으므로, 데스크톱 앱이 업데이트되면 패키지는 다음 실행 때 새 경로와 버전을 다시 찾는다.

## 기능별 켜기·끄기

요구사항: Computer Use와 Browser Use를 각각 켜고 끌 수 있어야 하고, 켜진 기능에 맞춰 MCP 서버를 추가한다.

### Codex의 방식

`cua_repl` 실행기(`@oai/cua-repl/dist/lib/js/oai_js_cua_repl/src/launch.js`)는 `CUA_REPL_ENABLED_SURFACES` 값 하나로 세 가지를 정한다.

| 결정 대상 | `browser` 포함 | `computer` 포함 |
| --- | --- | --- |
| 신뢰 서비스 (`NODE_REPL_TRUSTED_SERVICES`가 없을 때만 계산) | `browser: @oai/browser-desktop/service` | `sky: @oai/sky/service` |
| `js` 도구 설명 | 브라우저 안내 추가. 없으면 "Browser APIs are disabled." | 데스크톱 앱 안내 추가. 없으면 "Native computer APIs are disabled." |
| REPL 초기화 (`@oai/cua/tinyskyAlt`의 `globals.js`가 환경변수를 읽어 결정) | 브라우저 제공자 설정 | sky 제공자 설정 |

실행기는 이 값을 `NODE_REPL_UNTRUSTED_ENV_ALLOWLIST`에 넣어 REPL 안에서 읽게 하고, 도구 설명은 `NODE_REPL_TOOL_OVERRIDES`로 `node_repl`에 전달한다. 값은 프로세스가 시작할 때 정해지므로, 바꾸려면 서버를 다시 시작해야 한다.

`codex-rs`는 `computer_use`, `browser_use` 기능 게이트와 `allow_browser_and_computer_use` 요구사항을 파싱해 앱 서버 설정으로 내보낼 뿐 직접 쓰지 않는다. 데스크톱 앱이 이 게이트와 플러그인 활성화 상태로 `.mcp.json`의 값을 정하는 것으로 보이지만, 데스크톱 앱 코드가 없어 확인하지 못했다. 이 Mac은 두 기능이 모두 켜져 있고 값은 `browser,computer`다.

### 직접 확인한 결과

`.mcp.json`의 명령과 환경변수에서 `NODE_REPL_TRUSTED_SERVICES`를 빼고 이 값만 바꿔 `initialize`, `tools/list`를 보냈다. 도구는 호출하지 않았다.

| `CUA_REPL_ENABLED_SURFACES` | 시작 | 도구 목록 | `js` 설명 |
| --- | --- | --- | --- |
| `browser,computer` | 성공 | 4개 | 2,952자, 브라우저·앱 API 모두 안내 |
| `browser` | 성공 | 4개 | 2,847자, `cua.getApp` 없음, "Native computer APIs are disabled." |
| `computer` | 성공 | 4개 | 1,511자, `createBrowserTab` 없음, "Browser APIs are disabled." |
| `""` (빈 값) | 성공 | 4개 | 1,406자, 두 기능 모두 비활성 안내 |
| 없음 | 실패 | — | `CUA_REPL_ENABLED_SURFACES is required` |

README는 빈 값도 시작에 실패한다고 쓰지만, 실제로는 두 기능이 꺼진 채로 시작된다. 도구 이름은 설정과 관계없이 같고 설명만 바뀐다.

### pi 패키지 설계

| 설정 | MCP 서버 | 모델에 보이는 도구 |
| --- | --- | --- |
| 둘 다 켜짐 | `cua_repl`, `browser,computer` | `js`, `js_reset` |
| Computer Use만 | `cua_repl`, `computer` | `js`, `js_reset` |
| Browser Use만 | `cua_repl`, `browser` | `js`, `js_reset` |
| 둘 다 꺼짐 | 시작하지 않음 | 없음 |

- **서버는 Codex처럼 `cua_repl` 하나만 둔다.** 기능마다 서버를 따로 띄우면 같은 이름의 `js` 도구가 둘이 되고, REPL 상태와 턴 종료 알림도 둘로 나뉘어 Codex 흐름과 달라진다.
- **둘 다 꺼지면 서버를 띄우지 않는다.** 빈 값으로도 시작은 되지만 쓸 수 있는 API가 없다.
- **환경변수는 `.mcp.json` 값을 기준으로 하되 두 가지를 바꾼다.** `CUA_REPL_ENABLED_SURFACES`는 설정에서 만든다. `NODE_REPL_TRUSTED_SERVICES`는 켜진 기능의 키(`browser`, `sky`)만 남기고, 형식을 해석할 수 없으면 빼서 실행기가 계산하게 한다. `.mcp.json` 값을 그대로 넘기면 꺼진 기능의 서비스도 신뢰 대상에 남는다.
- **도구 설명은 직접 만들지 않는다.** 설정에 맞는 설명이 `tools/list`에서 오므로, 도구는 서버 연결 뒤 그 결과로 등록한다. 연결에 실패하면 도구를 등록하지 않고 이유를 알린다.
- **서버는 확장 팩토리에서 시작하지 않는다.** pi 문서(`docs/extensions.md`)가 팩토리에서 프로세스를 시작하지 말고 `session_start`나 필요한 명령·도구에서 시작하라고 한다.
- **실행 중에 설정을 바꾸면 서버를 다시 시작한다.** 순서는 에이전트 실행이 끝날 때까지 기다림 → 기존 서버 종료 → 새 값으로 시작 → 도구 다시 등록이다. pi는 도구 등록을 해제할 수 없으므로, 둘 다 꺼질 때는 같은 이름을 `exposure: "hidden"`으로 다시 등록해 도구를 거둔다 (`docs/extensions.md`의 Tool exposure). 명령에서 `ctx.reload()`로 확장을 다시 불러오는 방식도 가능하다.
- **다시 시작하면 REPL 상태가 사라진다.** 이전 JS 변수와 탭·앱 바인딩이 없어진다. pi는 도구 변경을 다음 모델 요청 전에 대화 기록에 추가하므로, 모델은 바뀐 설명을 받는다.
- **설정 저장과 변경 수단이 필요하다.** 저장 위치, 명령 형태, 기본값은 [결정이 필요한 사항](#결정이-필요한-사항)에 제안을 적었다.

## pi에 옮기는 방법

### MCP 연결은 패키지가 직접 소유한다

pi 기본 MCP 확장(`pi.registerMcpServer()`나 `mcp.json`)을 그대로 쓰면 확인 요청을 처리할 수 없다. pi 0.99.1의 MCP 런타임에는 elicitation 처리 코드도 기능 선언도 없다. `createMcpExtension({ createTransport })`으로 전송 계층을 감싸 가로채는 방법은 있고, `pi-codex-auto-review`의 보호 MCP 경로가 이 방식을 쓴다. 그러나 auto-review는 다음을 모두 만족하는 빈 승인 폼만 허용하고 나머지는 `decline`한다: auto-review가 만든 `callId`가 요청 `_meta`에 돌아옴, URL 모드가 아님, `codex_approval_kind: mcp_tool_call`, `tool_params`가 객체, `tool_name`·`connector_id`가 바깥 도구와 일치. 런타임이 보내는 `connector_id: computer-use`, `browser-use` 요청은 일치하지 않아 거부될 것으로 보인다(코드 기준 추론이고 실행 확인은 하지 않았다).

따라서 패키지가 `@earendil-works/pi-mcp`의 `McpClient`와 `StdioTransport`로 서버를 직접 띄운다. 이 라이브러리는 pi 0.99.1이 내부에서 쓰는 MCP 클라이언트로, `capabilities` 지정, `setRequestHandler("elicitation/create", ...)`, 임의 `request("tools/call", { name, arguments, _meta })`를 지원한다. 주의할 점:

- **의존성.** 현재 저장소에서는 `pi-coding-agent`의 하위 의존성(0.99.1)으로만 설치되어 있고 npm 최신은 1.0.2다. pi가 패키지에 제공하는 목록(`docs/packages.md`)에 없으므로 `dependencies`에 넣는다. 버전은 구현 시 정한다.
- **프로토콜 버전.** 기본값은 `2025-11-25`다. Codex와 같은 `2025-06-18`로 고정한다. `ClientCapabilities` 타입에는 `extensions`가 없으므로, Codex처럼 확장을 선언하려면 타입을 넓혀야 한다.
- **요청 타임아웃.** 기본 요청 타임아웃이 30초(`DEFAULT_REQUEST_TIMEOUT_MS`)이고 `tools/call`에도 적용되며, 시간이 지나면 취소 알림을 보낸다. 사용자가 확인 요청에 답하는 동안 호출이 끊길 수 있다. `timeoutMs`가 0 이하면 타이머를 걸지 않으므로, `tools/call`은 `timeoutMs: 0`으로 보내고 취소는 `signal`로만 처리한다. 실행 제한은 `js`의 `timeout_ms`가 맡는다.

### Codex 요소와 pi 대응

| Codex | pi 구현 |
| --- | --- |
| `.mcp.json` 기반 서버 실행 | `~/.codex/plugins/cache/openai-bundled/unified-computer-use/*/.mcp.json` 중 `enabled: true`이고 실행 파일이 있는 최신 버전을 찾는다. 없으면 앱의 `cua_node`로 같은 설정을 만든다 ([설치](#설치)). `command`, `args`, `env`를 사용하되 `CUA_REPL_ENABLED_SURFACES`와 `NODE_REPL_TRUSTED_SERVICES`는 기능 설정에 맞춰 바꾼다. `CODEX_HOME`이 있으면 우선한다 |
| 기능 게이트와 플러그인 활성화 | 패키지 설정의 Computer Use·Browser Use 켜기·끄기. 값에 따라 서버 시작 여부와 `CUA_REPL_ENABLED_SURFACES`를 정한다 |
| 도구 `mcp__cua_repl__js`, `js_reset` | `pi.registerTool()`로 등록하고 `namespace: { name: "mcp__cua_repl" }`, 서버 instructions와 도구 설명, annotations를 그대로 사용한다. `turn_ended`는 모델에게 노출하지 않는다 |
| `_meta.callId` | pi `execute()`의 `toolCallId` |
| `sessionId`, `threadId`, `x-codex-turn-metadata.session_id` | `ctx.sessionManager.getSessionId()` |
| `turn_id` | Codex의 턴은 사용자 입력 하나에 대한 에이전트 실행 전체다. pi의 `agent_start`마다 새 ID를 만든다. pi의 `turn_start`는 모델 응답 단위라 다르다 |
| `x-codex-turn-metadata`의 승인 관련 값 | `node_repl_auto_review_required`, `auto_review_enabled`, `model` 등을 어떤 값으로 보낼지 정한다 ([결정이 필요한 사항](#결정이-필요한-사항)) |
| 확인 요청 UI | `ctx.ui.select()`로 Codex와 같은 선택지(`mcp_tool_call`이면 Cancel만, 그 밖이면 Deny·Cancel)와 응답 형식을 쓴다. 필드가 있는 폼은 `ctx.ui.input()` 등으로 받는다. UI가 없는 JSON·print 모드(`!ctx.hasUI`)에서 어떻게 응답할지 정해야 한다 |
| 사용자 승인자의 `js`/`node_repl` 자동 승인 | 같은 조건으로 자동 승인하고, 응답 `_meta.approvals_reviewer: "auto_review"`까지 맞출지 정한다 |
| 결과 | MCP `text`, `image` 블록을 pi `TextContent`, `ImageContent`로 변환한다. `.mcp.json`의 `output_token_limit: 25000`에 맞춰 길이를 제한한다. 참고로 pi 기본 MCP는 텍스트를 20KB에서 자른다 |
| 동시 실행 | REPL 상태를 공유하므로 도구를 `executionMode: "sequential"`로 등록하는 것을 검토한다 |
| `Stop` / `Interrupt` hook | `agent_end` 뒤에도 재시도·압축·후속 실행이 이어질 수 있다. `agent_before_settle`에서 `outcome`(`completed`, `aborted`, `error`)을 기록하고, 더 이어지지 않음을 알리는 `agent_settled`에서 `turn_ended`를 호출한다. `completed`→`Stop`, `aborted`→`Interrupt`다. Codex도 후속이 없을 때 Stop을, 사용자 중단(`TurnAbortReason::Interrupted`)일 때 Interrupt를 부른다. `error` 처리는 정해야 한다 |
| 취소 | `execute()`의 `signal`을 `McpRequestOptions.signal`로 넘긴다 |
| 세션 종료 | `session_shutdown`에서 클라이언트를 닫는다 |

`AgentEndEvent`에는 `messages`만 있고 `outcome`은 `agent_before_settle`(`BoundaryState`)에만 있다 (`dist/core/extensions/types.d.ts`, `docs/extensions.md`).

### 패키지 구성 제안

`packages/pi-codex-computer-use`에 `pi-codex-auto-review`와 같은 설정을 둔다: ESM, `tsc` 빌드, `dist/index.js`를 `pi.extensions`로 노출, pi 패키지는 `peerDependencies`, Node `>=22.19.0`, `publishConfig.access: public`.

| 모듈 | 책임 |
| --- | --- |
| `settings.ts` | Computer Use·Browser Use 켜기·끄기 저장과 검증 |
| `commands.ts` | 설정 변경과 설치 점검을 실행하는 `/` 명령 |
| `install.ts` | 사전 요구사항 점검, 런타임 검증, 서비스 앱 위치 지정 |
| `runtime.ts` | 설치된 런타임과 `.mcp.json` 탐색, 실행 가능 여부 판단, 설정에 맞는 환경변수 구성 |
| `connection.ts` | `McpClient` 연결, 설정 변경 시 재시작, 종료 |
| `tools.ts` | 도구 등록과 `_meta` 구성, 결과 변환 |
| `elicitation.ts` | 확인 요청 분류와 pi UI 응답 |
| `turn.ts` | 턴 ID 관리와 `turn_ended` 호출 |
| `index.ts` | 확장 진입점과 이벤트 연결 |

저장소 스크립트 일부는 `pi-codex-auto-review`에 고정되어 있다. `scripts/check-package.mjs`는 그 패키지만 pack하고, `scripts/run-tests.mjs`는 그 패키지의 `dist/reports.js`를 import한다. `verify-platform`, `verify-windows`, `verify-docker`, `handoffs`, `auto-review-evidence` 스크립트도 auto-review용이다. 릴리스 스크립트와 npm 워크플로는 workspace 전체를 다룬다.

## `pi-codex-auto-review`와의 관계

- **일반 pi 확장으로 쓸 때.** 현재 소스의 auto-review는 다른 확장의 도구를 승인 없이 실행한다(`packages/pi-codex-auto-review/src/index.ts`의 `tool_call` 처리 주석 "Like Codex dynamic and extension tools, other extension tools run without approval"). 새 패키지의 도구도 그대로 실행되고, 승인은 패키지의 확인 요청 처리가 맡는다. 이 문서를 쓴 세션은 이전 빌드가 로드되어 미등록 도구가 `Unknown tool needs an explicit trusted adapter`로 차단됐지만, 현재 소스에는 이 차단이 없다. `trustedTools` 설정은 정의만 있고 쓰이지 않는다.
- **보호 런타임(`createGuardedRuntime`)에서 쓸 때.** 일반 확장을 로드하지 않는다(`noExtensions: true`). 새 패키지를 `externalExtensions` 어댑터(`ExternalExtension`)로 넘겨야 검토 경로를 탄다. 이때 도구가 `readOnlyHint: true`이므로 바깥 호출은 검토 없이 통과한다.
- Codex의 승인자 구분(사용자 / 자동 검토)을 재현하려면 확인 요청을 auto-review 검토자에 넘기는 연결도 필요하다. 처음에는 사용자 승인만 구현하고 자동 검토 연결은 다음 단계로 두는 것을 제안한다. 이 경우 자동 검토를 요구하는 기능(자동 안전 사전 검사 등)은 실패한다는 점을 사용자에게 알린다.

## 진행 단계

각 단계는 실제 pi 세션에서 결과를 확인한 뒤 다음으로 넘어간다.

0. **동작 가능성 검증 (구현 전).** pi 밖에서 `cua_repl`을 띄우고 `js`로 `await cua.getState()`를 한 번 호출한다. 네이티브 서비스 연결이 되는지, 접속 프로세스를 검사해 거부하는지, 확인 요청이 오는지, `_meta`(특히 `x-codex-turn-metadata`) 없이도 동작하는지, 앱 안 서비스 앱 경로를 `SKY_CUA_SERVICE_PATH`로 지정해도 되는지 기록한다. 이 호출은 `Codex Computer Use.app`을 실행하고 앱·브라우저 목록을 읽으므로 사용자 승인 후 실행한다.
1. **설치 점검.** 사전 요구사항 점검과 안내, 런타임 검증, 서비스 앱 위치 지정. 데스크톱 앱이 있고 플러그인 캐시가 없는 상태에서도 서버가 뜨는지 확인한다. 복사를 택한다면 복사 뒤 Codex 데스크톱의 Computer Use가 계속 동작하는지도 확인한다.
2. **설정·연결·도구 등록.** 기능별 켜기·끄기 설정과 명령, 런타임 탐색, 연결, `js`와 `js_reset` 등록, 결과 텍스트·이미지 전달. 네 가지 조합 각각에서 서버 시작 여부, `CUA_REPL_ENABLED_SURFACES`와 `NODE_REPL_TRUSTED_SERVICES` 값, 모델에 전달된 도구 설명을 확인한다. 실행 중 설정 변경 뒤 이전 서버 프로세스가 남지 않는지도 본다. 런타임이 없으면 도구를 등록하지 않고 이유를 알린다.
3. **확인 요청.** 앱 사용 허용 흐름을 끝까지 확인한다. 허용·세션 허용·항상 허용·취소(그 밖의 요청은 거부도) 각각의 실제 효과와, 사용자가 30초 넘게 답하지 않아도 호출이 유지되는지 본다.
4. **턴 수명주기.** 정상 종료와 중단에서 `turn_ended`가 한 번씩 호출되는지, 화면의 "ChatGPT is using your computer" 표시가 사라지는지 본다.
5. **Browser Use.** `chrome` 백엔드(ChatGPT Chrome 확장과 네이티브 호스트 `com.openai.codexextension`)를 확인한다. `iab`(앱 내 브라우저)와 `mcpapps`는 ChatGPT 데스크톱 앱 안에서만 동작할 가능성이 높아, pi에서는 `BROWSER_USE_AVAILABLE_BACKENDS`를 줄여야 할 수 있다.
6. **auto-review 연동과 배포 준비.** 위 관계 절의 방식을 정하고, 패키지 검사 스크립트 범위를 정한다. npm 게시는 별도 승인 후 진행한다.

## 제약과 위험

- **라이선스.** `computer-use`, `browser`, `chrome` 플러그인의 `plugin.json`은 `Proprietary`이고, `Codex Computer Use.app`은 "Copyright © 2026 OpenAI. All rights reserved."다. `@oai` 패키지와 `unified-computer-use`에는 라이선스 표기가 없다. 패키지는 사용자 기기에 이미 설치된 파일을 실행만 한다. OpenAI 약관이 Codex 외 호스트에서의 사용을 허용하는지는 확인하지 않았다.
- **플랫폼.** 런타임이 ChatGPT.app 안에 있으므로 macOS와 ChatGPT 데스크톱 앱 설치가 전제다. 런타임 문서에 Linux·Windows 안내가 있지만 이 Mac 밖에서는 확인하지 않았다.
- **비공개 인터페이스.** 환경변수, `_meta` 키, 확인 요청 형식은 공개 계약이 아니다. 앱 업데이트로 바뀔 수 있으므로 버전과 탐색 결과를 로그로 남기고, 맞지 않으면 명확히 실패해야 한다.
- **권한.** 화면 조작 권한(손쉬운 사용, 화면 기록)은 `Codex Computer Use.app`이 가진다. pi나 터미널에 추가 권한이 필요한지는 0단계에서 확인한다.
- **원격 전송.** sky에는 telemetry 모듈(`computer-use-telemetry.js`)과 `@statsig/js-client` 의존성이 있다. Codex 밖에서 실행해도 사용 정보가 전송되는지는 확인하지 않았다.

## 결정이 필요한 사항

| 항목 | 제안 | 이유 |
| --- | --- | --- |
| 기본값 | 둘 다 꺼짐 | 화면·브라우저 조작은 사용자가 명시적으로 켜야 한다 |
| 저장 위치 | `~/.pi/agent/codex-computer-use/settings.json`의 `{ "computerUse": false, "browserUse": false }` | auto-review의 `~/.pi/agent/guard/settings.json`과 같은 방식 |
| 변경 명령 | `/codex-computer-use` 하나. 인자 없이 실행하면 현재 상태를 보여 주고 선택해 바꾼다. `computer on`, `browser off` 같은 인자도 받는다 | 두 기능을 한 곳에서 관리한다 |
| 실행 중 변경 | 에이전트가 멈춘 뒤 바로 서버를 다시 시작하고 도구를 다시 등록한다 | 새 세션 없이 바로 적용된다 |
| Browser Use 백엔드 선택 | 처음에는 노출하지 않고 5단계 결과로 정한다 | `iab`, `mcpapps`의 pi 동작을 아직 모른다 |
| 설치 범위 | 점검·안내, 런타임 검증, 서비스 앱 위치 지정까지 한다. Codex 설정, 플러그인 캐시, `~/.codex/computer-use`, Chrome 네이티브 호스트는 바꾸지 않는다. 서비스 앱 복사는 0단계 결과로 다시 정한다 | 모두 데스크톱 앱이 관리하는 위치이고, 복사가 서명·업데이트와 충돌하는지 확인하지 못했다 |
| `x-codex-turn-metadata` | `session_id`, `thread_id`, `turn_id`와 `node_repl_auto_review_required: false`를 보내고, `model`은 pi 현재 모델 이름을 넣는다. 0단계에서 값별 동작을 확인한다 | 자동 검토가 없는 동안 런타임이 없는 검토를 요구하지 않게 한다. `model` 값에 따라 `node_repl is unavailable for this model`이 나올 수 있어 확인이 필요하다 |
| 확인 요청 사용자 응답 대기 | 제한 없음. 사용자가 에이전트를 중단하면 `cancel`로 응답한다 | Codex TUI도 응답을 기다린다 |

## 미확인 사항

- Codex 밖에서 `js` 실행 시 네이티브 서비스 연결과 확인 요청 동작
- 구독·로그인이 없을 때 막히는 지점과 오류 형태, 지원 플랜 범위
- 서비스가 데스크톱 앱 밖에서 처음 실행될 때 macOS 권한 안내를 스스로 띄우는지
- 데스크톱 앱이 실행 중이어야 하는지
- 패키지가 서비스 앱을 복사했을 때 데스크톱 앱의 설치·업데이트와 충돌하는지, 앱 안 사본을 `SKY_CUA_SERVICE_PATH`로 직접 쓸 수 있는지
- 부모 프로세스 제약(`SkyComputerUseClient_Parent.coderequirement`)이 pi에서 띄운 프로세스에 영향을 주는지
- `x-codex-turn-metadata`의 `model`·`node_repl_auto_review_required` 값에 따른 `node_repl` 동작
- Codex 데스크톱이 기능 게이트와 플러그인 활성화 상태로 `CUA_REPL_ENABLED_SURFACES`를 정하는지
- 한쪽 기능만 켜고 `js`를 실행했을 때의 동작 (시작과 도구 설명까지만 확인함)
- `node_repl`이 확인 요청 `_meta`에 `callId`를 넣는지와 그 형식
- `x-codex-turn-metadata`, `openai/confirmation_policies`, `codex/sandbox-state-meta`를 보내지 않을 때의 영향
- `turn_ended`의 실제 효과
- `CODEX_CLI_PATH`의 실제 용도 (문자열 근거 추정만 있음)
- 이메일 OTP·브라우저 인증 요청의 세부 형식
- Codex CLI·데스크톱이 실제로 선언하는 MCP 확장 목록
- 기존 pi 패키지가 Codex 런타임을 재사용하는지
- 브라우저 백엔드별(`chrome`, `iab`, `mcpapps`) pi에서의 동작

## 근거 위치

- Codex 소스: `tmp/codex-main/codex-rs/core/src/mcp_tool_call.rs`, `core/src/session/mcp.rs`, `protocol/src/mcp.rs`, `protocol/src/mcp_approval_meta.rs`, `protocol/src/openai_models/guardian.rs`, `codex-mcp/src/rmcp_client.rs`, `codex-mcp/src/client_capabilities.rs`, `tui/src/bottom_pane/mcp_server_elicitation.rs`, `plugin/src/bundled_hooks.rs`, `config/src/browser_computer_use_requirements.rs`, `config/src/config_requirements.rs`(`allow_browser_and_computer_use`), `core/src/turn_metadata.rs`, `app-server/tests/suite/v2/mcp_tool.rs`(실행 승인 요청 흉내), `core/src/session/turn.rs`·`core/src/tasks/mod.rs`(Stop·Interrupt hook)
- 설치된 플러그인: `~/.codex/plugins/cache/openai-bundled/{unified-computer-use,computer-use,browser,chrome}/`
- 런타임: `/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/{cua-repl,cua,sky,browser-desktop}/`
- 설치: `ChatGPT.app/Contents/Info.plist`, `Contents/Resources/cua_node/{manifest.json,bin/setup.sh}`, `Contents/Resources/plugins/openai-bundled`, `~/.codex/.tmp/bundled-marketplaces/openai-bundled/.materialization-key`, `~/.codex/chrome-native-hosts-v2.json`, `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json`
- 계정 정보 참조: `@oai/sky/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService`의 문자열, `tmp/codex-main/codex-rs/core-plugins/src/remote.rs`의 `eligible_plan_types`
- 기능 선택: `@oai/cua-repl/dist/lib/js/oai_js_cua_repl/src/launch.js`, `instructions.js`, `@oai/cua-repl/instructions/{browser,computer}-disabled.md`, `@oai/cua/dist/lib/js/oai_js_cua/src/tinysky_alt/globals.js`
- sky 서비스 연결: `@oai/sky/dist/project/cua/sky_js/src/targets/mac/native-pipe.js`, `computer-use-policy.js`, `client.js`
- 브라우저 확인 요청: `cua_repl`이 쓰는 `@oai/browser-desktop/scripts/browser-service.mjs`(`exports["./service"]`), 같은 함수를 담은 플러그인 사본 `~/.codex/plugins/cache/openai-bundled/browser/<버전>/scripts/browser-service.mjs`
- pi: `node_modules/@earendil-works/pi-coding-agent/docs/mcp.md`, `docs/extensions.md`, `docs/packages.md`, `dist/core/extensions/types.d.ts`, `dist/extensions/mcp/runtime.js`, `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-mcp/dist/{client.js,client.d.ts,protocol/types.d.ts}`
- auto-review: `packages/pi-codex-auto-review/src/tools/mcp.ts`, `src/tools/external.ts`, `src/index.ts`, `src/startup.ts`, `src/policy/index.ts`

## 검증 이력

2026-10-05 하위 에이전트(`claude-opus-5-5`, xhigh)가 로컬 근거로 읽기 전용 검증을 했고, 그 지적 중 auto-review 도구 처리, Codex TUI 선택지, Guardian 분기, 사용자 승인자 자동 승인 조건, 턴 메타데이터 키, pi-mcp 타임아웃과 프로토콜, 턴 종료 이벤트, `withSuspendedTimeout` 위치, 서비스 앱 번들 구성과 탐색 순서를 작성자가 다시 확인해 반영했다. 나머지 세부 항목(요청별 `_meta` 세부, 라이선스 표기, 스크립트 목록 등)은 하위 에이전트의 근거 인용을 따랐다.
