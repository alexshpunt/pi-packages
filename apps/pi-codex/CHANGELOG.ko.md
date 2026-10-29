# 변경 이력

## [Unreleased]

## [0.6.0] - 2026-10-29

### 새로워진 것

- Computer Use가 켜져 있으면 `/computer-use-check`가 임시 런타임으로 네이티브 서비스에 접속해 앱 목록을 한 번 조회합니다. 앱을 조작하거나 세션의 서버를 건드리지 않습니다.

### 달라진 것

- Auto Review 0.8.0, Computer Use 0.3.0, Memory 0.1.1을 포함합니다.

### 해결된 것

- Auto Review가 다른 MCP 확장과 함께 MCP 서버를 두 번 시작하거나 `/mcp`를 중복 등록하던 문제를 해결했습니다. 서버 연결은 호스트의 MCP 지원이 맡고, Auto Review는 Pi의 `tool_call` 훅에서 호출을 검토합니다.
- Browser Use 작업이 `The browser access host is unavailable`로 더는 실패하지 않습니다. 런타임 승인 대화상자는 그대로 동작합니다.

### 제거된 것

- Auto Review의 내장 MCP 설정을 없앴습니다. `createGuardExtension()`은 이제 MCP 검토를 끄는 `mcp: false`만 받습니다. MCP 연결에는 Pi 내장 지원이나 pi-mcp-adapter 같은 대체 확장이 필요합니다.
- Auto Review가 MCP 승인 요청(`elicitation/create`)에 답하거나 검토한 입력을 전송 단계에서 묶던 기능을 없앴습니다. Auto Review보다 나중에 로드한 확장은 검토 뒤에 MCP 입력을 바꿀 수 있습니다.

## [0.5.0] - 2026-10-28

### 새로워진 것

- `/codex-memory` 관리, 범위별 조회와 선택적으로 켜는 자동 생성을 갖춘 Codex memory v2를 포함합니다(`@buyong/pi-codex-memory` 0.1.0). Pi 1.4.0 이상과 Node.js 22.19 이상이 필요합니다.
- Fast·Ultrafast 지원 여부를 OpenAI Codex 모델 카탈로그로 정하므로, `gpt-6.1-terra` 같은 모델을 확장 업데이트 없이 선택할 수 있습니다(포함된 `@buyong/pi-codex-fast-mode` 0.5.0).

### 달라진 것

- 통합 패키지에 들어 있는 메모리 확장이 Pi 1.4.0 API를 사용하므로, 통합 패키지는 이제 Pi 1.4.0 이상이 필요합니다(기존 1.0.0 이상). 나머지 구성 요소의 호환성 기준은 그대로입니다.

## [0.4.1] - 2026-10-21

### 달라진 것

- README에 설치 후 `pi list`가 표시하는 결과를 적었고, 함께 담긴 구성 요소에도 고친 문서가 들어갑니다.

## [0.4.0] - 2026-10-21

### 새로워진 것

- 자동 검토가 Pi의 Windows `powershell` 도구를 `bash`처럼 보호합니다(포함된 `@buyong/pi-codex-auto-review` 0.7.0).
- `/codex-fast session`으로 저장 설정을 바꾸지 않고 현재 세션의 속도만 덮어쓸 수 있습니다(포함된 `@buyong/pi-codex-fast-mode` 0.4.0).
- `image_gen` 호출이 클릭할 수 있는 저장 경로와 함께 간단한 요약을 보여 주고, 생성된 이미지를 클릭하면 터미널 높이에 맞게 확대됩니다(포함된 `@buyong/pi-codex-image-gen` 0.3.0).

### 달라진 것

- Computer Use가 세션 시작이 아니라 처음 도구를 호출할 때 `cua_repl` 서버를 시작합니다. Computer Use를 쓰지 않는 세션과 하위 에이전트는 서버를 띄워 두지 않습니다(포함된 `@buyong/pi-codex-computer-use` 0.2.0).
- 이미지 생성이 큰 백엔드 응답에 상한을 두고, 비어 있거나 잘못된 이미지 데이터를 오류로 반환하며, 로컬 참조를 읽을 때 취소를 반영합니다.
- JSON에서 끝나지 않은 개인 키 시작 표식이 반복되거나, 의료 행정번호 탐지를 켠 상태에서 공백이 긴 비일치 입력이 와도 자동 검토의 가림이 느려지지 않습니다(포함된 `@buyong/redact` 0.1.4).

### 해결된 것

- 자동 검토가 Windows 경로 형식과 대소문자·유니코드 정규화 차이에도 보호 경로를 계속 거부하고, 일시적인 실패 뒤 검토 요청을 다시 보내며, 실행 중인 다른 Pi 세션이 저장한 규칙과 승인을 유지합니다.
- Computer Use가 크기 제한을 넘는 MCP 응답을 무한히 기다리지 않고 오류로 끝내며, 예기치 않은 서버 종료와 시작 실패를 표시합니다.
- 여러 Pi 세션이 설정을 동시에 저장해도 Fast 모드가 다른 모델의 변경을 잃지 않습니다.

## [0.3.3] - 2026-10-20

### 달라진 것

- 자동 검토의 보호 CLI와 SDK가 Pi 1.0.0 이상에서 시작합니다(포함된 `@buyong/pi-codex-auto-review` 0.6.0). 1.0.0·1.1.0이 아닌 Pi 버전도 더는 `UNSUPPORTED_PI`로 실패하지 않으며, 1.0.0 미만은 계속 거부합니다.
- 소스 코드, 이슈, 릴리스 노트를 [pi-packages](https://github.com/buYoung/pi-packages) 저장소로 옮겼습니다.
