# pi-claude-bridge

[![npm version](https://img.shields.io/npm/v/@buyong/pi-claude-bridge)](https://www.npmjs.com/package/@buyong/pi-claude-bridge)

Pi extension that integrates Claude Code via the [Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Originally based on [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi) by Prateek Sunal.

`@buyong/pi-claude-bridge`는 [pi-packages 모노레포](https://github.com/buYoung/pi-packages/tree/main/apps/pi-claude-bridge)에서 유지보수합니다. npm 설치 명령과 패키지명은 그대로입니다. 원본은 [elidickinson/pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge)이며, 이 배포판의 문제는 [pi-packages 이슈](https://github.com/buYoung/pi-packages/issues)에 등록해 주세요.

1. **Provider** — Use Opus/Sonnet/Haiku as models in pi, with all tool calls flowing through pi's TUI
2. **AskClaude tool** — Delegate tasks or questions to Claude Code when using another provider


**FYI:** Anthropic [announced and then unannounced](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) a change to how you would be billed for tools that use the Agent SDK like this one. It currently uses your regular subscription quota just like Claude Code.

<p>
<a href="https://github.com/buYoung/pi-packages/blob/main/apps/pi-claude-bridge/assets/claude-bridge1.png"><img src="https://raw.githubusercontent.com/buYoung/pi-packages/main/apps/pi-claude-bridge/assets/claude-bridge1.png" width="49%"></a>&nbsp;
<a href="https://github.com/buYoung/pi-packages/blob/main/apps/pi-claude-bridge/assets/claude-bridge2.png"><img src="https://raw.githubusercontent.com/buYoung/pi-packages/main/apps/pi-claude-bridge/assets/claude-bridge2.png" width="49%"></a>
</p>

## Install

```
pi install npm:@buyong/pi-claude-bridge
```

Requires pi 0.86.1 or newer.

## Provider

Use `/model` to select any Claude model in pi-ai's catalog, e.g. `claude-bridge/claude-fable-5-1`, `claude-bridge/claude-opus-5`, or `claude-bridge/claude-haiku-4-5`.

Behind the scenes, pi's tools are bridged to Claude Code but everything works like normal in pi. The bridge preserves bash arguments without adding a default timeout; execution-time limits belong to the pi tool. Skills and selected-tool guidance are forwarded to Claude Code's system prompt, and steering mid-turn reaches Claude at the next tool boundary.

The model list comes from pi-ai's Anthropic catalog automatically — when pi-ai adds a new Claude model, it appears in `/model` after updating the package, no bridge update needed. Dated snapshot ids (e.g. `claude-opus-4-5-20251101`) are not shown.

**1M Context:** Fable 5/5.1, Opus 5.5/5/4.8/4.7, and Sonnet 5.5/5 get 1M context. Opus 4.6 gets 1M only on a Max plan or with Extra Usage, and Sonnet 4.6 only with Extra Usage — set `provider.plan` and/or `provider.longContextExtraUsage` as described in [Configuration](#configuration).

## AskClaude Tool

Opt-in: set `askClaude.enabled` to `true` (see [Configuration](#configuration)). Available when using any non-claude-bridge provider. Pi's LLM can delegate tasks to Claude Code and wait for it to answer a question or perform a task. Examples of how to use:

- "Ask Claude to plan a fix"
- "If you get stuck, ask claude for help"
- "Ask claude to review the plan in @foo.md, implement it, then ask an isolated=true claude to review the implementation"
- "Ask claude to poke holes in this theory"

Delegated calls don't read global `CLAUDE.md` files or Claude Code's skill listing, and always get Claude Code's own system prompt.

### Parameters

- **`prompt`** — the question or task for Claude Code
- **`mode`** — `read` (default, read files and search/fetch on web), `none`, or `full` (read+write+bash, disable this mode with `allowFullMode: false` in config)
- **`model`** — `opus` (default), `sonnet`, `haiku`, or a full model ID
- **`thinking`** — effort level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`
- **`isolated`** — when `true`, Claude gets a clean session with no conversation history (default: `false`)

## Configuration

Config: `~/.pi/agent/claude-bridge.json` (global) or the project Pi config directory, usually `.pi/claude-bridge.json` (project; merged over global).

```json
{
  "askClaude": {
    "enabled": true,
    "allowFullMode": true,
    "defaultIsolated": false,
    "description": "Custom tool description override"
  },
  "provider": {
    "plan": "max",
    "longContextExtraUsage": false,
    "strictMcpConfig": true,
    "pathToClaudeCodeExecutable": "/home/you/.nix-profile/bin/claude"
  }
}
```

`askClaude`:
- `enabled` — register the AskClaude tool (default `false`). If it's unset, the startup notice below points this out once.
- `name` — override the tool's pi-side name (default `"AskClaude"`)
- `label` — override the TUI label (default `"Ask Claude Code"`)
- `description` — override the tool description. Default when `allowFullMode: true`: *"Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself."*
- `defaultMode` — `"read"` (default), `"none"`, or `"full"`
- `defaultIsolated` — start each call in a fresh session (default `false`)
- `allowFullMode` — allow `mode: "full"`; set `false` to lock it out
- `appendSkills` — forward pi's skills block into the system prompt (default `true`)

`provider`:
- `plan` (default `"pro"`) — set to `"max"` if you have a Max (or Team Premium/Enterprise) Anthropic plan. This enables Opus with 1M context.
- `longContextExtraUsage` — set to `true` to enable 1M context models even if they cost money through Extra Usage on your plan. It enables Sonnet 4.6 with 1M on every plan and Opus 4.6 with 1M on Pro. Not needed for Opus 4.7 or 4.8.
- `forceTwoHundredK` — array of model ids to pin to 200K context (bare id, no `[1m]` suffix). Use if pi-ai declares a model at 1M but Claude Code won't serve it on your plan.
- `strictMcpConfig` — block MCP servers from `~/.claude.json` / `.mcp.json` (default `true`). Cloud MCP (Gmail/Drive via claude.ai OAuth) is always blocked.
- `autoMemoryEnabled` — enable Claude Code's auto-memory system (default `false`)
- `pathToClaudeCodeExecutable` — path to the `claude` binary. Useful if your OS/filesystem has the SDK's bundled musl/glibc binaries in a place where they can't run. For example, with Nix you can set the binary to e.g. `"/home/you/.nix-profile/bin/claude"`.


**Startup notice:** the first session lists `provider.plan` and `askClaude.enabled` if unset, then records `startupNoticeShown` in the global config so it doesn't nag again.

**Extension providers and models.json:** pi's `modelOverrides` in `~/.pi/agent/models.json` do not currently apply to extension-registered providers (like claude-bridge). Overriding `contextWindow` or other fields requires editing `src/models.ts` directly — to pin a model to 200K, use `provider.forceTwoHundredK` instead.

## Tests

개발에는 Node.js 22.19 이상과 pnpm 10이 필요합니다. 아래 명령은 `pi-packages` 저장소 루트에서 실행합니다.

```bash
pnpm install --frozen-lockfile
pnpm --filter @buyong/pi-claude-bridge typecheck
pnpm --filter @buyong/pi-claude-bridge test:unit
pnpm --dir apps/pi-claude-bridge pack
```

타입 오류와 단위 테스트 실패가 없으면 각 검증은 종료 코드 0으로 끝납니다. `pack`은 앱 디렉터리에 npm 배포용 `.tgz`를 만들며 `catalog:` 참조를 실제 버전으로 변환합니다. Pi 개발 의존성은 워크스페이스 catalog를 사용하되, 타입 검사에는 기존 `tsc`와 `tsconfig.json`을 유지합니다.

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

## 배포와 upstream 갱신

배포는 `origin/main`을 추적하는 `main`에서 실행합니다. 추적 파일과 Git index가 깨끗해야 하며 `CHANGELOG.md`의 `UNRELEASED`에 변경 내용을 먼저 기록해야 합니다. 저장소 루트에서 다음 명령을 실행합니다.

```bash
pnpm --filter @buyong/pi-claude-bridge release
```

버전 선택 뒤 커밋·태그·push를 각각 확인합니다. 거절하거나 취소하면 이후 단계는 멈추고 이미 바뀐 로컬 상태는 남습니다. push는 `main`과 선택한 `pi-claude-bridge-v<version>` 태그만 전송합니다. 루트의 공통 `.github/workflows/pi-packages.yml`이 태그로 bridge를 선택하고 검증 후 npm OIDC 배포와 GitHub Release를 만듭니다. 정식 버전은 `latest`, 사전 버전은 해당 식별자 또는 `next`를 사용합니다.

npm Trusted Publisher는 GitHub 사용자 `buYoung`, 저장소 `pi-packages`, workflow 파일명 `pi-packages.yml`에 연결해야 합니다. npm 설정에는 전체 경로가 아닌 파일명만 입력합니다.

upstream remote나 자동 동기화는 설정하지 않습니다. 필요할 때 [upstream 갱신 가이드](https://github.com/buYoung/pi-packages/blob/main/apps/pi-claude-bridge/docs/upstream.md)를 따라 수동으로 가져옵니다.

## Debugging

Set `CLAUDE_BRIDGE_DEBUG=1` to enable debug output:

- **Bridge log** at `claude-bridge.log` in pi's agent dir (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`) — provider calls, session sync decisions, tool results, CC stderr. Override location with `CLAUDE_BRIDGE_DEBUG_PATH`.
- **Per-query CC CLI logs** at `cc-cli-logs/<timestamp>-<tag>-<seq>.log` in the same directory — the subprocess's own debug stream; tag is `provider` or `askclaude`. Shows CC's view of session loading, API requests, and tool calls.

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

Tool guidance follows pi's declared-tool selection, not registration provenance: SDK `customTools`, extension tools, and selected built-in tools can all contribute explicit instructions. Captures copy the guidance, deduplicate repeated rules, and apply the existing prompt-safety checks. This does not enable live MCP tool refresh or change Claude Code's system-prompt snapshot policy.

Two traps. Returning `systemPrompt` from `before_agent_start` makes pi replace the whole system prompt, discarding any `context_with_system` edit in the same run — only one reaches the request. And system-prompt edits work by *wrapping*: replacing pi's prompt leaves the bridge with nothing to match, so it refuses the turn rather than send Claude Code a request missing your context files, skills and custom instructions. The error names the closest known prompt and where it diverged.

To add instructions, use `message`, `context`, or a system-message edit that keeps pi's prompt intact.

### Hooks written for Claude Code

`~/.claude/settings.json` hooks fire inside bridge turns, so a hook injecting Claude-specific guidance duplicates what pi's extensions already provide. pi sets `PI_CODING_AGENT=true` for child processes, including the Claude Code child; a hook can skip itself on that:

```sh
[ -n "$PI_CODING_AGENT" ] && exit 0
```

Hooks do not fire on the compact-summary side query.

### System prompt rejections

Other extensions can change the system prompt. When the result still contains pi's built-in system prompt text, or the two documentation paths that Anthropic looks for (`docs/custom-provider.md` in the same prompt with `docs/packages.md`), the bridge stops the turn instead of sending it, since Anthropic may otherwise bill these requests as Extra Usage. Fix the source extension before retrying; `CLAUDE_BRIDGE_DEBUG=1` writes the full prompt to the bridge log when this happens.

### Using claude bridge with @gotgenes/pi-subagents

Requires the following in `~/.pi/agent/subagents.json`:

```json
{"promptInheritance": {"claude-bridge": "portable"}}
```

## Known issues

**A session rebuild re-sends the whole conversation.** The bridge rewrites Claude Code's session from pi's history whenever the two diverge — after an abort, `/compact`, tree navigation, an API error, or on returning to a session — and the next request usually misses the prompt cache for everything past the system prompt. Abort-heavy sessions cost noticeably more.

**Files Claude Code edits are not carried across a rebuild.** The edit itself survives in the history as a tool call and result — what's lost is the post-edit file snapshot. `@file` expansions *are* carried.

**System prompt changes mid-session may not reach the model.** The bridge keeps Claude Code's default prompt recording: project context (AGENTS.md/CLAUDE.md), skills, and extension-written instructions are captured on the first request and reused on resume. This keeps the cached prefix stable, but later changes may not take effect until a rebuild or compaction. Start a new session if updated instructions must take effect immediately.

**Exported Anthropic environment variables override the Claude Code child (issue #107).** An exported `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` redirects Claude Code to that gateway and every turn fails with its auth error. Unset them for the pi process.
