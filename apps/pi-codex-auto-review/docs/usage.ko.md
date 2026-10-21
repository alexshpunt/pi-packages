# 자동 검토 사용법

[English](usage.md) | **한국어**

`@buyong/pi-codex-auto-review` 설치, 승인 방식 선택, 보호 시작과 정책 설정을 설명합니다. 현재 체크아웃을 기준으로 하므로 npm 릴리스에는 아직 게시하지 않은 소스 변경이 없을 수 있습니다. 다른 확장의 안내는 [README의 패키지 목록](../README.ko.md#작업-공간-패키지)에서 찾을 수 있습니다.

## npm에서 설치

Node.js 22.19 이상, Pi 1.0.0 이상과 Pi 모델 접근이 필요합니다. JavaScript 규칙 엔진에는 Rust 컴파일러나 플랫폼별 규칙 바이너리가 필요하지 않습니다.

```sh
pi install npm:@buyong/pi-codex-auto-review
pi list
pi
```

필요하면 Pi에서 `/login`으로 모델 접근을 설정합니다. `/approve`로 승인 방식을 선택한 뒤 프로젝트 파일을 읽고 요약하도록 요청하세요. 일반 범위의 호출은 바로 실행할 수 있고, 승인이 필요한 호출은 선택한 방식으로 검토합니다.

- 현재 프로젝트의 `.pi/settings.json`에 설치하려면 `--local`을 추가합니다. 프로젝트 신뢰 결정 후에만 패키지를 로드합니다.
- npm 릴리스로 고정하려면 `@<version>`을 붙입니다. 버전을 생략하면 최근 게시된 릴리스를 설치합니다.
- Pi가 관리하는 확장에는 호스트 SDK를 제공합니다. 관리 패키지에 별도의 SDK 복사본이나 심볼릭 링크를 추가하지 마세요.
- 설치를 제거하려면 `pi list`에 표시된 소스로 `pi remove <source>`를 실행합니다. 프로젝트 범위의 항목은 `--local`로 제거합니다.

일반 확장 등록은 보호 로컬 도구와 보호 MCP 어댑터를 연결합니다. MCP 중복 연결을 피하도록 Pi의 기본 MCP 확장을 대체합니다. **등록만으로 보호 시작을 보장하지는 않습니다.** Pi 1.3.0은 새 CLI 시작 중 확장 로딩 오류가 나면 종료 코드 1로 끝나지만, 다시 로드와 SDK 로딩의 오류 처리는 별개입니다. Auto Review는 정책·규칙·SQLite 초기화를 세션 시작이나 첫 사용으로 미루며, 실패하면 다시 로드하거나 재시작할 때까지 보호 작업을 차단합니다. 다시 로드 이후까지 포함해 실행 전 준비 상태를 명시적으로 확인하려면 [보호 CLI·SDK](#보호가-준비된-상태에서-시작하기)를 사용하세요.

## 승인 방식과 검토 모델 선택

TUI 세션이나 Pi UI 요청에 응답하는 RPC 클라이언트에서 `/approve`를 실행합니다.

| 선택 | 바뀌는 동작 |
| --- | --- |
| **Approve for me** | 승인이 필요한 호출을 모델이 자동 검토합니다. 기본값입니다. |
| **Ask for approval** | 같은 호출을 사용자가 검토합니다. 정책이 허용한 일반 호출은 바로 실행합니다. |
| **Full Access** | 확인 후 승인과 모든 경로·명령·네트워크 제한을 건너뜁니다. |
| **Auto Review Off** | 확장 전체를 끄고 Pi의 원래 도구로 실행합니다. 다음 실행에도 유지합니다. |
| **Review cache expiry** | 읽기 자동 승인 캐시의 만료 시간을 1~12시간 중 선택합니다. 기본값은 3시간입니다. |

앞의 두 선택은 저장합니다. **Full Access는 저장하지 않으며**, Pi를 종료하거나 다른 승인 방식을 선택할 때까지 적용합니다. 평소 절대 거부하는 경로·명령 제한도 우회합니다. 확인을 취소하면 활성화하지 않고 선택창으로 돌아갑니다. 아래의 정책 적용·승인 재사용·MCP 검토 설명은 확장이 켜져 있고 Full Access가 꺼진 상태를 전제로 합니다.

Windows의 내장 `powershell` 도구는 `bash`와 같은 방식으로 보호합니다. 확장은 보호된 `powershell` 도구를 등록하되 활성화하지 않으므로, Pi에서처럼 `defaultTools`(예: `"+powershell"`)나 `--tools`로 켜세요. 보호 시작도 같은 `defaultTools` 선택을 따릅니다. PowerShell 명령은 bash 규칙이 아니라 자체 문법으로 분석합니다. [Windows와 PowerShell](#windows와-powershell)을 참고하세요. 꺼진 동안에는 Pi의 원래 PowerShell 도구가 실행됩니다.

### 확장 전체 끄기와 다시 켜기

TUI 또는 UI가 연결된 RPC 세션에서 다음 명령을 실행합니다.

| 명령 | 결과 |
| --- | --- |
| `/approve off` | 자동 검토·승인 확인·보호 경로·명령·네트워크 정책 검사를 끕니다. |
| `/approve on` | 이전 승인 방식·검토 모델·정책 설정으로 다시 켭니다. 세션의 Full Access는 해제합니다. |
| `/approve status` | 켜기·끄기 상태와 활성 승인 방식을 표시합니다. |

끄기는 `/approve`의 **Auto Review Off**에서도 선택할 수 있습니다. 꺼진 동안 로컬 도구·직접 셸 호출·MCP 도구는 Pi의 원래 실행 경로를 사용하며, 확장의 기본 셸 제한 시간도 적용하지 않습니다. 일반 설치와 보호 설치 모두 세션 연결 후 Pi의 유효 `shellPath`·`shellCommandPrefix`·`images.autoResize` 설정을 사용하며, 명시적인 SDK `bashOptions`·`readOptions`가 우선합니다. 셸 경로가 미설정이면 그 상태로 Pi의 플랫폼별 탐색에 맡기므로 Windows의 Git Bash 탐색도 유지합니다. Pi의 프로젝트 신뢰 결정과 외부 서버 자체의 인증·권한은 계속 따릅니다.

켜기·끄기는 `isEnabled`에 저장하며 현재 세션과 다음 실행에 적용합니다. 승인 방식·검토 모델 설정은 유지합니다. `/approve`에서 **Approve for me**, **Ask for approval** 또는 확인한 **Full Access**를 선택하면 다시 켜집니다. 캐시나 검토 모델만 바꾸면 꺼진 상태를 유지합니다.

### 검토 캐시와 모델 설정

캐시 만료 시간은 `/approve`의 **Review cache expiry** 또는 `/approve cache`에서 설정합니다. 선택은 저장되며 취소하면 기존 값을 유지합니다.

`/approve-model`은 Pi의 현재 `/scoped-models` 범위에서 사용 가능한 모델과 Codex의 승인 검토 모델 `codex-auto-review`를 검색합니다. 검토 모델을 선택해도 주 대화 모델은 바뀌지 않습니다. **Use current Pi model**은 `reviewModel: null`을 설정합니다.

- 모델 범위가 없으면 사용 가능한 전체 모델을 표시합니다.
- 범위 안의 모델이 모두 사용할 수 없어도 전체 목록으로 확대하지 않습니다.
- `codex-auto-review`는 `openai`와 `openai-codex` 중 인증이 있고 `gpt-5.6-luna`가 목록에 있는 공급자마다 **Codex Auto Review (openai free)**, **Codex Auto Review (openai-codex)**로 표시합니다. 연결 주소와 한도는 그 공급자의 `gpt-5.6-luna` 값을 씁니다. Pi의 `/model`에는 없으므로 모델 범위와 관계없이 표시합니다.
- 선택창이 열린 동안 범위에서 빠진 모델은 저장하지 않습니다.
- Esc로 취소하면 기존 설정을 유지합니다. 고정 UI 문구는 영어입니다.

선택은 `<agentDir>/guard/settings.json` 또는 명시한 `settingsPath`에 저장합니다. 메뉴 변경은 저장 후 적용하고 이전 정책의 대기 검토와 정확한 작업에 대한 승인 기록을 무효화합니다. 정책 파일을 직접 수정했다면 `/reload`로 확장을 다시 로드하거나 보호 런타임을 재시작하세요.

## 소스에서 빌드

[pi-packages](https://github.com/buYoung/pi-packages) 저장소 루트에서 실행합니다. 개발 SDK는 커밋된 pnpm 잠금 파일로 설치하며, 재포장한 `vendor` SDK는 필요하지 않습니다.

```sh
pnpm install
pnpm --filter "@buyong/pi-codex-auto-review..." build
node apps/pi-codex-auto-review/dist/cli.js --help
```

이 필터는 자동 검토보다 `@buyong/redact`를 먼저 빌드합니다. 전체 작업 공간 패키지를 빌드하려면 `pnpm build`를 실행합니다.

빌드한 자동 검토 패키지를 계속 사용할 수 있도록 등록하려면 같은 저장소 루트에서 실행합니다.

```sh
pi install ./apps/pi-codex-auto-review
pi list
```

Pi는 로컬 패키지를 복사하지 않고 해당 경로에서 직접 로드합니다. 소스를 수정한 뒤 다시 빌드하고 Pi를 다시 로드하거나 재시작하세요. 같은 확장의 npm 설치를 함께 활성화하지 마세요.

## 보호가 준비된 상태에서 시작하기

보호 CLI와 `createGuardedRuntime()`은 확장과 제어기의 준비 상태를 확인합니다. 매니페스트의 peer 범위와 관계없이 **Pi 1.0.0 미만의 버전은 `UNSUPPORTED_PI`로 거부합니다.** 모드 재연결 후와 사용자의 직접 셸 호출에도 준비 상태를 확인합니다.

이 진입점은 자동 확장 탐색을 끕니다. 추가 확장은 명시적으로 로드하고 코드를 신뢰해야 합니다. 다른 확장의 도구에는 승인 제어가 자동으로 추가되지 않습니다. 로컬 셸·파일 도구와 보호 MCP 어댑터는 기존 승인 경로를 유지합니다.

프로젝트 지침·설정·MCP 서버는 Pi에 저장된 신뢰 결정과 전역 `defaultProjectTrust`를 따릅니다. 저장되거나 명시한 신뢰가 없으면 프로젝트 자원을 시작하지 않습니다. `--trust-project` 또는 SDK의 `isProjectTrusted: true`는 이번 실행의 시작 프로젝트를 신뢰합니다. 이후 디렉터리를 바꾸면 각 디렉터리의 신뢰 기록을 따릅니다.

### CLI

위의 소스 빌드를 마친 뒤 저장소 루트에서 실행합니다. `/absolute/path/to/project`를 프로젝트 디렉터리로 바꾸세요.

```sh
node apps/pi-codex-auto-review/dist/cli.js --cwd /absolute/path/to/project
```

터미널 UI 대신 한 번 응답하고 종료하려면 다음과 같이 실행합니다.

```sh
node apps/pi-codex-auto-review/dist/cli.js --mode print "Read the README and summarize how to run this project. Do not change files."
```

CLI는 설정된 Pi 모델과 자격 증명을 사용합니다. `print`는 텍스트, `json`은 JSONL 이벤트를 반환하고, `rpc`는 Pi RPC 인터페이스를 실행합니다. UI 없이 자동 검토할 수 있지만, 승인 UI가 없을 때 사용자 승인이 필요한 호출은 실행하지 않습니다.

| 옵션 | 동작 |
| --- | --- |
| `--mode tui\|print\|json\|rpc` | 인터페이스 선택. 기본값은 `tui`입니다. |
| `-p` | `--mode print`의 축약형 |
| `--cwd path` | 시작 프로젝트 디렉터리. 기본값은 명령을 실행한 디렉터리입니다. |
| `--agent-dir path` | Pi 자원 디렉터리. `PI_CODING_AGENT_DIR`, 그다음 `~/.pi/agent`를 기본값으로 사용합니다. |
| `--policy file` | 존재하고 유효해야 하는 정책 JSON 파일. 상대 경로는 명령을 실행한 디렉터리 기준입니다. |
| `--trust-project` | 이번 실행의 시작 프로젝트를 신뢰합니다. |
| `--extension path`, `-e path` | 명령을 실행한 디렉터리 기준의 신뢰한 확장 경로. 여러 번 지정할 수 있습니다. 코드가 있는 디렉터리를 모델 쓰기에서 보호합니다. |
| `--provider provider --model model` | 등록된 공급자·모델을 정확히 선택합니다. 둘을 함께 지정해야 하며, 모델이 없으면 시작을 막습니다. |
| `--` | 옵션 해석을 끝내 `-`로 시작하는 프롬프트를 전달합니다. |

이 래퍼는 자체 옵션만 받으며 표준 `pi` CLI의 모든 옵션을 지원하지 않습니다. 일반 npm 설치는 `pi-codex-auto-review` 실행 파일도 제공합니다. Pi가 관리하는 패키지 설치는 이 실행 파일이 셸의 `PATH`에 들어가도록 보장하지 않습니다.

외부 공급자는 등록 확장을 명시적으로 로드합니다. 이 패키지에는 `pi-ollama-cloud`가 개발 의존성으로 있습니다. 실행할 셸에 `OLLAMA_API_KEY`가 이미 export되어 있다면 다음과 같이 실행합니다.

```sh
node apps/pi-codex-auto-review/dist/cli.js \
  --extension apps/pi-codex-auto-review/node_modules/pi-ollama-cloud/index.ts \
  --provider ollama-cloud --model glm-5.3 \
  --mode print "Read the README and summarize this project. Do not change files."
```

계정에서 사용할 수 있는 모델을 선택하세요. 실제 공급자를 호출하므로 사용량이 발생할 수 있습니다. 자격 증명을 명령 인자에 넣지 마세요.

### SDK

체크아웃 밖의 애플리케이션에서는 그 애플리케이션 디렉터리에 확장과 맞는 Pi 호스트 패키지를 설치합니다.

```sh
npm install @buyong/pi-codex-auto-review \
  @earendil-works/pi-coding-agent \
  @earendil-works/pi-ai \
  @earendil-works/pi-tui
```

ESM 애플리케이션에서 공개 `startup` 진입점을 사용합니다. 예시는 기존 Pi 자원과 자격 증명을 선택하고, 마지막 응답을 출력한 뒤 런타임을 정리합니다.

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createGuardedRuntime } from '@buyong/pi-codex-auto-review/startup';

const runtime = await createGuardedRuntime({
  cwd: process.cwd(),
  agentDir: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'),
});
try {
  await runtime.session.prompt('Read the README and summarize this project. Do not change files.');
  console.log(runtime.session.getLastAssistantText());
} finally {
  await runtime.dispose();
}
```

| 옵션 | 동작 |
| --- | --- |
| `cwd`, `agentDir` | 필수 시작 프로젝트·Pi 자원 디렉터리 |
| `settings` | 기본 정책 값. 저장된 설정 파일의 값이 우선합니다. |
| `settingsPath` | 명시적 정책 파일. 기본 경로와 달리 파일이 없으면 시작을 막습니다. |
| `isProjectTrusted` | 시작 프로젝트의 신뢰 여부를 선택합니다. |
| `model` 또는 `modelSelection` | 모델 객체 또는 `{ provider, id }`. 함께 사용할 수 없습니다. |
| `trustedExtensionPaths` | 시작 `cwd` 기준의 확장 진입 경로. 같은 디렉터리의 import를 포함해 코드 디렉터리를 보호합니다. |
| `profile` | `readOnlyPaths` 등을 포함한 사용자 지정 권한 프로필. 확장이 켜져 있고 Full Access가 꺼져 있으면 필수 가드 제어·규칙 파일·확장 코드 보호도 적용합니다. |
| `mcp` | MCP 확장 옵션. `false`면 보호 MCP 어댑터를 끕니다. |
| `mcpToolPolicies` | `server/tool` 키별 `approvalMode` 설정 |
| `modelRuntime`, `settingsManager`, `sessionManager` | 애플리케이션이 제공하는 Pi 서비스와 세션 저장소 |
| `trustedExtensions`, `externalExtensions` | 명시적인 인라인 통합. 호출자가 코드의 신뢰를 책임집니다. |

SDK는 승인 UI 없이 시작합니다. 자동 검토는 호출을 승인할 수 있지만, 사용자 검토 요청에는 적절한 인터페이스가 연결되어야 하며 없으면 거부합니다. `settingsManager`를 제공할 때 명시한 신뢰 선택은 그 관리자의 설정과 일치해야 합니다.

## 정책 파일

일반 Pi 설치는 `<agentDir>/guard/settings.json`을 읽습니다. CLI의 `--policy`나 SDK의 `settingsPath`로 다른 파일을 선택할 수 있습니다. 명시적 파일은 시작 전에 만들어야 합니다. 빠진 키는 기본값을 사용하고, 알 수 없는 키나 잘못된 값은 거부합니다. SDK `settings`는 기본값만 제공하며 저장된 파일이 우선합니다. 중첩 객체는 깊게 병합하지 않습니다.

다음 예시는 기본 승인 동작을 유지하고 명령 규칙 두 개를 추가합니다.

```json
{
  "mode": "workspace-write",
  "approvalPolicy": "on-request",
  "approvalsReviewer": "auto_review",
  "reviewModel": null,
  "commandRules": [
    {"prefix": ["git", "status"], "decision": "allow"},
    {"prefix": ["git", "push"], "decision": "deny"}
  ]
}
```

### 승인과 범위 설정

아래 범위·거부 규칙은 모두 **확장이 켜져 있고 Full Access가 꺼진 상태**를 전제로 합니다.

| 필드 | 기본값 | 동작 |
| --- | --- | --- |
| `isEnabled` | `true` | `false`면 확장 전체의 검토·승인·정책 검사를 끕니다. `/approve on`·`off`로 즉시 변경하며, 파일을 직접 수정하면 다시 로드하거나 재시작합니다. |
| `mode` | `"workspace-write"` | 작업 공간·임시 경로의 일반 쓰기를 허용합니다. `"read-only"`는 쓰기를 검토로 보내며 승인된 쓰기는 실행할 수 있습니다. |
| `approvalPolicy` | `"on-request"` | 필요한 검토를 허용합니다. `"never"`는 승인이 필요한 호출을 차단하지만 정책이 허용한 호출은 차단하지 않습니다. 범주별 설정은 아래에서 설명합니다. |
| `approvalsReviewer` | `"auto_review"` | `"user"`는 사용자 검토를 요청합니다. |
| `reviewModel` | `null` | 현재 모델 또는 등록된 `{ "provider": "...", "id": "..." }` 쌍 |
| `commandRules` | `[]` | `allow`·`ask`·`deny`로 판단하는 리터럴 인자 접두사 규칙 |
| `ruleFiles` | `[]` | 작업 디렉터리 기준의 규칙 파일 경로 |
| `allowedDomains` | `[]` | 해석한 네트워크 명령의 호스트 패턴. `*.example.com`은 하위 도메인과 일치하지만 `example.com`과는 일치하지 않습니다. OS 네트워크 제한을 만들지는 않습니다. |
| `writableRoots` | `[]` | 작업 디렉터리 기준의 추가 일반 쓰기 루트 |
| `excludeSlashTmp` | `false` | 기본 쓰기 루트에서 `/tmp`를 제외합니다. Windows에는 `/tmp` 루트가 없으므로 영향이 없습니다. |
| `excludeTmpdir` | `false` | 기본 쓰기 루트에서 `os.tmpdir()`를 제외합니다. 경로가 겹치면 두 설정을 모두 켜야 할 수 있습니다. |
| `trustedTools` | `[]` | 호환용 필드. 다른 확장 도구를 여기에 나열할 필요는 없습니다. |

`approvalPolicy`는 범주별로 설정할 수도 있습니다.

```json
{
  "approvalPolicy": {
    "sandbox": true,
    "rules": false,
    "mcp_elicitations": true
  }
}
```

`sandbox`는 일반 승인 요청의 호환용 이름이며 **OS 격리를 뜻하지 않습니다.** `rules`는 규칙이 요구한 승인을, `mcp_elicitations`는 MCP 승인 요청을 제어합니다. 이 객체에서 `sandbox`와 `rules`는 필수이고, 생략한 `mcp_elicitations`는 꺼진 상태입니다. 꺼진 범주의 요청은 모델·사용자 검토 없이 차단합니다.

### 검토 한도와 프로젝트 지침

| 필드 | 기본값 | 동작 |
| --- | --- | --- |
| `reviewTimeoutMs` | `20000` | 자동 검토 제한 시간. 밀리초 단위입니다. |
| `approvalTimeoutMs` | `60000` | 승인 창 제한 시간. 밀리초 단위입니다. |
| `executionTimeoutSeconds` | `120` | 보호 셸 실행의 기본 제한 시간. 초 단위이며 호출자가 지정한 값이 우선합니다. |
| `reviewPolicy` | `null` | 검토자의 조직 정책 부분만 교체합니다. 위험·출처 신뢰·결과 기준은 유지합니다. |
| `reviewMaxRounds` | `4` | 조사를 포함한 검토 모델 호출 라운드. 1~16의 정수입니다. |
| `reviewMaxOutputTokens` | `2048` | 검토자 출력 한도. 1~16384의 정수입니다. |
| `reviewContextChars` | `60000` | 검토 문맥 문자 예산. 1~500000의 정수입니다. |
| `reviewCacheTtlHours` | `3` | 읽기 자동 승인 캐시의 유효 시간. 1~12시간의 정수이며 `/approve`에서도 설정합니다. |
| `projectDocMaxBytes` | `32768` | 프로젝트 지침 합산 바이트 한도. 0~1000000의 정수입니다. |
| `projectDocFallbackFilenames` | `[]` | `AGENTS.override.md`·`AGENTS.md` 다음에 확인할 지침 파일명 |
| `projectRootMarkers` | `null` | `.git`을 루트 표시로 사용합니다. 목록으로 교체할 수 있고, `[]`은 상위 탐색을 끕니다. |
| `redaction` | 빈 목록 네 개 | 필수 검토자 가림에 더할 설정. [검토자 가림](#검토자-가림)을 참고하세요. |

가드는 `agentDir`의 전역 지침과 신뢰한 프로젝트의 루트부터 `cwd`까지의 지침을 탐색합니다. 디렉터리마다 `AGENTS.override.md` → `AGENTS.md` → 설정한 보조 파일 순서로 선택합니다. 보호 파일의 별칭은 거부하며, 도구 출력에 나온 파일명을 지침 출처로 삼지 않습니다. 새로고침하면 파일을 다시 읽습니다.

## 규칙 파일

TypeScript 엔진은 Codex 리비전 `a956835d020762cb2b570053af06f643a11c0ecc`에서 이식한 `.rules` 계약을 평가합니다. [대조 검사](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-auto-review/tests/unit/execpolicy-parity.test.mjs)는 이전 네이티브 엔진에서 수집한 출력을 재생하며, 모든 Starlark 프로그램의 동등성을 증명하지는 않습니다.

예를 들어 사용자가 관리하는 규칙 파일에 다음을 작성합니다.

```python
prefix_rule(["git", "status"], decision="allow")
prefix_rule(["git", "push"], decision="forbidden")
```

정책의 `ruleFiles`에 경로를 추가하고 다시 로드하거나 재시작합니다. JSON `commandRules`의 `ask`·`deny`에 해당하는 `.rules` 값은 `prompt`·`forbidden`입니다.

- Starlark 함수·조건식·컴프리헨션·문자열 보간, `prefix_rule`, `host_executable`, `network_rule`, `match`·`not_match` 검증을 지원합니다.
- Starlark 값과 정책 함수만 제공하며 호스트 파일·네트워크 함수나 JavaScript `eval`은 제공하지 않습니다.
- 입출력·평가 단계·자료 크기·중첩·시간을 제한합니다. 잘못된 입력, 지원하지 않는 구문이나 한도 초과는 평가를 거부합니다.
- 비동기 평가는 취소 가능한 Node.js 작업 스레드, 동기 API는 제한된 Node.js 자식 프로세스를 사용합니다. 규칙 파일이 없으면 평가기를 시작하지 않습니다.
- 복합 명령에는 가장 강한 판단을 적용합니다. 네트워크 프로토콜 표시는 별도 권한이 아니라 호스트 허용·거부 목록으로 합칩니다.
- 해석하지 못하는 셸 구문은 신뢰한 전체 명령 규칙이 허용하지 않으면 검토합니다. 이런 bash 명령은 `[<셸>, "-c", 명령]`, PowerShell 스크립트는 `[<PowerShell 실행 파일>, "-Command", 스크립트]`로 대조합니다.
- 리터럴 PowerShell 스크립트는 Codex PR #20336처럼 내부 명령으로 대조합니다. 중첩된 `bash`·`sh`·`zsh`·`dash`의 `-c`·`-lc`와 `powershell`·`pwsh`의 `-Command`·`-c` 래퍼는 네 단계까지 풉니다. Windows에서는 래퍼 이름을 대소문자 구분 없이, `.exe`·`.cmd`·`.bat`·`.com`을 뺀 이름으로 비교합니다.
- 알려진 cmdlet이나 기본 별칭으로 시작하는 PowerShell 명령은 대소문자와 상관없이, 쓴 그대로와 문서상의 cmdlet 이름(예: `rm`·`del`·`remove-item`에 대한 `Remove-Item`)으로 모두 대조합니다. 둘 중 어느 형태에 맞는 규칙이든 적용되므로 `forbidden`과 `prompt`는 어느 쪽에서 나와도 효력이 있고, `allow`는 여전히 모든 명령을 덮어야 합니다. 규칙 단어는 정확히 비교하므로 cmdlet 규칙은 문서상의 이름으로 쓰세요. `["rm"]`처럼 별칭으로 쓴 규칙은 그 별칭에만 맞습니다. PowerShell 안의 `bash -c` 스크립트에서 나온 명령은 자기 이름을 유지하므로, 그 안의 `sort`는 `Sort-Object`가 아닙니다.
- `curl`·`wget`의 목적지가 명시적인 HTTP URL이 아니거나 별도 설정 파일에서 오면 검토합니다.

**`allow` 규칙은 좁게 지정하세요.** 일치하는 명령을 일반 범위 밖에서도 허용할 수 있지만, Full Access가 꺼져 있으면 절대 거부를 해제하지는 못합니다. PowerShell의 와일드카드·공급자 경로나 Windows의 WSL·POSIX 루트 경로처럼 위치를 확인할 수 없는 대상이 있는 명령은 `allow` 규칙과 맞아도 검토합니다.

## 검토 중의 동작

### 정확한 작업에 대한 승인과 실행

승인된 로컬 도구는 Pi의 원래 실행기를 사용하며 최종 명령·작업 디렉터리·환경·제한 시간·취소 신호·호출자 옵션을 유지합니다. `additional_permissions`는 검토 범위를 설명할 뿐 실행 중 그 범위를 강제하지 않습니다.

TUI·RPC 승인 창에서는 **Allow once**, **Allow for this session**, **Save as an allow rule**을 선택할 수 있습니다. 전체 명령의 권한 상승 승인은 한 번만 사용할 수 있습니다. 그 밖의 정확한 작업에 대한 승인은 도구·입력·작업 디렉터리·호출 출처·정책·권한에 묶이며, 정책이나 범위가 바뀌면 무효화합니다.

조건을 충족하는 MCP 도구와 스킬 스크립트는 별도의 패키지 승인을 재사용할 수 있습니다.

- MCP 지문에는 서버 설정, 초기화에서 받은 식별 정보·버전과 도구 정의를 포함합니다.
- 스킬 지문에는 `SKILL.md`가 있는 디렉터리의 파일을 포함합니다. `<script>` 또는 `<interpreter> <script>` 단일 명령만 해당하며, 심볼릭 링크가 있는 스킬은 캐시하지 않습니다.
- 자동 승인과 **Save as an allow rule**은 `<agentDir>/guard/package-approvals.json`에 저장합니다. **Allow for this session**은 세션에만 적용하고 **Allow once**는 재사용하지 않습니다.
- 내용이 바뀌면 다시 검토합니다. 추가 경로·도메인, 위치를 알 수 없는 셸 대상(Windows의 WSL·POSIX 루트 경로, 와일드카드·공급자·원격 공유 경로 등), 권한 상승, 규칙의 확인 요구, 엄격한 MCP 검토와 필수 사용자 입력은 항상 새 판단을 요구합니다.

### 읽기 자동 검토 캐시

읽기 작업의 구조화된 자동 승인 결과는 `<agentDir>/pi-codex-auto-review.sqlite`에 저장합니다. 기본 위치는 `~/.pi/agent/pi-codex-auto-review.sqlite`이며 `PI_CODING_AGENT_DIR`이나 명시한 `agentDir`을 따릅니다. 같은 Pi 자원 디렉터리를 사용하는 세션과 프로세스가 공유합니다.

- Pi의 `read`·`grep`·`find`·`ls` 도구와 단일 리터럴 셸 읽기 명령이 대상입니다. 셸 명령은 `cat`, `head`, `tail`, `wc`, `rg`, `grep`, `find`, `ls`, `stat`, `pwd`를 확인합니다. `git status`, `git ls-files`, `git rev-parse`도 포함합니다. `git diff`·`log`·`show`는 `--no-ext-diff`와 `--no-textconv`가 있어야 합니다. Windows에서는 경로를 붙인 bash 실행 파일을 재사용하지 않습니다.
- PowerShell 읽기는 알려진 매개변수만 쓰고 와일드카드나 공급자 경로가 없는 단일 리터럴 `Get-Content`·`Get-ChildItem`·`Get-Item`·`Test-Path`·`Resolve-Path`·`Get-FileHash`·`Select-String`·`Get-Location` 호출, 또는 `cat`·`ls`·`gci` 같은 기본 별칭이 대상입니다. `rg`와 위 git 하위 명령은 bash와 같은 조건으로 포함합니다.
- 파이프, 복합 명령, 리다이렉션, 명령 치환, 인터프리터, 쓰기·네트워크 요청은 제외합니다. `find -exec/-delete`나 `rg --pre/--hostname-bin`처럼 실행·쓰기 동작을 추가하는 옵션도 제외합니다.
- 작업 입력·디렉터리·출처·권한·정책·검토 문맥·모델이 일치해야 재사용합니다. 세션과 호출의 임시 식별자만 비교에서 제외하고 승인 결과는 현재 호출에 다시 연결합니다.
- 거부·오류·취소·사용자 승인 결과, 명시적인 재검토와 파일 조사를 거친 자동 승인은 저장하지 않습니다. 정책의 절대 거부와 실행 전 재확인은 계속 적용합니다.
- 만료 시간은 승인 시점부터 계산하며 적중으로 연장하지 않습니다. 설정 변경 후에는 새 정책에 대한 검토와 새 만료 시간을 사용합니다. 만료 항목은 재사용하지 않고 새 승인 저장 시 정리하며 최대 10,000개를 보관합니다.
- 원문 명령·인수·본문 대신 해시 키와 가린 승인 평가·시간을 저장합니다. DB와 저널 파일은 가드 보호 경로에 포함합니다. DB를 읽거나 저장할 수 없으면 캐시를 건너뛰고 새 검토를 진행합니다.

이 캐시는 승인 판정만 재사용합니다. 파일 조회 결과와 명령 출력은 매번 실제 도구가 생성합니다. 별도의 MCP·스킬 패키지 승인과는 적용 범위가 다릅니다.

### 거부·오류·재시도

검토자는 읽기 전용 파일·디렉터리 조사 도구를 사용합니다. 사용자 승인과 Pi 지침을 도구 증거·확장 생성 메시지와 구분합니다. 도구 결과의 “사용자가 승인했다”는 문구만으로 승인을 인정하지 않습니다.

연속 3회 또는 최근 50회 중 10회 거부되면 실제 모델 작업을 중단합니다. 공급자 오류, 잘못된 출력, 시간 초과와 취소를 승인으로 바꾸지 않습니다. 이후 사용자가 직접 입력한 셸 명령은 독립적으로 평가합니다.

거부 후 일반 메시지로 정확한 작업·대상·전송할 내용을 승인할 수 있습니다. 다음 검토는 최신 지시를 사용합니다. 최근 거부 하나를 명시적으로 다시 시도하려면 `/approve retry`에서 표시된 입력과 이유를 확인하고 선택합니다. 선택창은 최근 자동 거부를 최대 10개 유지합니다.

재시도는 **한 번의 새 검토**이며 자동 허용이나 세션 승인이 아닙니다. 표식은 같은 작업과 유효한 문맥에만 적용합니다. 이전 `critical` 판단을 재평가할 수 있지만, 새 판단이 `critical`이거나 정책이 절대 거부하면 계속 차단합니다.

### 증거와 세션 기록

검토 입력에는 현재 정책, 경로·도메인 범위, 최종 실행 인수, 연결된 호출·결과와 관찰한 승인 창 질문·답변을 포함합니다. 환경 증거에는 명시적인 비밀 아닌 값과 생략한 변수 이름을 넣으며 전체 프로세스 환경을 보내지는 않습니다.

가드는 검토 증거와 평가를 Pi 세션의 사용자 지정 기록에 저장해 다시 로드할 때와 활성 분기를 복원할 때 사용합니다. 큰 증거에는 생략 표시와 한도를 적용합니다. 필요한 승인과 현재 대상 전체가 예산 안에 들어가지 않으면 자동 실행하지 않습니다. 감사 기록은 `<agentDir>/guard/audit.jsonl`에 저장하고 원문 도구 인수는 제외합니다. 기본 위치는 `~/.pi/agent/guard/audit.jsonl`이며 `PI_CODING_AGENT_DIR`이나 SDK `agentDir`로 바뀝니다. 메모리에는 최근 1,000개만 남깁니다. 파일은 추가 전용으로 자동 회전·삭제하지 않아 여러 세션에 걸쳐 계속 증가합니다. 공간을 확보하려면 같은 agent 디렉터리를 쓰는 세션을 종료한 뒤 `guard/audit.jsonl`을 수동으로 보관하거나 삭제하세요. 삭제한 파일은 다음 감사 기록 때 다시 생성합니다. 승인 규칙이나 SQLite 캐시는 삭제하지 않습니다.

보호 Pi `select`·`confirm`·`input` 어댑터에서 관찰한 확인만 사용자 확인으로 기록합니다. 비밀번호·API 키 답변은 가립니다. 실제 Pi 모델은 구조화된 `outcome` 평가를 반환해야 합니다. 기존 `decision` 응답은 명시적으로 주입한 SDK `ReviewProvider` 구현만 지원합니다.

### 검토자 가림

검토자에게 전달할 문맥·조사 출력·사용자 승인·요청 데이터는 [`@buyong/redact`](https://github.com/buYoung/pi-packages/blob/main/packages/redact/README.ko.md)를 거칩니다. 이 가림을 끌 수는 없습니다.

기본·호환 규칙은 공급자 토큰, 인증 값, URL 비밀번호, 웹훅 경로, PEM 개인 키, 민감한 값 대입과 기존 `SYNTHETIC_` 표식을 가립니다. 세션·문맥·호출·항목 식별자와 결합 다이제스트는 원래 값을 유지합니다.

작업에 탐지된 값이 있으면 검토자는 가린 사본과 `redactedActionFields`를 받습니다. 이 필드는 값 없이 JSON 경로·규칙 ID만 담습니다. 가림만으로 거부하거나 사용자에게 묻지는 않습니다. 승인 결합과 실행은 **원래 작업**을 사용하므로, 가림이 승인된 명령의 비밀 전송을 막지는 않습니다.

증거 예산과 발췌를 적용하기 전에 가립니다. 파일 조사는 일반 파일의 전체 원문을 최대 1 MiB까지 읽고 `.env` 값 등을 파일 경로 힌트와 함께 가린 다음 최대 120행과 출력 12,000자 예산으로 발췌합니다. 더 큰 파일은 가리지 않은 앞부분을 보내는 대신 조사 실패를 명시합니다. 조사 전용 읽기이므로 사용자에게 반환하는 일반 `read` 결과는 바꾸지 않습니다. 새 설정은 이후 추가되는 증거에 적용하며 저장된 증거는 그대로 유지합니다. 지원하지 않는 형식을 놓치거나 무해한 값을 가릴 수도 있습니다. 로그를 공유하기 전에 확인하세요.

| `redaction` 키 | 항목 | 효과 |
| --- | --- | --- |
| `sensitiveFields` | 필드 이름 | 일치하는 필드의 값을 가립니다. 이름은 글자·숫자만 남기고 소문자로 비교합니다. |
| `rules` | `{ "id": "custom.name", "pattern": "...", "flags": "i" }` | JavaScript RegExp 규칙을 추가합니다. `(?<secret>…)` 그룹은 그 그룹만 가립니다. `i`·`m`·`s`·`u` 플래그를 사용할 수 있습니다. |
| `exceptions` | `{ "ruleId": "...", "value": "..." }` | 한 규칙의 정확한 값 하나를 보이게 둡니다. 다른 규칙이 일치하면 다시 가릴 수 있습니다. |
| `piiEntities` | `EMAIL_ADDRESS` 같은 엔티티 이름 | 로컬 개인정보 탐지를 켭니다. 기본은 꺼져 있습니다. |

```json
{
  "redaction": {
    "sensitiveFields": ["sessionKey"],
    "rules": [{"id": "custom.acme", "pattern": "ACME_[A-Z0-9]+"}],
    "exceptions": [{"ruleId": "custom.acme", "value": "ACME_EXAMPLE"}],
    "piiEntities": ["EMAIL_ADDRESS"]
  }
}
```

잘못된 항목은 `INVALID_SETTINGS`로 거부합니다. 가림 검증 오류는 패턴·값을 반복하지 않고 키·색인을 알려 줍니다. 이 설정을 지원하지 않는 버전은 키가 들어간 파일을 `Unknown setting: redaction`으로 거부합니다. 그런 버전으로 돌아가기 전에 정책을 백업하고 이 키를 제거하세요.

## MCP 승인

어댑터는 Pi에 등록한 서버, `<agentDir>/mcp.json`과 신뢰한 프로젝트의 `.pi/mcp.json`을 사용합니다. 모드를 다시 연결하면 이전 연결을 닫고 새 연결을 만듭니다. 승인은 실제 서버·도구 등록에 묶이며 검토 중 등록이 바뀌거나 취소되면 실행하지 않습니다.

SDK `mcpToolPolicies`는 `server/tool` 키별 승인 모드를 선택합니다.

| 모드 | 일반 승인 동작 |
| --- | --- |
| `auto` | annotation 우선순위를 따릅니다. 파괴적 호출은 검토하고, 그 외 읽기 전용 호출은 생략합니다. destructive/open-world 표시가 없으면 기본적으로 검토합니다. |
| `prompt` | 항상 검토합니다. |
| `writes` | `readOnlyHint`가 `true`일 때만 검토를 생략합니다. |
| `approve` | 일반 검토를 생략합니다. |

엄격한 검토, 민감 작업과 필수 사용자 입력은 이런 일반 생략 조건보다 우선합니다. `codex_requires_user_input`을 모델이 대신 승인하지 않습니다. 빈 승인 폼은 처리하지만 입력 필드가 있는 일반 폼과 URL 인증 요청은 거부합니다.

`node_repl/js`에도 같은 규칙을 적용합니다. 추가 승인 요청은 원래 유효한 호출의 도구·연결·입력과 일치해야 하며 다른 도구·커넥터를 대신 지목할 수 없습니다. Off 상태에서도 호출자의 취소·시간 초과 신호를 transport까지 전달하므로 인증 대기가 끝난 뒤 취소된 요청을 늦게 보내지 않습니다. 실패·취소·시간 초과 요청의 로컬 추적 상태도 해제합니다. 이미 전달한 요청의 취소는 외부 서버에 달려 있습니다.

## Windows와 PowerShell

Windows의 bash는 Pi가 찾은 셸, 보통 Git Bash로 실행합니다. 경로 검사는 명령을 실행하는 셸을 따릅니다.

- Git Bash·MSYS2·Cygwin의 `/c/Users/...`, `/cygdrive/c/...` 인자는 `C:\Users\...`로 대응합니다. `/tmp`·`/usr`·`/` 같은 다른 POSIX 절대 경로는 Windows 위치를 알 수 없으므로 검토합니다.
- WSL bash(`C:\Windows\System32\bash.exe`)에는 드라이브 대응을 적용하지 않으며 Windows 드라이브 경로와 POSIX 절대 경로 인자를 검토합니다. Pi의 셸을 식별하지 못하면 드라이브 경로를 보호 경로와 대조한 뒤 검토합니다.
- 파일 도구는 Pi와 같이 `/c/...`, `/mnt/c/...`, `/cygdrive/c/...`, `~\`를 받습니다.
- 보호 경로는 Windows와 macOS에서 대소문자를, macOS에서는 유니코드 정규화 차이도 구분하지 않고 비교합니다. 허용 쓰기·읽기 루트는 정확히 비교하므로 표기가 다른 경로는 허용 대신 검토로 갑니다.
- 대체 데이터 스트림(`file:stream`, `file::$DATA`), 장치 이름공간(`\\?\`, `\\.\`), 예약 장치 이름(`CON`, `NUL`, `COM1` 등), 드라이브 상대 경로(`C:file`), 루프백·관리 공유, 끝에 점이나 공백이 있거나 8.3 짧은 이름인 없는 경로 구성 요소는 `INVALID_PATH`로 실패합니다.
- 다른 호스트의 공유 경로(`\\host\share\...`)는 SMB 연결을 열게 되므로 승인 전에 해석하거나 확인하지 않습니다. 쓴 그대로 보호 경로와 대조한 뒤 검토합니다.

PowerShell 명령은 Codex 리비전 `80b88a700e4300022fe1893ecca9b8376d0c85d9`에서 옮긴, 실패 시 닫히는 리터럴 부분 문법을 사용합니다.

- 지원: 일반 단어, `''`를 쓰는 작은따옴표, `$`가 없는 큰따옴표, 제한된 백틱 이스케이프, `;`·`|`·줄바꿈, PowerShell 7의 `&&`·`||`, 파일로의 `>`·`>>`, 스트림 1–6의 `N>`·`N>>`, `*>`·`*>>` 리디렉션. 스트림 병합(`2>&1`)은 검토합니다.
- 검토 필요: 변수와 식(`$`, `@`, `(`, `)`, `{`, `}`), 호출·백그라운드 연산자 `&`, 닷 소싱, 주석, here-string, 붙여 쓴 `-Param:value`, `--%`, `~`, 언어 키워드, 버전에 따라 다른 이스케이프, 유니코드 따옴표·대시 표기.
- cmdlet과 기본 별칭은 대응하는 bash 명령처럼 분류합니다. 읽기(`Get-Content`, `Get-ChildItem`, `Select-String` 등), 쓰기(`Set-Content`, `Add-Content`, `Out-File`, `New-Item`, `Remove-Item` 등), 복사·이동, 네트워크 요청(`Invoke-WebRequest`, `Invoke-RestMethod`)입니다. `-Path`, `-LiteralPath`, `-Destination`, `-FilePath`, `-OutFile`, `X\Y`로 보는 `New-Item -Path X -Name Y`를 포함해 이름 있는 경로 매개변수를 모두 검사합니다.
- 알 수 없는 명령·매개변수, 경로를 붙인 명령, 공급자 경로(`Env:`, `HKLM:`, `FileSystem::`), 경로를 받는 명령으로의 파이프라인 입력, `New-Item`의 심볼릭 링크, Windows PowerShell 5.1에서만 `Invoke-WebRequest` 별칭인 `curl`·`wget`은 검토합니다. 와일드카드 경로는 리디렉션 대상(PowerShell이 `Out-File -FilePath`처럼 해석)을 포함해, 첫 와일드카드 앞 디렉터리까지 보호 경로와 대조한 뒤 검토합니다.
- 네이티브 `git`·`rg`·`curl`·`wget`은 인자에 `"`가 없으면 bash 규칙을 따릅니다.

분석은 기본 명령 표와 Pi의 `-NoProfile` 호출을 전제로 합니다. 동적 매개변수 바인딩, 실행 중 정의한 별칭·함수, 모듈 자동 로드, 공급자 의미는 모델링하지 않으며, 이런 경우는 안전하다고 보지 않고 검토합니다.

## 실행의 한계

- 경로는 문자 그대로 정규화하며 OS 권한 패턴으로 변환하지 않습니다.
- 확장이 켜져 있고 Full Access가 꺼져 있으면 직접 보호 경로와 해석 가능한 명령의 보호 경로를 검토 전에 거부합니다.
- 시작·실행할 때 모든 디렉터리 트리나 하드링크 별칭을 검사하지 않습니다.
- 승인된 인터프리터의 간접 접근과 실행 중 목적지 변경은 격리하지 않습니다. 네트워크 프록시나 OS 샌드박스가 없습니다.
- 확장을 신뢰하면 코드가 있는 디렉터리를 모델 쓰기에서 보호하지만, 다른 위치에서 import할 수 있는 모든 의존성을 보호하지는 않습니다.

현재 검증과 과거 샌드박스 결과를 구분한 [검증표](testing/auto-review-protection.ko.md)를 참고하세요.

## Docker에서 Ollama Cloud 검증

이 패키지를 Ollama Cloud로 확인하던 Docker 이미지와 `verify:docker` 명령은 이전 [pi-codex-auto-review](https://github.com/buYoung/pi-codex-auto-review) 저장소에 남아 있으며 이 저장소에는 포함하지 않았습니다. 기록된 결과는 [검증표](testing/auto-review-protection.ko.md)에 있습니다.
