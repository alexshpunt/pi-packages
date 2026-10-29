# @buyong/pi-codex-computer-use

[English](README.md) | **한국어**

Codex Desktop이 설치한 런타임으로 Pi에서 네이티브 앱·Chrome을 조작합니다. 확장은 통합 `cua_repl` MCP 서버를 시작하고 텍스트·이미지를 전달하며 런타임 승인 창을 Pi에서 보여 줍니다.

Desktop 런타임이 있는 기기에서 사용하세요. 런타임 자체를 제공하지는 않습니다. **Computer Use·Browser Use는 기본으로 둘 다 켜지고** 각각 바꿀 수 있습니다. 이 확장은 그 런타임과 Pi를 잇는 브리지이며 자동화 엔진이나 OS 샌드박스가 아닙니다. OpenAI 런타임을 포함·다운로드·복사·재배포하지 않습니다.

## 요구 사항

| 항목 | 필요한 조건 |
| --- | --- |
| Node.js | 22.19 이상 |
| Pi | 1.0.0 이상. 기록된 실검증은 0.99.1에서 했고, 1.0.2에는 상태 확인 기록만 있습니다. 매니페스트의 더 넓은 peer 범위에 속한 이전 버전은 미검증입니다. |
| Codex Desktop | 설치하고 Codex 접근이 가능한 계정으로 로그인한 뒤, Computer Use 플러그인을 한 번 이상 켜서 런타임 설정을 만든 상태. 패키지는 구독 이용 가능 여부나 로그인을 확인하지 못합니다. |
| Computer Use | Desktop의 네이티브 서비스. macOS에서는 `Codex Computer Use.app`에 손쉬운 사용·화면 기록 권한을 허용합니다. |
| Browser Use | 실행 중인 Google Chrome, 활성화한 ChatGPT Chrome 확장, 네이티브 메시징 호스트가 등록된 Desktop의 Chrome/Browser 플러그인 |

기록된 실검증은 macOS `ChatGPT.app`(번들 ID `com.openai.codex`) `26.930.31730`을 사용했습니다. Windows 탐색·점검은 구현했지만 **Windows 실기기에서 검증하지 않았습니다.** Linux와 다른 플랫폼은 지원하지 않습니다. Desktop을 실행해 두세요. Desktop을 종료한 상태에서의 동작은 미검증입니다.

**활성 브라우저 백엔드는 Chrome뿐입니다.** Desktop 런타임 문서의 `iab`·`mcpapps`·Edge 예시는 Pi에서 해당 백엔드를 사용할 수 있다는 뜻이 아닙니다.

## 설치와 연결 확인

`@buyong/pi-codex`를 이미 쓴다면 이 확장이 포함되어 있으므로 따로 설치하거나 활성화하지 마세요. 그렇지 않다면 게시된 릴리스를 설치합니다(버전을 고정하려면 `@<version>`을 붙입니다).

```sh
pi install npm:@buyong/pi-codex-computer-use
pi list
pi
```

`pi list`는 `User packages:` 아래에 `npm:@buyong/pi-codex-computer-use`와 설치 경로를 표시합니다.

게시하지 않은 변경을 실행하려면 [소스에서 빌드해 로드](#소스-빌드와-로드)하세요.

Pi에서:

1. `/computer-use-check`에서 사용할 기능(Computer Use, Browser Use 또는 둘 다)의 누락된 요구 사항을 해결합니다. `user-owned` 항목(계정·로그인·OS 권한)은 직접 확인해야 하고, `unverified`는 통과가 아닙니다. 점검은 Desktop에 설치된 검증 스크립트를 실행할 수 있고, Computer Use가 켜져 있으면 임시 런타임 연결로 앱 목록을 한 번 조회합니다. 아무것도 설치하지 않으며 앱이나 브라우저도 조작하지 않습니다.
2. `/computer-use`에서 필요한 기능만 켜 둡니다. **↑/↓**로 기능을 고르고 **Enter/Space**로 바꾸며 **Esc**로 닫습니다. 어느 기능을 바꿔도 에이전트가 멈춘 뒤 공용 런타임을 재시작하며, 이때 REPL 변수와 앱·탭 바인딩이 사라집니다.
3. `/computer-use status`에서 서버 실행을 확인합니다. 실행 중이 아니라면 모델에 조작을 요청하기 전에 표시된 런타임·설정 문제를 해결합니다.
4. 탭을 열거나 앱을 조작하지 않고 목록만 확인하도록 요청합니다.

```text
Use mcp__cua_repl__js to run await cua.getState(). Summarize the available apps and browsers without operating them.
```

예상되는 첫 결과는 `mcp__cua_repl__js`가 반환한 활성 기능의 목록입니다. 연결되면 `mcp__cua_repl__js_reset`도 제공합니다. MCP 서버가 실행 중이거나 사전 검사를 통과해도 모든 앱·브라우저 작업의 성공을 보장하지는 않습니다.

한 번 연결한 뒤의 세션은 저장해 둔 도구 목록으로 도구를 등록하고, 처음 도구를 호출할 때 서버를 시작합니다. 그 전까지 하단에는 `ready`를 표시합니다. 시작에 실패하거나 서버가 예기치 않게 종료되면 하단에 오류를 표시하고 재시작할 때까지 도구를 숨깁니다.

이후 브라우저 작업은 [Chrome 작업·승인 안내](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-computer-use/docs/usage.ko.md#4-작업-실행과-승인)를 따르세요. 런타임은 첫 진입 호출에서 API 문서를 반환하며 모델은 다음 호출 전에 읽어야 합니다.

## 기능 변경과 상태 확인

`/computer-use`는 TUI의 설정 목록 하나를 엽니다. **↑/↓**로 Computer Use·Browser Use를 선택하고 **Enter/Space**로 바꿉니다. Esc는 저장한 변경을 되돌리지 않고 닫습니다.

| 명령 | 용도 |
| --- | --- |
| `/computer-use-check` | 요구 사항 보고서와 첫 사용 가이드 |
| `/computer-use status` | 현재 스위치 상태, 설정 경로, 런타임 출처와 서버 상태 |
| `/computer-use computer on` / `/computer-use computer off` | Computer Use 변경 |
| `/computer-use browser on` / `/computer-use browser off` | Browser Use 변경 |
| `/computer-use check` | `/computer-use-check`의 호환용 별칭 |

변경은 바로 `<agentDir>/codex-computer-use/settings.json`에 저장합니다(`agentDir`은 `PI_CODING_AGENT_DIR`이 설정되어 있으면 그 값, 아니면 `~/.pi/agent`). 에이전트가 멈출 때까지 기다린 뒤 공용 런타임을 재시작하며, 이때 **두 기능의 REPL 변수·앱·탭 바인딩이 모두 사라집니다**. 스위치를 저장했다고 재시작에 성공한 것은 아니므로 변경 후 `/computer-use status`를 실행하세요. 둘 다 끄면 서버를 시작하지 않고 런타임 도구를 숨깁니다.

파일 형식, 잘못된 파일의 처리, RPC·print·JSON 모드의 동작은 [사용법의 기능 선택 절](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-computer-use/docs/usage.ko.md#3-필요한-기능만-선택)에 있습니다.

## 승인하거나 작업을 실행하기 전에

- 승인하면 런타임이 앱이나 웹사이트 출처(origin)를 읽기만 하는 것이 아니라 조작할 수 있습니다. Pi는 런타임이 제공하는 범위에서 **Allow**, **Allow for this session**, **Always allow**, **Cancel**을 보여 주며, 기억된 권한은 런타임이 저장합니다. 폼이 비어 있고 민감하지 않으며 사용자 입력이 필요 없는 `node_repl`의 일반 `js` 실행 요청은 자동으로 승인합니다. 브라우저 로그인·QR, 이메일 OTP, URL 요청과 지원하지 않는 폼은 거부합니다. 기준은 [승인이 허용하는 작업](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-computer-use/docs/usage.ko.md#승인이-허용하는-작업)에 있습니다.
- print·JSON 모드에서는 사용자 상호작용이 필요한 요청을 거부합니다. RPC 클라이언트는 Pi UI 요청에 응답해야 합니다.
- 취소해도 이미 실행 중인 JavaScript는 멈추지 않고, 완료되거나 런타임 제한 시간에 이를 때까지 계속됩니다.
- 런타임 출력 한도(런타임이 알려 주지 않으면 100,000바이트, 약 25,000토큰)를 넘는 결과는 중간을 생략합니다. 저장에 성공하면 전체 텍스트가 담긴 시스템 임시 디렉터리의 사용자 전용 파일 경로를 결과에 표시하며, 브리지는 이 파일을 삭제하지 않습니다. `<agentDir>/codex-computer-use/`의 로그에는 페이지·앱 내용이 남을 수 있으니 공유하기 전에 확인하세요. 한도와 경로는 [턴 종료와 긴 출력](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-computer-use/docs/usage.ko.md#턴-종료와-긴-출력), [로그와 저장한 도구 목록](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-computer-use/docs/usage.ko.md#로그와-저장한-도구-목록)에 있습니다.
- macOS 앱 번들 폴백의 최초 서비스 실행, Windows 실행, Desktop 종료 상태, 영구 승인, 다운로드·업로드·전체 CDP·WebMCP는 미검증입니다.
- Desktop 업데이트로 비공개 인터페이스가 바뀔 수 있습니다. Codex 밖의 런타임 사용 정보 전송 동작은 확인되지 않았습니다. 적용되는 OpenAI 약관을 확인하세요.

런타임 부재, 사용 불가 브라우저, 승인 UI 거부나 취소 지연은 [문제 해결 표](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-computer-use/docs/usage.ko.md#문제-해결)를 참고하세요. 탐색 상세, 작업 예시와 검증 기록은 [전체 사용법](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-computer-use/docs/usage.ko.md)에 있으며 압축 파일에도 `docs/usage.ko.md`로 포함합니다.

## 소스 빌드와 로드

[pi-packages](https://github.com/buYoung/pi-packages) 저장소 루트에서 실행합니다. typecheck·lint·build 단계는 Codex Desktop 없이 실행할 수 있지만, 확장을 실행하는 마지막 명령에는 [요구 사항](#요구-사항)의 Desktop 준비가 필요합니다.

```sh
pnpm install
pnpm --filter @buyong/pi-codex-computer-use typecheck
pnpm --filter @buyong/pi-codex-computer-use lint
pnpm --filter @buyong/pi-codex-computer-use build
pnpm --filter @buyong/pi-codex-computer-use exec pi -ne -e ./dist/index.js
```

`-ne`는 자동 확장 탐색을 끄고 `-e`는 이번 실행에만 확장을 로드합니다. typecheck·lint·build 단계는 정상 종료해야 합니다. 소스를 바꾼 뒤 다시 빌드하고 Pi를 다시 로드하거나 시작한 다음 `/computer-use status`를 다시 실행하세요. 서버 실행이나 명시적인 런타임 오류가 표시되어야 하며, 도구가 숨겨졌는데 하단이 `running`으로 남아서는 안 됩니다.

패키지 릴리스는 [저장소 배포 절차](https://github.com/buYoung/pi-packages/blob/main/README.ko.md#공통-ci와-패키지별-배포)를 따릅니다.

## 라이선스

브리지 코드는 [Apache-2.0](LICENSE)이며 압축 파일에 `LICENSE`로 포함합니다. 출처 표시는 [NOTICE](NOTICE)에 있습니다. OpenAI 비공개 런타임은 포함하거나 재허가하지 않습니다. [구현·검증 기록](https://github.com/buYoung/pi-packages/blob/main/docs/verification/computer-use)은 과거 점검을 설명하며 패키지를 설치한 새 결과가 아닙니다.
