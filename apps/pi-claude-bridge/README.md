# pi-claude-bridge

[![npm version](https://img.shields.io/npm/v/@buyong/pi-claude-bridge)](https://www.npmjs.com/package/@buyong/pi-claude-bridge)

Pi extension that integrates Claude Code via the [Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Originally based on [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi) by Prateek Sunal.

`@buyong/pi-claude-bridge`는 [pi-packages 모노레포](https://github.com/buYoung/pi-packages/tree/main/apps/pi-claude-bridge)에서 유지보수합니다. npm 설치 명령과 패키지명은 그대로입니다. 원본은 [elidickinson/pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge)이며, 이 배포판의 문제는 [pi-packages 이슈](https://github.com/buYoung/pi-packages/issues)에 등록해 주세요.

Claude 모델을 pi에서 사용하는 provider 전용 확장입니다. 도구 호출은 pi의 도구를 통해 실행되며, 별도의 도구나 명령은 등록하지 않습니다.


**FYI:** Anthropic [announced and then unannounced](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) a change to how you would be billed for tools that use the Agent SDK like this one. It currently uses your regular subscription quota just like Claude Code.

<p>
<a href="https://github.com/buYoung/pi-packages/blob/main/apps/pi-claude-bridge/assets/claude-bridge1.png"><img src="https://raw.githubusercontent.com/buYoung/pi-packages/main/apps/pi-claude-bridge/assets/claude-bridge1.png" width="49%"></a>&nbsp;
<a href="https://github.com/buYoung/pi-packages/blob/main/apps/pi-claude-bridge/assets/claude-bridge2.png"><img src="https://raw.githubusercontent.com/buYoung/pi-packages/main/apps/pi-claude-bridge/assets/claude-bridge2.png" width="49%"></a>
</p>

## Install

```
pi install npm:@buyong/pi-claude-bridge
```

Requires Pi 1.0.0 or newer and Node.js 22.19.0 or newer. Package loading and type checks were last confirmed with Pi 1.2.0 and 1.3.0.

### Before first use

- Sign in to Claude Code with a Claude subscription account, for example by running `claude` once and completing its login. The bridge has no credentials of its own: requests go to Anthropic through Claude Code's login and count against your subscription quota.
- The Agent SDK installs a platform-specific Claude Code binary as a dependency. If it cannot run on your system, set `provider.pathToClaudeCodeExecutable` (see [Configuration](#configuration)).
- Do not export `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` to the pi process; they redirect Claude Code (see [Known issues](#known-issues)).

### Files the bridge writes

- `claude-bridge.json` in pi's agent dir (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`) holds your configuration. The bridge adds `startupNoticeShown` to it after showing the first-run notice, and `detectedPlan` after reading your plan from the Claude Code login.
- Claude Code session files under `~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR/projects/`) hold the conversation Claude Code resumes from. The bridge rewrites them when it rebuilds a conversation and removes its own temporary sessions, but it does not clean up earlier sessions.
- `claude-bridge-cc-session` entries in the pi session link a pi branch to its Claude Code session. They are excluded from model context.
- Debug logs are written only when `CLAUDE_BRIDGE_DEBUG=1` is set (see [Debugging](#debugging)).

### Update and remove

```
pi update npm:@buyong/pi-claude-bridge             # update to the newest release
pi install npm:@buyong/pi-claude-bridge@<version>  # pin or change an exact version
pi install -l npm:@buyong/pi-claude-bridge         # install for the current project only
pi remove npm:@buyong/pi-claude-bridge             # remove; add -l for a project install
```

`pi update` leaves an exact-version pin unchanged even when it prints `Updated`; install the new version to move the pin. Project installs need a trusted project, and `pi update` reaches them only with a saved trust decision or `-a`.

## Provider

Use `/model` to select any Claude model in pi-ai's catalog, e.g. `claude-bridge/claude-fable-5-1`, `claude-bridge/claude-opus-5`, or `claude-bridge/claude-haiku-4-5`.

Behind the scenes, pi's tools are bridged to Claude Code but everything works like normal in pi. The bridge preserves bash arguments without adding a default timeout; execution-time limits belong to the pi tool. Skills and selected-tool guidance are forwarded to Claude Code's system prompt, and steering mid-turn reaches Claude at the next tool boundary.

**추론 옵션:** 추론을 켜면 현대 Claude 모델에 adaptive thinking과 summarized display를 명시적으로 전달합니다. 기존 4.5 모델의 처리와 effort 대응은 유지합니다. Sonnet 5.5처럼 카탈로그가 추론 끄기를 지원하지 않는 모델(`thinkingLevelMap.off: null`)에는 disabled를 보내지 않습니다. Haiku 5.5는 Pi 1.3.0 카탈로그가 끄기를 허용해도 Claude Code가 추론을 유지하므로, 브리지가 추론 끄기를 지원하지 않는 모델로 등록합니다.

**시스템 프롬프트 갱신:** provider는 `snapshot: false`를 사용합니다. 새 쿼리를 시작하거나 세션을 resume할 때 pi에서 캡처한 현재 프로젝트 문맥·스킬·지침을 전달합니다. 이미 진행 중인 쿼리의 MCP 도구를 실시간으로 갱신하지는 않습니다.

The model list comes from pi-ai's Anthropic catalog automatically — when pi-ai adds a new Claude model, it appears in `/model` after updating the package, no bridge update needed. Dated snapshot ids (e.g. `claude-opus-4-5-20251101`) are not shown.

**1M Context:** Fable 5/5.1, Opus 5.5/5/4.8/4.7, Sonnet 5.5/5, and Haiku 5.5 get 1M context. Opus 4.6 gets 1M only on a Max plan or with Extra Usage, and Sonnet 4.6 only with Extra Usage. The bridge detects a Max plan from the Claude Code login on the first request; set `provider.plan` and/or `provider.longContextExtraUsage` as described in [Configuration](#configuration) when detection cannot decide or you want to override it.

### 컴팩션과 branch summary

컴팩션과 branch summary는 pi 또는 사용자가 설치한 요약 확장이 담당합니다. 브리지는 이를 대행하거나 실패 시 취소하지 않습니다. `cacheRetention: "none"` 요약 요청만 별도 Claude Code 프로세스로 실행하며, 요청한 pi 세션의 cwd를 사용합니다. 요약 이후의 기록 변경은 기존 rebuild 알림으로 반영합니다.

## Configuration

Config: `~/.pi/agent/claude-bridge.json` (global) or the project Pi config directory, usually `.pi/claude-bridge.json` (project; merged over global).

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
- `plan` — `"pro"` or `"max"`. `"max"` enables Opus 4.6 with 1M context. When unset, the bridge reads the plan from the Claude Code login during the first request (no extra model request), applies it to the current session, and records it as `detectedPlan` for later sessions. Max and Enterprise map to `"max"` and Pro to `"pro"`; Team plans cannot be told apart, so Team Premium users set `"max"` here. Until a plan is detected, `"pro"` applies. A value set here always wins.
- `longContextExtraUsage` — set to `true` to enable 1M context models even if they cost money through Extra Usage on your plan. It enables Sonnet 4.6 with 1M on every plan and Opus 4.6 with 1M on Pro. Not needed for Opus 4.7 or 4.8.
- `forceTwoHundredK` — array of model ids to pin to 200K context (bare id, no `[1m]` suffix). Use if pi-ai declares a model at 1M but Claude Code won't serve it on your plan.
- `autoMemoryEnabled` — enable Claude Code's auto-memory system (default `false`)
- `pathToClaudeCodeExecutable` — path to the `claude` binary. Useful if your OS/filesystem has the SDK's bundled musl/glibc binaries in a place where they can't run. For example, with Nix you can set the binary to e.g. `"/home/you/.nix-profile/bin/claude"`.


Claude Code가 사용자·프로젝트·플러그인 설정이나 claude.ai에서 MCP 서버를 직접 불러오는 경로는 항상 차단합니다. pi가 제공하는 도구와 pi MCP 도구는 브리지의 `custom-tools` 서버를 통해 계속 사용할 수 있습니다.

provider는 `dontAsk` 권한 모드에서 브리지 MCP 서버만 미리 허용합니다. 브리지는 전체 권한 우회 모드를 요청하거나 이를 위한 `IS_SANDBOX` 값을 추가하지 않습니다. macOS에서 도구 호출과 cwd 밖 `@file` 확장을 확인했으며, 컨테이너의 uid 0 실행은 별도로 검증하지 않았습니다.

부모 Claude Code의 세션 표식은 자식 환경에서 제거하고 SDK 진입점을 사용합니다. 비필수 트래픽 차단 값은 CC 자식에만 적용하므로 pi의 bash나 다른 확장의 환경을 바꾸지 않습니다. 인증·서버 연결 환경 변수는 그대로 전달합니다.

요약 쿼리도 기본 CC 설정 소스를 읽어 사용자 설정의 `env`와 설정된 `apiKeyHelper`를 사용합니다. CC의 지침 파일은 제외하고 pi가 전달한 컨텍스트를 사용합니다.

**시작 안내:** `provider.plan`이 없고 Claude Code 로그인으로 요금제를 판별하지 못했을 때(예: Team)만 TUI의 다음 bridge 요청에서 안내합니다. 기존 `startupNoticeShown` 기록으로 같은 안내의 반복을 방지합니다.

**Extension providers and models.json:** pi's `modelOverrides` in `~/.pi/agent/models.json` do not currently apply to extension-registered providers (like claude-bridge). Overriding `contextWindow` or other fields requires editing `src/models.ts` directly — to pin a model to 200K, use `provider.forceTwoHundredK` instead.

## Tests

개발에는 Node.js 22.19 이상과 pnpm 10이 필요합니다. 아래 명령은 `pi-packages` 저장소 루트에서 실행합니다.

```bash
pnpm install --frozen-lockfile
pnpm --filter @buyong/pi-claude-bridge typecheck
pnpm --filter @buyong/pi-claude-bridge test:unit
pnpm --filter @buyong/pi-claude-bridge verify --all --report /tmp/cc-bridge-offline.json
pnpm --dir apps/pi-claude-bridge pack
```

타입 오류와 단위 테스트 실패가 없으면 각 검증은 종료 코드 0으로 끝납니다. `pack`은 앱 디렉터리에 npm 배포용 `.tgz`를 만들며 `catalog:` 참조를 실제 버전으로 변환합니다. Pi 개발 의존성은 워크스페이스 catalog를 사용하되, 타입 검사에는 기존 `tsc`와 `tsconfig.json`을 유지합니다.

검증 CLI는 저장소 전용이며 npm 묶음에는 포함하지 않습니다. 기본 실행은 모델을 호출하지 않고 live 검사를 `skipped`로 구분합니다. `verify --list`로 검사 목록을 볼 수 있습니다. 실제 확인에는 Claude Code 구독 로그인이 필요하며 사용량이 발생합니다.

```bash
pnpm --filter @buyong/pi-claude-bridge verify live-smoke --live --report /tmp/cc-bridge-live.json
```

캐시 측정 검사는 선택 사항이라 `verify --all`과 `test`에 포함되지 않습니다. 필요할 때만 따로 실행합니다. 한 번에 Haiku 5.5 요청이 약 73건 듭니다. 재시작 뒤 부족분은 Known issues의 알려진 한계라 실패로 남습니다.

```bash
pnpm --filter @buyong/pi-claude-bridge verify --cache --live --report /tmp/cc-bridge-cache.json
pnpm --filter @buyong/pi-claude-bridge test:cache
```

live 검사는 Haiku 5.5만 사용합니다. API 키·별도 인증 토큰·클라우드 provider 선택 환경 변수가 있으면 요청 전에 종료 2로 멈춥니다. 성공하면 종료 0이며 보고서에 버전·소스 해시·검사 결과·요청 수가 남습니다. 임시 cwd와 CC 세션을 정리하고 요청 원문 대신 해시를 기록합니다.

`pnpm --filter @buyong/pi-claude-bridge test`는 실제 API를 호출하는 통합 테스트까지 실행합니다. 대체 제공자 검증에 필요한 `CLAUDE_BRIDGE_TESTING_ALT_MODEL`은 앱의 `.env.test`에 설정합니다.

Integration tests spawn real `pi` and Claude Code subprocesses and need write access to `~/.claude` — a sandbox that blocks it makes `--resume` fail with `No conversation found with session ID`.

## 격리된 로컬 로딩 확인

Node.js와 Pi가 설치된 환경에서, 의존성 설치 후 저장소 루트에서 실행합니다. 별도 설정 디렉터리로 기존 npm 설치본과 중복 로딩하지 않습니다.

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

확장 로딩 오류 없이 시작하고 `/model`에 `claude-bridge/*` 모델이 표시되는지 확인합니다. 로딩 성공은 Claude 인증이나 실제 요청 성공을 증명하지 않습니다. 이 환경에서 모델을 호출하려면 별도 인증이 필요하며 사용량이 발생할 수 있습니다.

## 패키지 구성 확인

의존성 설치 후 저장소 루트에서 실행합니다. `tools/package-check/`는 pi-package-creator 패키지 검사기의 사본이며 npm 묶음에는 포함하지 않습니다. 검사기는 확장 코드를 실제로 불러오므로 현재 사용자 권한으로 실행됩니다. 모델은 호출하지 않습니다.

```bash
package_dir="$PWD/apps/pi-claude-bridge"
reports="$(mktemp -d)"
node "$package_dir/tools/package-check/validate-package.mjs" "$package_dir" \
  --expect "$package_dir/tests/fixtures/package-inventory.json" --runtime \
  --report "$reports/package-check.json"
```

종료 코드 0과 보고서의 `status: "pass"`가 정상 결과입니다. 확장 1개, 도구·명령·플래그 0개, 로딩 진단 없음을 확인합니다. `semantic import and bundle inspection`의 `skipped`는 검사기가 import를 정적으로 분석하지 않는다는 표시이며 실패가 아닙니다. 기본 검사 대상은 워크스페이스에 설치된 Pi입니다. 전역 설치된 Pi로 확인하려면 `--pi-root "$(npm root -g)/@earendil-works/pi-coding-agent"`를 붙입니다.

배포 묶음은 운영 의존성만 설치한 추출본으로 다시 확인합니다. `npm install`은 npm 레지스트리에 접속합니다. 같은 셸에서 위 변수를 이어 사용합니다.

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

## 배포와 upstream 갱신

배포는 `origin/main`을 추적하는 `main`에서 실행합니다. 추적 파일과 Git index가 깨끗해야 합니다. 변경 이력은 `CHANGELOG.md`(영문)와 `CHANGELOG.ko.md`(한글)의 `UNRELEASED` 절에 들어가며, 빠진 항목은 배포 중에 `claude -p`가 초안을 만들고 확인을 받아 기록합니다. 저장소 루트에서 다음 명령을 실행하고 `@buyong/pi-claude-bridge`를 선택합니다.

```bash
pnpm release
```

변경 이력 초안과 버전 선택 뒤 커밋·태그·push를 각각 확인합니다. 실행 전 준비 상태는 `pnpm release:dry-run --app pi-claude-bridge --version <버전>`으로 파일을 바꾸지 않고 확인할 수 있습니다. 거절하거나 취소하면 이후 단계는 멈추고 이미 바뀐 로컬 상태는 남습니다. push는 `main`과 선택한 `pi-claude-bridge-v<version>` 태그만 전송합니다. 루트의 공통 `.github/workflows/pi-packages.yml`이 태그로 bridge를 선택하고 검증 후 npm OIDC 배포와 GitHub Release를 만듭니다. 정식 버전은 `latest`, 사전 버전은 해당 식별자 또는 `next`를 사용합니다.

npm Trusted Publisher는 GitHub 사용자 `buYoung`, 저장소 `pi-packages`, workflow 파일명 `pi-packages.yml`에 연결해야 합니다. npm 설정에는 전체 경로가 아닌 파일명만 입력합니다.

upstream remote나 자동 동기화는 설정하지 않습니다. 필요할 때 [upstream 갱신 가이드](https://github.com/buYoung/pi-packages/blob/main/apps/pi-claude-bridge/docs/upstream.md)를 따라 수동으로 가져옵니다.

## Debugging

Set `CLAUDE_BRIDGE_DEBUG=1` to enable debug output:

- **Bridge log** at `claude-bridge.log` in pi's agent dir (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`) — provider calls, session sync decisions, tool results, CC stderr. Override location with `CLAUDE_BRIDGE_DEBUG_PATH`.
- **Per-query CC CLI logs** at `cc-cli-logs/<timestamp>-<tag>-<seq>.log` in the same directory — the subprocess's own debug stream; tag is `provider` or `compact-summary`. Shows CC's view of session loading, API requests, and tool calls.

When filing a bug about a session-resume failure (e.g. "No conversation found"), the most useful attachments are the `syncResult:` lines from the bridge log plus the matching `cc-cli-logs/` file for the failing query.

## Compatibility with other extensions

### Which injection routes reach Claude Code

The bridge forwards pi's structured parts — project context files, skills, custom prompt, appended instructions, custom prompt sections (`systemPromptOptions.sections`), and explicit prompt/tool guidance — while omitting pi's generated harness text:

| Route | Reaches Claude Code |
|---|---|
| `before_agent_start` -> `message` | Yes, as literal prompt text in the user turn |
| `context` editing the last user message | Yes, as literal prompt text |
| `--append-system-prompt` | Yes, with pi's appended instructions |
| `context_with_system` editing the system message | Yes when it wraps pi's prompt; the turn fails when it replaces one |
| `before_agent_start` -> `systemPromptOptions.sections` | Yes, one `<name>` block per section |
| `systemPromptOptions.promptGuidelines` | Yes, as additional instructions |
| Tool `promptSnippet` and `promptGuidelines` | Yes, for selected tools not hidden by the loadout |
| `before_agent_start` -> `systemPrompt` | No, dropped |

Tool guidance follows pi's declared-tool selection, not registration provenance: SDK `customTools`, extension tools, and selected built-in tools can all contribute explicit instructions. Captures copy the guidance, deduplicate repeated rules, and apply the existing prompt-safety checks. This does not enable live MCP tool refresh; prompt changes apply when the next provider query starts.

Two traps. Returning `systemPrompt` from `before_agent_start` makes pi replace the whole system prompt, discarding any `context_with_system` edit in the same run — only one reaches the request. And system-prompt edits work by *wrapping*: replacing pi's prompt leaves the bridge with nothing to match, so it refuses the turn rather than send Claude Code a request missing your context files, skills and custom instructions. The error names the closest known prompt and where it diverged.

To add instructions, use `message`, `context`, or a system-message edit that keeps pi's prompt intact.

### Hooks written for Claude Code

provider와 요약 쿼리는 `disableAllHooks: true`로 사용자·프로젝트·플러그인의 Claude Code hook과 statusLine 실행을 끕니다. 이를 켜는 브리지 설정은 없습니다. pi 확장의 이벤트 처리는 바뀌지 않습니다.

이 flag 설정은 Claude Code의 관리 정책을 우회하지 않습니다. SDK 정책상 관리자가 강제한 hook은 별도로 실행될 수 있습니다. CC에 내장된 기능도 hook과는 별개입니다.

### System prompt rejections

Other extensions can change the system prompt. When the result still contains pi's built-in system prompt text, or the two documentation paths that Anthropic looks for (`docs/custom-provider.md` in the same prompt with `docs/packages.md`), the bridge stops the turn instead of sending it, since Anthropic may otherwise bill these requests as Extra Usage. Fix the source extension before retrying; `CLAUDE_BRIDGE_DEBUG=1` writes the full prompt to the bridge log when this happens.

### Using claude bridge with @gotgenes/pi-subagents

Requires the following in `~/.pi/agent/subagents.json`:

```json
{"promptInheritance": {"claude-bridge": "portable"}}
```

## Known issues

**Rebuild 뒤 캐시가 항상 100% 재사용되지는 않습니다.** 브리지는 맥락 attachment, 도구 결과의 실제 표현·키 순서, 이미지·큰 결과의 저장 파일을 보존해 불필요한 전체 재캐시를 줄입니다. Pi가 도구 결과를 수정했다면 수정된 내용을 우선합니다. 그러나 CC 2.1.303 / Haiku 5.5에서는 rebuild 없는 일반 resume에서도 세션의 두 번째 요청이 첫 요청 끝에 붙는 환경 `system` 메시지(약 350토큰)를 캐시에서 읽지 못하고 다시 기록합니다. 이후 턴마다 끝에 붙는 작은 `system` 메시지도 약 25토큰씩 다시 기록됩니다. 프로세스 재시작이나 Pi에만 있는 중간 대화 뒤의 rebuild도 같은 양이며, 브리지가 더하는 손실은 측정되지 않았습니다. 이 메시지의 배치와 cache_control은 Claude Code가 정하므로 브리지에서 없앨 수 없습니다. 메시지 내용의 형태(블록 배열/문자열)를 맞춰도 달라지지 않습니다. 컴팩션·트리 이동처럼 실제 이력이 바뀌거나 캐시가 만료된 경우도 완전한 재사용을 보장하지 않습니다.

**재시작은 이전 CC 세션을 그대로 resume하지 않습니다.** 현재 Pi 브랜치에 모델 문맥에서 제외되는 `claude-bridge-cc-session` 연결 기록을 남깁니다. 다시 열 때 이전 CC 세션은 내용을 읽는 자료로만 사용하며 새 CC UUID를 만듭니다. 연결 기록·파일·쓰기 핸들이 없으면 Pi 이력만으로 다시 씁니다. 이전 세션과 결과 파일의 자동 정리는 하지 않습니다.

**Files Claude Code edits are not carried across a rebuild.** The edit itself survives in the history as a tool call and result — what's lost is the post-edit file snapshot. `@file` expansions *are* carried.

**Exported Anthropic environment variables override the Claude Code child (issue #107).** An exported `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` redirects Claude Code to that gateway and every turn fails with its auth error. Unset them for the pi process.
