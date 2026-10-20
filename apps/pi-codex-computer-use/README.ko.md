# @buyong/pi-codex-computer-use

[English](README.md) | **한국어**

Codex Desktop이 설치한 런타임으로 Pi에서 네이티브 앱·Chrome을 조작합니다. 확장은 통합 `cua_repl` MCP 서버를 시작하고 텍스트·이미지를 전달하며 런타임 승인 창을 Pi에서 보여 줍니다.

Desktop 런타임이 있는 기기에서 사용하세요. 런타임 자체를 제공하지는 않습니다. **Computer Use·Browser Use는 기본으로 둘 다 켜지고** 각각 바꿀 수 있습니다. 호스트 연결이며 자동화 엔진이나 OS 샌드박스가 아닙니다. OpenAI 런타임을 포함·다운로드·복사·재배포하지 않습니다.

## 요구 사항

| 항목 | 필요한 조건 |
| --- | --- |
| Node.js | 22.19 이상 |
| Pi | 1.0.0 이상. 기록된 실검증은 0.99.1에서 수행했고, 1.0.2에는 상태 확인 기록만 있습니다. 매니페스트의 더 넓은 peer 범위에 속한 이전 버전은 미검증입니다. |
| Codex Desktop | Computer Use 런타임이 설치되어 있고 Codex 접근이 가능한 계정으로 로그인한 상태. 패키지는 구독 이용 가능 여부나 로그인을 확인하지 못합니다. |
| Computer Use | Desktop의 네이티브 서비스. macOS에서는 `Codex Computer Use.app`에 손쉬운 사용·화면 기록 권한을 허용합니다. |
| Browser Use | 실행 중인 Google Chrome, 활성화한 ChatGPT Chrome 확장, 네이티브 메시징 호스트가 등록된 Desktop의 Chrome/Browser 플러그인 |

기록된 실검증은 macOS `ChatGPT.app`(번들 ID `com.openai.codex`) `26.930.31730`을 사용했습니다. Windows 탐색·점검은 구현했지만 **Windows 실기기에서 검증하지 않았습니다.** Linux와 다른 플랫폼은 지원하지 않습니다. Desktop을 실행해 두세요. 앱 종료 상태는 미검증입니다.

**활성 브라우저 백엔드는 Chrome뿐입니다.** Desktop 런타임 문서의 `iab`·`mcpapps`·Edge 예시는 Pi에서 해당 백엔드를 사용할 수 있다는 뜻이 아닙니다.

## 설치와 연결 확인

게시된 릴리스를 설치합니다.

```sh
pi install npm:@buyong/pi-codex-computer-use
pi list
pi
```

릴리스로 고정하려면 `@<version>`을 붙입니다. 현재 체크아웃이나 미게시 패키지는 아래 소스 안내를 사용하세요. 이 개별 확장과 `@buyong/pi-codex`를 함께 활성화하지 마세요.

Pi에서 다음 순서로 진행합니다.

1. `/computer-use-check`에서 사용할 기능의 누락된 요구 사항을 해결합니다. `user-owned`는 직접 확인하고 `unverified`는 통과로 보지 않습니다. 점검은 Desktop의 설치된 검증 스크립트를 실행할 수 있지만 설치나 앱·브라우저 작업은 아닙니다.
2. `/computer-use`에서 필요한 기능만 켜 둡니다. 어느 기능을 바꿔도 공용 런타임을 재시작합니다.
3. `/computer-use status`에서 서버 실행을 확인합니다. 실행 중이 아니라면 모델에 조작을 요청하기 전에 표시된 런타임·설정 문제를 해결합니다.
4. 탭을 열거나 앱을 조작하지 않고 목록만 확인하도록 요청합니다.

```text
Use mcp__cua_repl__js to run await cua.getState(). Summarize the available apps and browsers without operating them.
```

첫 결과는 `mcp__cua_repl__js`가 반환한 활성 기능의 목록입니다. 연결되면 `mcp__cua_repl__js_reset`도 제공합니다. 시작에 실패하면 하단에 문제를 표시하고 도구는 숨깁니다. MCP 서버가 실행 중이거나 사전 검사를 통과해도 모든 앱·브라우저 작업의 성공을 보장하지는 않습니다.

이후 브라우저 작업은 [Chrome 작업·승인 안내](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-computer-use/docs/usage.ko.md#4-작업-실행과-승인)를 따르세요. 런타임은 첫 진입 호출에서 API 문서를 반환하며 모델은 다음 호출 전에 읽어야 합니다.

## 기능 변경과 상태 확인

`/computer-use`는 TUI의 설정 목록 하나를 엽니다. **↑/↓**로 Computer Use·Browser Use를 선택하고 **Enter/Space**로 바꿉니다. 변경은 즉시 저장하고 런타임을 재시작합니다. 선택한 항목과 화면을 유지하며, Esc는 저장한 변경을 되돌리지 않고 닫습니다.

| 명령 | 용도 |
| --- | --- |
| `/computer-use-check` | 요구 사항 보고서와 첫 사용 가이드 |
| `/computer-use status` | 현재 기능, 설정 경로, 런타임 출처와 서버 상태 |
| `/computer-use computer on` / `/computer-use computer off` | Computer Use 변경 |
| `/computer-use browser on` / `/computer-use browser off` | Browser Use 변경 |
| `/computer-use check` | `/computer-use-check`의 호환용 별칭 |

RPC는 기능 두 개와 Close 항목이 있는 반복 선택창을 사용합니다. UI가 없으면 인자 없는 명령은 상태를 출력하며 명시적인 인자도 사용할 수 있습니다. print·JSON 모드의 상태·점검 문구는 stderr로 출력합니다.

### 설정 파일과 재시작

설정 파일은 `<agentDir>/codex-computer-use/settings.json`입니다. `agentDir`은 `PI_CODING_AGENT_DIR`을 따르며 보통 `~/.pi/agent`입니다.

```json
{
  "computerUse": true,
  "browserUse": true
}
```

파일이 없으면 생성하지 않고 기본값을 사용합니다. 기존 파일에는 이 불리언 키 두 개가 정확히 있어야 합니다. 잘못됐거나 읽을 수 없으면 두 기능을 끄며, 토글 명령은 잘못된 파일을 덮어쓰지 않습니다. 파일을 고치고 `/reload`하거나 Pi를 재시작하세요.

기능 변경은 에이전트가 멈출 때까지 기다립니다. 저장된 기능은 선택이며 런타임 재시작 성공의 근거가 아니므로 변경 후 상태를 확인하세요. 재시작하면 두 기능의 REPL 변수·앱·탭 바인딩이 사라집니다. 둘 다 끄면 서버를 시작하지 않고 도구를 숨깁니다. 직접 파일을 편집한 뒤에도 다시 로드하거나 시작해야 합니다.

## 승인과 한계

- 기억된 권한은 런타임이 관리합니다. 제공하는 범위에 따라 **Allow**, **Allow for this session**, **Always allow**, **Cancel**을 보여 주며, 도구 외 요청에는 **Deny**도 있습니다. 앱·출처를 조작할 수 있는 권한이며 읽기 전용 권한이 아닙니다.
- `node_repl`의 일반적인 빈 폼 `js` 실행 승인은 Codex 사용자 검토자의 자동 승인 규칙을 따릅니다. 민감 요청이나 사용자 입력이 필요한 요청에는 적용하지 않습니다. 이 연결은 Guardian 자동 검토를 구현하지 않습니다.
- print·JSON 모드에서는 사용자 상호작용이 필요한 요청을 거부합니다. RPC 클라이언트는 Pi UI 요청에 응답해야 합니다. 지원하는 일반 폼은 Pi 입력·선택·확인 창을 사용하지만, 브라우저 로그인·QR, 이메일 OTP, URL 요청과 지원하지 않는 폼은 거부합니다.
- MCP 취소를 보내도 이미 실행 중인 JavaScript는 완료되거나 런타임 제한 시간에 이를 때까지 계속될 수 있습니다. OS 수준의 즉시 중단을 보장하지 않습니다.
- macOS 앱 번들 폴백의 최초 서비스 실행, Windows 실행, Desktop 종료 상태, 영구 승인, 다운로드·업로드·전체 CDP·WebMCP는 미검증입니다.
- Desktop 업데이트로 비공개 인터페이스가 바뀔 수 있습니다. Codex 밖의 런타임 사용 정보 전송 동작은 확인되지 않았습니다. 적용되는 OpenAI 약관을 확인하세요.

로그는 `<agentDir>/codex-computer-use/mcp.log`에 기록하고 5 MiB에서 순환합니다. 키 기반 가림이 모든 페이지·앱 내용을 제거하지는 않습니다. 공유 전에 확인하고 가리세요.

런타임 부재, 사용 불가 브라우저, 승인 UI 거부나 취소 지연은 [문제 해결 표](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-computer-use/docs/usage.ko.md#문제-해결)를 참고하세요. 탐색 상세, 작업 예시와 검증 기록은 [전체 사용법](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-computer-use/docs/usage.ko.md)에 있으며 압축 파일에도 `docs/usage.ko.md`로 포함합니다.

## 소스 빌드와 로드

[pi-packages](https://github.com/buYoung/pi-packages) 저장소 루트에서 실행합니다.

```sh
pnpm install
pnpm --filter @buyong/pi-codex-computer-use build
pnpm --filter @buyong/pi-codex-computer-use exec pi -ne -e ./dist/index.js
```

`-ne`는 자동 확장 탐색을 끄고 `-e`는 이번 실행에만 확장을 로드합니다. Desktop 준비는 계속 필요합니다. 소스를 바꾼 뒤 다시 빌드하고 Pi를 다시 로드하거나 시작하세요.

## 라이선스

연결 코드는 [Apache-2.0](LICENSE)이며 압축 파일에 `LICENSE`로 포함합니다. 출처 표시는 [NOTICE](NOTICE)에 있습니다. OpenAI 비공개 런타임은 포함하거나 재허가하지 않습니다. [구현·검증 기록](https://github.com/buYoung/pi-packages/blob/main/docs/verification/computer-use)은 과거 점검을 설명하며 패키지를 설치한 새 결과가 아닙니다.
