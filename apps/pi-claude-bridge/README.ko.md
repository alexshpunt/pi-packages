# pi-claude-bridge

[English](README.md) | **한국어**

[![npm version](https://img.shields.io/npm/v/@buyong/pi-claude-bridge)](https://www.npmjs.com/package/@buyong/pi-claude-bridge)

Claude Code와 [Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)를 통해 Pi에서 Claude 모델을 쓰게 하는 공급자 전용 확장입니다. 도구 호출은 Pi의 도구로 실행되며, 이 확장은 도구나 명령을 따로 등록하지 않습니다.

`@buyong/pi-claude-bridge`는 [pi-packages 모노레포](https://github.com/buYoung/pi-packages/tree/main/apps/pi-claude-bridge)에서 유지보수하며, npm 설치 명령과 패키지 이름은 그대로입니다. [elidickinson/pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge)에서 가져왔고, 그 원본은 Prateek Sunal의 [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi)를 바탕으로 합니다. 이 배포판의 문제는 [pi-packages 이슈](https://github.com/buYoung/pi-packages/issues)에 등록해 주세요.

**요금:** 현재 요청은 Claude Code와 마찬가지로 일반 Claude 구독 사용량에서 차감됩니다. Anthropic은 이 확장처럼 Agent SDK로 만든 도구의 과금 방식을 바꾼다고 [발표했다가 철회](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)했습니다.

<p>
<a href="https://github.com/buYoung/pi-packages/blob/main/apps/pi-claude-bridge/assets/claude-bridge1.png"><img src="https://raw.githubusercontent.com/buYoung/pi-packages/main/apps/pi-claude-bridge/assets/claude-bridge1.png" width="49%"></a>&nbsp;
<a href="https://github.com/buYoung/pi-packages/blob/main/apps/pi-claude-bridge/assets/claude-bridge2.png"><img src="https://raw.githubusercontent.com/buYoung/pi-packages/main/apps/pi-claude-bridge/assets/claude-bridge2.png" width="49%"></a>
</p>

## 설치

Pi 1.0.0 이상과 Node.js 22.19.0 이상이 필요합니다. 패키지 로딩과 타입 검사는 Pi 1.2.0과 1.3.0에서 마지막으로 확인했습니다.

```
pi install npm:@buyong/pi-claude-bridge
```

### 처음 쓰기 전에

- Claude 구독 계정으로 Claude Code에 로그인합니다. 예를 들어 `claude`를 한 번 실행해 로그인을 마칩니다. 브리지에는 자체 자격 증명이 없습니다. 요청은 Claude Code의 로그인으로 Anthropic에 전달되고 구독 사용량에서 차감됩니다.
- Agent SDK는 플랫폼별 Claude Code 실행 파일을 의존성으로 설치합니다. 그 파일이 시스템에서 실행되지 않으면 `provider.pathToClaudeCodeExecutable`을 설정합니다([설정](#설정) 참고).
- Pi 프로세스에 `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`을 export하지 마세요. Claude Code의 요청 대상이 바뀝니다([알려진 문제](#알려진-문제) 참고).

### 첫 요청

1. `pi`를 시작하고 `/model`에서 `claude-bridge` 모델을 선택합니다. 예: `claude-bridge/claude-haiku-4-5`.
2. `Reply with OK only.`처럼 짧은 프롬프트를 보냅니다. Claude가 답하면 Claude Code 로그인과 브리지가 동작하는 것입니다. 이 요청은 Claude 구독 사용량에서 차감됩니다.

`claude-bridge` 모델이 보이지 않거나 요청이 실패하면 Claude Code 로그인과 위의 환경 변수를 확인한 뒤 [디버깅](#디버깅)을 참고하세요.

### 업데이트와 제거

| 작업 | 명령 | 실행 전에 알아 둘 점 |
| --- | --- | --- |
| 최신 릴리스로 업데이트 | `pi update npm:@buyong/pi-claude-bridge` | 정확한 버전으로 고정한 설치는 `Updated`를 출력해도 그대로입니다. 프로젝트 설치는 저장된 신뢰 결정이 있거나 `-a`를 붙였을 때만 업데이트합니다. |
| 특정 버전으로 고정하거나 고정 버전 변경 | `pi install npm:@buyong/pi-claude-bridge@<version>` | `<version>`을 게시된 버전으로 바꿉니다. |
| 현재 프로젝트에만 설치 | `pi install -l npm:@buyong/pi-claude-bridge` | 신뢰한 프로젝트 안에서 실행합니다. |
| 제거 | `pi remove npm:@buyong/pi-claude-bridge` | 프로젝트 설치를 제거하려면 `-l`을 붙입니다. |

### 브리지가 만드는 파일

- Pi의 agent 디렉터리(`PI_CODING_AGENT_DIR`, 기본 `~/.pi/agent`)의 `claude-bridge.json`에 설정이 들어갑니다. 브리지는 첫 실행 안내를 보여 준 뒤 `startupNoticeShown`을, Claude Code 로그인에서 요금제를 읽은 뒤 `detectedPlan`을 이 파일의 최상위 키로 추가합니다. 프로젝트 파일이 있어도 이 두 키는 전역 파일에 씁니다.
- `~/.claude/projects/`(또는 `$CLAUDE_CONFIG_DIR/projects/`) 아래의 Claude Code 세션 파일에는 Claude Code가 이어서 쓸 대화가 들어 있습니다. 브리지는 대화를 다시 구성할 때 이 파일을 다시 쓰고 자신이 만든 임시 세션은 지우지만, 이전 세션은 정리하지 않습니다.
- Pi 세션의 `claude-bridge-cc-session` 항목은 Pi 브랜치와 Claude Code 세션을 연결합니다. 모델 문맥에는 들어가지 않습니다.
- 디버그 로그와 요청별 Claude Code CLI 로그는 `CLAUDE_BRIDGE_DEBUG=1`일 때만 기록합니다. 예상하지 못한 공급자 상태나 프롬프트 캡처 실패가 생기면, 디버그가 꺼져 있어도 `claude-bridge-diag.log`에 진단 기록을 남깁니다. 경로와 직접 정리 방법은 [디버깅](#디버깅)을 참고하세요.

## 모델 선택과 사용

`/model`에서 pi-ai 카탈로그의 Claude 모델을 선택합니다. 예: `claude-bridge/claude-fable-5-1`, `claude-bridge/claude-opus-5`, `claude-bridge/claude-haiku-4-5`.

Pi의 도구는 Claude Code에 연결되며, Pi에서는 평소처럼 사용합니다. 브리지는 `bash` 인자를 그대로 전달하고 기본 제한 시간을 더하지 않습니다. 실행 시간 제한은 Pi의 도구가 정합니다. 스킬과 선택된 도구의 지침은 Claude Code의 시스템 프롬프트로 전달되며, 턴 도중에 보낸 조정 메시지는 다음 도구 호출 경계에서 Claude에 도착합니다.

**추론 옵션:** 추론을 켜면(`/thinking`으로 수준을 고르거나 Shift+Tab으로 순환) 브리지는 4.6 세대 이후 Claude 모델에 adaptive thinking과 요약 표시(summarized display)를 요청합니다. Claude 4.5 모델은 Claude Code의 기본 처리와 effort 대응을 그대로 따릅니다. 카탈로그가 추론 끄기를 허용하지 않는 모델(예: Sonnet 5.5)에는 추론 끄기 요청을 보내지 않습니다. Haiku 5.5는 추론을 끌 수 없는 모델로 등록합니다. Pi 1.3.0 카탈로그는 끄기를 허용하지만 Claude Code가 추론을 계속하기 때문입니다.

**시스템 프롬프트 갱신:** 새 쿼리를 시작하거나 세션을 이어 쓸 때마다 Pi에서 캡처한 현재 프로젝트 문맥·스킬·지침을 전달합니다(공급자는 `snapshot: false`를 씁니다). 이미 실행 중인 쿼리의 MCP 도구는 실시간으로 갱신하지 않습니다.

모델 목록은 pi-ai의 Anthropic 카탈로그에서 가져옵니다. pi-ai에 새 Claude 모델이 추가되면 pi-ai를 제공하는 Pi를 업데이트한 뒤 `/model`에 나타나며, 브리지를 따로 업데이트할 필요는 없습니다. 날짜가 붙은 스냅샷 ID(예: `claude-opus-4-5-20251101`)는 표시하지 않습니다.

**1M 컨텍스트:** Fable 5/5.1, Opus 5.5/5/4.8/4.7, Sonnet 5.5/5, Haiku 5.5는 1M 컨텍스트를 씁니다. Opus 4.6은 Max 요금제이거나 Extra Usage를 쓸 때만, Sonnet 4.6은 Extra Usage를 쓸 때만 1M을 씁니다. 브리지는 첫 요청 때 Claude Code 로그인에서 Max 요금제인지 판별합니다. 판별할 수 없거나 판별 결과를 바꾸려면 [설정](#설정)에 따라 `provider.plan`이나 `provider.longContextExtraUsage`를 지정하세요.

### 압축과 브랜치 요약

압축과 브랜치 요약은 Pi나 사용자가 설치한 요약 확장이 시작합니다. `claude-bridge` 모델이 요약을 맡으면 브리지는 그 모델 요청만 처리하며, 요약 작업을 대신하거나 실패한 요약을 취소하지는 않습니다. Pi는 압축과 브랜치 요약 같은 자체 요약 요청을 `cacheRetention: "none"`으로 보냅니다. 이 표식이 있는 요청만 요청한 Pi 세션의 작업 디렉터리에서 별도 Claude Code 프로세스로 실행하고, 결과에 Claude Code가 보고한 토큰 사용량을 담습니다. 이미 취소된 요청은 프로세스를 시작하지 않으며, 실행 중 취소는 오류가 아니라 취소로 반환합니다. 요약으로 기록이 바뀌면 브리지는 다른 기록 변경 때와 마찬가지로 Claude Code 세션을 다시 구성합니다.

## 설정

설정 파일은 `~/.pi/agent/claude-bridge.json`(전역)이나 프로젝트의 Pi 설정 디렉터리, 보통 `.pi/claude-bridge.json`(프로젝트, 전역 위에 병합)입니다.

각 파일에는 JSON 객체가 있어야 합니다. 잘못된 JSON이나 객체가 아닌 최상위 값(`null`, 배열, 기본 값)은 공급자를 막지 않고 무시합니다. 이 경우 브리지는 시작 안내나 판별한 요금제를 기록하려고 파일을 덮어쓰지 않습니다. 파일을 고치면 다시 기록합니다.

```json
{
  "provider": {
    "plan": "max",
    "longContextExtraUsage": false,
    "pathToClaudeCodeExecutable": "/home/you/.nix-profile/bin/claude"
  }
}
```

`provider`:
- `plan`: `"pro"` 또는 `"max"`. `"max"`이면 Opus 4.6에 1M 컨텍스트를 씁니다. 지정하지 않으면 브리지가 첫 요청 중에 Claude Code 로그인에서 요금제를 읽어(모델 요청을 더하지 않음) 현재 세션에 적용하고, 이후 세션을 위해 `detectedPlan`으로 기록합니다. Max와 Enterprise는 `"max"`, Pro는 `"pro"`로 봅니다. Team 요금제는 구분할 수 없으므로 Team Premium 사용자는 여기에 `"max"`를 지정합니다. 요금제를 판별하기 전에는 `"pro"`를 적용합니다. 여기에 지정한 값이 항상 우선합니다.
- `longContextExtraUsage`: `true`로 지정하면 요금제에서 Extra Usage로 비용이 들더라도 1M 컨텍스트 모델을 씁니다. 모든 요금제에서 Sonnet 4.6의 1M을, Pro에서 Opus 4.6의 1M을 켭니다. Opus 4.7과 4.8에는 필요하지 않습니다.
- `forceTwoHundredK`: 200K 컨텍스트로 고정할 모델 ID 배열입니다. `claude-bridge/` 접두사와 `[1m]` 접미사를 뺀 ID를 씁니다(예: `["claude-opus-4-6"]`, 기본값 없음). pi-ai가 1M으로 선언한 모델을 요금제에서 Claude Code가 1M으로 제공하지 않을 때 씁니다.
- `autoMemoryEnabled`: Claude Code의 자동 메모리 기능을 켭니다(기본값 `false`).
- `pathToClaudeCodeExecutable`: `claude` 실행 파일 경로입니다. SDK에 포함된 musl·glibc 실행 파일을 시스템에서 실행할 수 없을 때 씁니다. 예를 들어 Nix에서는 `"/home/you/.nix-profile/bin/claude"`로 지정합니다.

**확장 공급자와 `models.json`:** `~/.pi/agent/models.json`의 Pi `modelOverrides`는 claude-bridge처럼 확장이 등록한 공급자에는 적용되지 않습니다. 모델을 200K로 고정하려면 `provider.forceTwoHundredK`를 쓰세요. `contextWindow`와 다른 모델 필드는 설정으로 바꿀 수 없습니다.

### Claude Code 설정과 환경

다음 동작은 고정되어 있으며 설정 키로 바꿀 수 없습니다.

- **MCP 서버:** 브리지는 Claude Code가 사용자·프로젝트·플러그인 설정이나 claude.ai에서 MCP 서버를 직접 불러오는 것을 항상 막습니다. Pi의 도구와 Pi MCP 도구는 브리지의 `custom-tools` 서버를 통해 계속 쓸 수 있습니다.
- **도구 `_meta`:** `custom-tools` 서버의 모든 도구는 `anthropic/maxResultSizeChars: 500000`을 선언합니다. 그래서 Claude Code는 결과를 500,000자까지 Claude에 그대로 전달합니다. Pi MCP 도구는 서버가 선언한 `_meta`도 바꾸지 않고 그대로 갖습니다. 서버가 `anthropic/maxResultSizeChars`를 선언하면 500000 대신 서버의 값을 씁니다. 브리지는 이 `_meta`를 `pi.getAllTools()`의 `meta`와, `pi.events`의 `tool-meta` 요청에 답하는 확장(예: `@buyong/pi-mcp-adapter`)에서 읽습니다. 1.4.0처럼 `pi.getAllTools()`에 `meta`가 없는 Pi 버전에서는 그런 확장이 있어야 합니다.
- **권한:** 공급자는 Claude Code를 `dontAsk` 권한 모드로 실행하고 브리지의 MCP 서버만 미리 허용합니다. 브리지는 전체 권한 우회 모드를 요청하지 않으며, 그 모드에 필요한 `IS_SANDBOX` 값도 넣지 않습니다. 도구 호출과 작업 디렉터리 밖 `@file` 확장은 macOS에서 확인했고, 컨테이너에서 uid 0으로 실행하는 경우는 검증하지 않았습니다.
- **환경 변수:** 브리지는 부모 Claude Code의 세션 표식을 자식 환경에서 지우고 SDK 진입점을 씁니다. 비필수 트래픽을 막는 변수는 Claude Code 자식 프로세스에만 설정하므로 Pi의 `bash` 도구와 다른 확장의 환경은 바뀌지 않습니다. 인증·서버 연결 변수는 그대로 전달하며, 그래서 export한 Anthropic 변수가 자식 프로세스의 동작을 바꿉니다([알려진 문제](#알려진-문제) 참고).
- **Claude Code 설정:** 요약 쿼리도 공급자 쿼리처럼 Claude Code의 기본 설정 소스를 읽으므로, Claude Code 사용자 설정의 `env`와 설정한 `apiKeyHelper`가 적용됩니다. Claude Code의 지침 파일은 제외하고, Claude는 Pi가 보낸 문맥을 받습니다.
- **요금제 안내:** `provider.plan`이 없고 Claude Code 로그인으로 요금제를 판별하지 못했을 때(예: Team)만 다음 브리지 요청에서 TUI에 안내를 표시합니다. 기록된 `startupNoticeShown`으로 같은 안내를 반복하지 않습니다.

## 다른 확장과의 호환성

### 어떤 주입 경로가 Claude Code에 전달되는가

브리지는 Pi의 구조화된 구성 요소(프로젝트 문맥 파일, 스킬, 사용자 지정 프롬프트, 덧붙인 지침, `systemPromptOptions.sections`의 사용자 지정 프롬프트 절, 명시적인 프롬프트·도구 지침)를 전달하고, Pi가 생성한 하네스 문구는 뺍니다.

| 경로 | Claude Code 전달 여부 |
|---|---|
| `before_agent_start` -> `message` | 예. 사용자 턴의 프롬프트 문구 그대로 |
| `context`로 마지막 사용자 메시지 편집 | 예. 프롬프트 문구 그대로 |
| `--append-system-prompt` | 예. Pi의 덧붙인 지침과 함께 |
| `context_with_system`으로 시스템 메시지 편집 | Pi의 프롬프트를 감싸면 예. Pi의 프롬프트를 대체하면 턴이 실패합니다. |
| `before_agent_start` -> `systemPromptOptions.sections` | 예. 절마다 `<name>` 블록 하나 |
| `systemPromptOptions.promptGuidelines` | 예. 추가 지침으로 |
| 도구의 `promptSnippet`과 `promptGuidelines` | 예. 그 턴에서 활성화된 선택된 도구만 |
| `before_agent_start` -> `systemPrompt` | 아니요. 버립니다. |

도구 지침은 도구가 어디서 등록됐는지가 아니라 Pi가 선언한 도구 선택을 따릅니다. SDK `customTools`, 확장 도구, 선택된 내장 도구 모두 명시적인 지침을 보낼 수 있습니다. 브리지는 지침을 복사하고, 반복된 규칙을 하나로 합치고, [시스템 프롬프트 거부](#시스템-프롬프트-거부)의 검사를 적용합니다. 이 기능이 MCP 도구를 실시간으로 갱신하지는 않으며, 프롬프트 변경은 다음 공급자 쿼리가 시작될 때 적용됩니다.

함정 두 가지를 주의하세요. 첫째, `before_agent_start`에서 `systemPrompt`를 반환하면 Pi가 시스템 프롬프트 전체를 대체하므로 같은 실행의 `context_with_system` 편집은 사라집니다. 둘 중 하나만 요청에 들어갑니다. 둘째, 시스템 프롬프트 편집은 Pi의 프롬프트를 *감싸는* 방식이어야 합니다. 확장이 Pi의 프롬프트를 대체하면 브리지가 맞춰 볼 대상이 없으므로, 문맥 파일·스킬·사용자 지정 지침이 빠진 요청을 보내는 대신 턴을 거부합니다. 오류에는 가장 가까운 알려진 프롬프트와 달라진 위치가 나옵니다.

지침을 추가하려면 `message`, `context`, 또는 Pi의 프롬프트를 그대로 두는 시스템 메시지 편집을 쓰세요.

### Claude Code용으로 작성한 hook

공급자와 요약 쿼리는 `disableAllHooks: true`로 실행되어 사용자·프로젝트·플러그인의 Claude Code hook과 `statusLine` 명령을 끕니다. 이를 다시 켜는 브리지 설정은 없습니다. Pi 확장의 이벤트 처리는 바뀌지 않습니다.

이 설정은 Claude Code의 관리 정책을 우회하지 않습니다. SDK 정책에 따라 관리자가 강제한 hook은 여전히 실행될 수 있습니다. Claude Code에 내장된 기능은 hook과 별개입니다.

### 시스템 프롬프트 거부

다른 확장이 시스템 프롬프트를 바꿀 수 있습니다. 브리지가 Claude Code로 보낼 텍스트에 Pi 기본 시스템 프롬프트의 첫 문장이나, Anthropic이 찾는 두 문서 경로(같은 프롬프트에 함께 있는 `docs/custom-provider.md`와 `docs/packages.md`)가 남아 있으면, 브리지는 요청을 보내지 않고 턴을 멈춥니다. 그대로 보내면 Anthropic이 이 요청을 Extra Usage로 청구할 수 있기 때문입니다. 원인이 된 확장을 고친 뒤 다시 시도하세요. `CLAUDE_BRIDGE_DEBUG=1`이면 이때 전체 프롬프트를 브리지 로그에 기록합니다.

### @gotgenes/pi-subagents와 함께 쓰기

`~/.pi/agent/subagents.json`에 다음을 추가합니다.

```json
{"promptInheritance": {"claude-bridge": "portable"}}
```

## 디버깅

`CLAUDE_BRIDGE_DEBUG=1`을 설정하면 디버그 출력을 켭니다.

- **브리지 로그**: Pi의 agent 디렉터리(`PI_CODING_AGENT_DIR`, 기본 `~/.pi/agent`)의 `claude-bridge.log`. 공급자 호출, 세션 동기화 판단, 도구 결과, Claude Code stderr를 기록합니다. 위치는 `CLAUDE_BRIDGE_DEBUG_PATH`로 바꿉니다.
- **요청별 Claude Code CLI 로그**: 브리지 로그 옆의 `cc-cli-logs/<timestamp>-<tag>-<seq>.log`. 하위 프로세스 자체의 디버그 출력이며 tag는 `provider` 또는 `compact-summary`입니다. Claude Code가 본 세션 로딩, API 요청, 도구 호출을 보여 줍니다. `CLAUDE_BRIDGE_DEBUG_PATH`를 바꾸면 이 디렉터리도 옮긴 브리지 로그 옆으로 이동합니다.
- **진단 기록**: Pi의 agent 디렉터리의 `claude-bridge-diag.log`. 예상하지 못한 공급자 상태와 프롬프트 캡처 실패를 기록합니다. 디버그가 꺼져 있어도 기록될 수 있으며, `CLAUDE_BRIDGE_DEBUG_PATH`로 옮겨지지 않습니다.

진단 기록은 가능한 범위에서만 씁니다. 쓰기에 실패하면 공급자를 멈추거나 TUI 위에 출력하지 않고 무시합니다. 도구 결과의 디버그 미리보기는 디버그를 켰을 때만 만듭니다.

세션 이어 쓰기 실패(예: "No conversation found")를 보고할 때는 브리지 로그의 `syncResult:` 줄과, 실패한 요청의 `cc-cli-logs/` 파일을 함께 첨부하세요. 로그에는 프롬프트와 도구 출력이 들어 있을 수 있으므로 공유하기 전에 확인하세요.

### 로그 직접 정리

로그는 자동으로 순환하거나 삭제되지 않습니다. 로그를 쓰는 Pi와 Claude Code 프로세스를 멈추고 필요한 진단을 저장한 뒤 로그 파일만 지웁니다. 예시는 Pi와 같은 `HOME`과 경로 재정의가 있는 셸에서 실행하며, Pi처럼 `PI_CODING_AGENT_DIR`의 `~`와 `~/...`를 확장합니다.

```bash
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
case "$agent_dir" in
  '~') agent_dir="$HOME" ;;
  '~/'*) agent_dir="$HOME/${agent_dir#\~/}" ;;
esac
bridge_log="${CLAUDE_BRIDGE_DEBUG_PATH:-$agent_dir/claude-bridge.log}"
cli_log_dir="$(dirname "$bridge_log")/cc-cli-logs"
rm -f -- "$bridge_log" "$agent_dir/claude-bridge-diag.log"
if [ -d "$cli_log_dir" ]; then
  find "$cli_log_dir" -maxdepth 1 -type f -name '*.log' -delete
fi
```

로그를 정리하면서 `~/.claude/projects/`(또는 `$CLAUDE_CONFIG_DIR/projects/`)나 그 안의 `tool-results/` 디렉터리를 지우지 마세요. 브리지가 대화를 다시 구성할 때 이전 세션의 데이터를 쓸 수 있습니다.

## 알려진 문제

**대화를 다시 구성한 뒤에는 프롬프트 캐시를 항상 전부 재사용하지는 못합니다.** 브리지는 문맥 첨부, 도구 결과의 실제 형태와 키 순서, 이미지·큰 결과의 저장 파일을 보존해 전체를 다시 캐시하는 일을 줄입니다. Pi가 도구 결과를 고쳤다면 고친 내용을 따릅니다. 그래도 Claude Code 2.1.303과 Haiku 5.5에서는 다시 구성하지 않은 일반적인 이어 쓰기에서도, 세션의 두 번째 요청이 첫 요청 끝에 붙는 환경 `system` 메시지(약 350토큰)를 캐시에서 읽지 못하고 다시 기록합니다. 이후 턴마다 끝에 붙는 작은 `system` 메시지도 약 25토큰씩 다시 기록됩니다. 프로세스를 재시작한 뒤나 Pi에만 있는 중간 대화 뒤에 다시 구성할 때도 같은 양이며, 브리지 때문에 더해지는 손실은 측정하지 않았습니다. 이 메시지의 위치와 캐시 방식은 Claude Code가 정하므로 브리지가 없앨 수 없고, 내용의 형태(블록 배열·문자열)를 맞춰도 달라지지 않습니다. 압축·트리 이동처럼 기록이 실제로 바뀌거나 캐시가 만료된 경우에도 전부 재사용하지 못합니다.

**재시작하면 이전 Claude Code 세션을 그대로 이어 쓰지 않습니다.** 브리지는 현재 Pi 브랜치에 모델 문맥에서 제외되는 `claude-bridge-cc-session` 연결 항목을 남깁니다. 다시 열 때는 이전 Claude Code 세션을 내용을 읽는 자료로만 쓰고 새 Claude Code 세션 UUID를 만듭니다. 연결 항목·파일·쓰기 핸들이 없으면 Pi 기록만으로 다시 씁니다. 이전 세션과 결과 파일은 자동으로 정리하지 않습니다.

**Claude Code가 편집한 파일은 대화를 다시 구성할 때 따라오지 않습니다.** 편집 자체는 도구 호출과 결과로 기록에 남지만, 편집 후 파일 스냅샷은 사라집니다. `@file` 확장은 *따라옵니다*.

**export한 Anthropic 환경 변수가 Claude Code 자식 프로세스의 설정을 바꿉니다(이슈 #107).** `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`을 export하면 Claude Code가 그 게이트웨이로 요청하고, 모든 턴이 그 게이트웨이의 인증 오류로 실패합니다. Pi 프로세스에서 이 변수를 해제하세요.

## 개발과 배포

이 절은 `pi-packages` 저장소에서 작업하는 기여자용입니다.

### 테스트

개발에는 Node.js 22.19 이상과 pnpm 10이 필요합니다. 다음 명령은 `pi-packages` 저장소 루트에서 실행합니다.

```bash
pnpm install --frozen-lockfile
pnpm --filter @buyong/pi-claude-bridge typecheck
pnpm --filter @buyong/pi-claude-bridge test:unit
pnpm --filter @buyong/pi-claude-bridge verify --all --report /tmp/cc-bridge-offline.json
pnpm --dir apps/pi-claude-bridge pack
```

타입 오류와 단위 테스트 실패가 없으면 각 검사는 종료 코드 0으로 끝납니다. `pack`은 앱 디렉터리에 npm 배포용 `.tgz`를 만들고 `catalog:` 참조를 실제 버전으로 바꿉니다. Pi 개발 의존성은 워크스페이스 catalog를 쓰고, 타입 검사는 기존 `tsc`와 `tsconfig.json`을 그대로 씁니다.

검증 CLI는 저장소 전용이며 npm 패키지에는 포함하지 않습니다. 기본 실행은 모델을 호출하지 않고 live 검사를 `skipped`로 표시합니다. 검사 목록은 `verify --list`로 봅니다. live 검사에는 Claude Code 구독 로그인이 필요하며 사용량이 발생합니다.

```bash
pnpm --filter @buyong/pi-claude-bridge verify live-smoke --live --report /tmp/cc-bridge-live.json
```

캐시 측정 검사는 선택 사항이므로 `verify --all`과 `test`에 포함되지 않으며, 필요할 때만 따로 실행합니다. 한 번에 Haiku 5.5 요청이 약 73건 듭니다. [알려진 문제](#알려진-문제)에 적은 재시작 뒤 부족분 때문에 `06-rebuild-cache`가 `fail`을 보고하고 명령은 종료 코드 1로 끝납니다.

```bash
pnpm --filter @buyong/pi-claude-bridge verify --cache --live --report /tmp/cc-bridge-cache.json
pnpm --filter @buyong/pi-claude-bridge test:cache
```

live 검사는 Haiku 5.5만 씁니다. `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, 또는 `CLAUDE_CODE_USE_*` 변수가 설정되어 있으면 요청 전에 종료 코드 2로 멈춥니다. 성공하면 종료 코드 0으로 끝나고, 보고서에 버전·소스 해시·검사 결과·요청 수를 남깁니다. 임시 작업 디렉터리와 Claude Code 세션을 정리하고, 요청 원문 대신 해시를 기록합니다.

`pnpm --filter @buyong/pi-claude-bridge test`는 실제 API를 호출하는 통합 테스트까지 실행합니다. 대체 공급자 검사에 필요한 `CLAUDE_BRIDGE_TESTING_ALT_MODEL`은 앱의 `.env.test`에 설정합니다.

통합 테스트는 실제 `pi`와 Claude Code 하위 프로세스를 실행하므로 `~/.claude`에 쓸 수 있어야 합니다. 이를 막는 샌드박스에서는 `--resume`이 `No conversation found with session ID`로 실패합니다.

### 격리된 환경에서 로컬 로딩 확인

Node.js와 Pi가 있고 의존성을 설치한 환경에서, 저장소 루트에서 실행합니다. 별도 설정 디렉터리를 써서 기존 npm 설치본이 함께 로드되지 않게 합니다.

```bash
node --version
pi --version
package_dir="$PWD/apps/pi-claude-bridge"
check_dir="$(mktemp -d)"
mkdir -p "$check_dir/agent" "$check_dir/work"
cd "$check_dir/work"
PI_CODING_AGENT_DIR="$check_dir/agent" PI_OFFLINE=1 \
  pi --no-skills --no-prompt-templates --no-themes --no-context-files -e "$package_dir"
```

확장 로딩 오류 없이 시작하고 `/model`에 `claude-bridge/*` 모델이 표시되는지 확인합니다. 로딩에 성공해도 Claude 인증이나 실제 요청이 성공한다는 뜻은 아닙니다. 이 환경에서 모델을 호출하려면 별도 인증이 필요하며 사용량이 발생할 수 있습니다.

### 패키지 구성 확인

의존성을 설치한 뒤 저장소 루트에서 실행합니다. `tools/package-check/`는 pi-package-creator 패키지 검사기의 사본이며 npm 패키지에는 포함하지 않습니다. 검사기는 확장 코드를 실제로 불러오므로 현재 사용자 권한으로 실행됩니다. 모델은 호출하지 않습니다.

```bash
package_dir="$PWD/apps/pi-claude-bridge"
reports="$(mktemp -d)"
node "$package_dir/tools/package-check/validate-package.mjs" "$package_dir" \
  --expect "$package_dir/tests/fixtures/package-inventory.json" --runtime \
  --report "$reports/package-check.json"
```

정상이면 종료 코드 0으로 끝나고 보고서에 `status: "pass"`가 나옵니다. 확장 1개, 도구·명령·플래그 0개, 로딩 진단 없음을 확인합니다. `semantic import and bundle inspection`의 `skipped`는 검사기가 import를 정적으로 분석하지 않는다는 표시이며 실패가 아닙니다. 기본 검사 대상은 워크스페이스에 설치된 Pi입니다. 전역 설치된 Pi로 확인하려면 `--pi-root "$(npm root -g)/@earendil-works/pi-coding-agent"`를 붙입니다.

배포 압축 파일은 운영 의존성만 설치한 추출본으로 다시 확인합니다. `npm install`은 npm 레지스트리에 접속합니다. 같은 셸에서 위 변수를 이어서 씁니다.

```bash
artifact_dir="$(mktemp -d)"
pnpm --dir "$package_dir" pack --pack-destination "$artifact_dir"
mkdir -p "$artifact_dir/runtime"
printf '{"private":true}\n' > "$artifact_dir/runtime/package.json"
npm install --prefix "$artifact_dir/runtime" --omit=dev --ignore-scripts --legacy-peer-deps \
  --no-audit --no-fund "$artifact_dir"/*.tgz
node "$package_dir/tools/package-check/validate-package.mjs" \
  "$artifact_dir/runtime/node_modules/@buyong/pi-claude-bridge" \
  --expect "$package_dir/tests/fixtures/package-inventory.json" --runtime \
  --pi-root "$package_dir/node_modules/@earendil-works/pi-coding-agent" \
  --report "$reports/package-artifact.json"
```

기대 결과는 소스 검사와 같습니다. 이 검사는 운영 의존성만으로 확장을 불러올 수 있는지 확인하며, Claude 인증이나 실제 요청은 확인하지 않습니다.

### 배포와 upstream 갱신

배포는 `origin/main`을 추적하는 `main`에서, 추적 파일과 Git index가 깨끗한 상태로 실행합니다. 변경 이력은 `CHANGELOG.md`(영문)와 `CHANGELOG.ko.md`(한글)의 `UNRELEASED` 절에 들어가며, 빠진 항목은 배포 중에 `claude -p`가 초안을 만들고 확인을 받아 기록합니다. 저장소 루트에서 다음 명령을 실행하고 `@buyong/pi-claude-bridge`를 선택합니다.

```bash
pnpm release
```

변경 이력 초안과 버전을 고른 뒤 커밋·태그·push를 하나씩 확인합니다. 파일을 바꾸지 않고 준비 상태만 먼저 보려면 `pnpm release:dry-run --app pi-claude-bridge --version <version>`을 실행합니다. 거절하거나 취소하면 이후 단계는 멈추고, 이미 바뀐 로컬 상태는 남습니다. push는 `main`과 선택한 `pi-claude-bridge-v<version>` 태그만 보냅니다. 저장소 루트의 공통 `.github/workflows/pi-packages.yml`이 태그로 브리지를 선택하고, 검증한 뒤 npm OIDC 배포와 GitHub Release를 만듭니다. 정식 버전은 `latest`, 사전 버전은 해당 식별자나 `next` 태그를 씁니다.

npm Trusted Publisher는 GitHub 사용자 `buYoung`, 저장소 `pi-packages`, workflow 파일명 `pi-packages.yml`에 연결해야 합니다. npm 설정에는 전체 경로가 아니라 파일명만 입력합니다.

upstream remote나 자동 동기화는 설정하지 않습니다. 필요할 때 [upstream 갱신 가이드](https://github.com/buYoung/pi-packages/blob/main/apps/pi-claude-bridge/docs/upstream.md)를 따라 직접 가져옵니다.

## 라이선스

[MIT](LICENSE). 라이선스 고지에는 원작자 Eli Dickinson의 저작권 표시가 남아 있습니다.
