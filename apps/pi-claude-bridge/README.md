# pi-claude-bridge

**English** | [한국어](README.ko.md)

[![npm version](https://img.shields.io/npm/v/@buyong/pi-claude-bridge)](https://www.npmjs.com/package/@buyong/pi-claude-bridge)

A provider-only Pi extension that runs Claude models through Claude Code and the [Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Tool calls run through Pi's own tools; the extension registers no tools or commands of its own.

`@buyong/pi-claude-bridge` is maintained in the [pi-packages monorepo](https://github.com/buYoung/pi-packages/tree/main/apps/pi-claude-bridge); the npm install command and package name are unchanged. It comes from [elidickinson/pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge), which was originally based on [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi) by Prateek Sunal. Report problems with this distribution in [pi-packages issues](https://github.com/buYoung/pi-packages/issues).

**Billing:** Requests currently count against your regular Claude subscription quota, just like Claude Code. Anthropic [announced and then withdrew](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) a change to how tools built on the Agent SDK, like this one, are billed.

<p>
<a href="https://github.com/buYoung/pi-packages/blob/main/apps/pi-claude-bridge/assets/claude-bridge1.png"><img src="https://raw.githubusercontent.com/buYoung/pi-packages/main/apps/pi-claude-bridge/assets/claude-bridge1.png" width="49%"></a>&nbsp;
<a href="https://github.com/buYoung/pi-packages/blob/main/apps/pi-claude-bridge/assets/claude-bridge2.png"><img src="https://raw.githubusercontent.com/buYoung/pi-packages/main/apps/pi-claude-bridge/assets/claude-bridge2.png" width="49%"></a>
</p>

## Install

Requires Pi 1.0.0 or newer and Node.js 22.19.0 or newer. Package loading and type checks were last confirmed with Pi 1.2.0 and 1.3.0.

```
pi install npm:@buyong/pi-claude-bridge
```

### Before first use

- Sign in to Claude Code with a Claude subscription account, for example by running `claude` once and completing its login. The bridge has no credentials of its own: requests go to Anthropic through Claude Code's login and count against your subscription quota.
- The Agent SDK installs a platform-specific Claude Code binary as a dependency. If it cannot run on your system, set `provider.pathToClaudeCodeExecutable` (see [Configuration](#configuration)).
- Do not export `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` to the Pi process; they redirect Claude Code (see [Known issues](#known-issues)).

### First request

1. Start `pi`, run `/model`, and select a `claude-bridge` model, for example `claude-bridge/claude-haiku-4-5`.
2. Send a short prompt such as `Reply with OK only.` A reply from Claude confirms that the Claude Code login and the bridge work. The request counts against your Claude subscription quota.

If no `claude-bridge` models appear or the request fails, check the Claude Code login and the environment variables above, then see [Debugging](#debugging).

### Update and remove

| Task | Command | Before you run it |
| --- | --- | --- |
| Update to the newest release | `pi update npm:@buyong/pi-claude-bridge` | An exact-version pin stays unchanged even when this prints `Updated`. A project install is updated only with a saved trust decision or `-a`. |
| Pin or change an exact version | `pi install npm:@buyong/pi-claude-bridge@<version>` | Replace `<version>` with a published version. |
| Install for the current project only | `pi install -l npm:@buyong/pi-claude-bridge` | Run it inside a trusted project. |
| Remove | `pi remove npm:@buyong/pi-claude-bridge` | Add `-l` to remove a project install. |

### Files the bridge writes

- `claude-bridge.json` in Pi's agent directory (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`) holds your configuration. The bridge adds the top-level keys `startupNoticeShown`, after showing the first-run notice, and `detectedPlan`, after reading your plan from the Claude Code login. It writes them to this global file even when a project file exists.
- Claude Code session files under `~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR/projects/`) hold the conversation Claude Code resumes from. The bridge rewrites them when it rebuilds a conversation and removes its own temporary sessions, but it does not clean up earlier sessions.
- `claude-bridge-cc-session` entries in the Pi session link a Pi branch to its Claude Code session. They are excluded from model context.
- Debug logs and per-query Claude Code CLI logs are written only when `CLAUDE_BRIDGE_DEBUG=1` is set. The bridge writes diagnostic dumps to `claude-bridge-diag.log` when it hits an unexpected provider state or a prompt-capture failure, even with debugging off. See [Debugging](#debugging) for paths and manual cleanup.

## Choose and use a model

Use `/model` to select any Claude model in pi-ai's catalog, for example `claude-bridge/claude-fable-5-1`, `claude-bridge/claude-opus-5`, or `claude-bridge/claude-haiku-4-5`.

Pi's tools are bridged to Claude Code, and you use them in Pi as usual. The bridge preserves `bash` arguments without adding a default timeout; execution-time limits belong to Pi's tool. Skills and selected-tool guidance are forwarded to Claude Code's system prompt, and steering sent mid-turn reaches Claude at the next tool boundary.

**Thinking options:** With thinking on (choose the level with `/thinking`, or cycle it with Shift+Tab), the bridge requests adaptive thinking with summarized display for Claude models from generation 4.6 onward. Claude 4.5 models keep Claude Code's default handling and effort mapping. For models whose catalog entry does not allow turning thinking off (such as Sonnet 5.5), the bridge never sends a disabled-thinking request. Haiku 5.5 is registered as a model whose thinking cannot be turned off: Pi 1.3.0's catalog allows off, but Claude Code keeps thinking anyway.

**System prompt updates:** Each new query or resumed session receives the current project context, skills, and instructions captured from Pi (the provider uses `snapshot: false`). The MCP tools of a query that is already running are not updated live.

The model list comes from pi-ai's Anthropic catalog. When pi-ai adds a new Claude model, it appears in `/model` after you update Pi, which provides pi-ai; no bridge update is needed. Dated snapshot IDs (for example `claude-opus-4-5-20251101`) are not shown.

**1M context:** Fable 5/5.1, Opus 5.5/5/4.8/4.7, Sonnet 5.5/5, and Haiku 5.5 get 1M context. Opus 4.6 gets 1M only on a Max plan or with Extra Usage, and Sonnet 4.6 only with Extra Usage. The bridge detects a Max plan from the Claude Code login on the first request. Set `provider.plan` or `provider.longContextExtraUsage` as described in [Configuration](#configuration) when detection cannot decide or you want to override it.

### Compaction and branch summaries

Pi, or a summary extension you installed, starts compaction and branch summaries. When a `claude-bridge` model does the summarizing, the bridge serves only that model request; it does not take over the summary or cancel it when it fails. Pi sends its own summary requests, such as compaction and branch summaries, with `cacheRetention: "none"`. Only requests with that marker run in a separate Claude Code process, in the requesting Pi session's working directory, and their results include the token usage Claude Code reports. A request that is already cancelled starts no process, and a cancellation during the run is returned as a cancellation rather than an error. When a summary changes the history, the bridge rebuilds the Claude Code session as it does for other history changes.

## Configuration

Configuration lives in `~/.pi/agent/claude-bridge.json` (global) or in the project's Pi config directory, usually `.pi/claude-bridge.json` (project; merged over global).

Each file must contain a JSON object. Invalid JSON or a non-object root (`null`, an array, or a primitive) is ignored without blocking the provider. In that case the bridge does not overwrite the file to record the startup notice or the detected plan; fix the file to enable those updates again.

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
- `plan`: `"pro"` or `"max"`. `"max"` enables Opus 4.6 with 1M context. When unset, the bridge reads the plan from the Claude Code login during the first request (no extra model request), applies it to the current session, and records it as `detectedPlan` for later sessions. Max and Enterprise map to `"max"` and Pro to `"pro"`. Team plans cannot be told apart, so Team Premium users set `"max"` here. Until a plan is detected, `"pro"` applies. A value set here always wins.
- `longContextExtraUsage`: set to `true` to enable 1M-context models even when they cost money through Extra Usage on your plan. It enables Sonnet 4.6 with 1M on every plan and Opus 4.6 with 1M on Pro. It is not needed for Opus 4.7 or 4.8.
- `forceTwoHundredK`: array of model IDs to pin to 200K context, without the `claude-bridge/` prefix or a `[1m]` suffix (for example `["claude-opus-4-6"]`; default: none). Use it when pi-ai declares a model at 1M but Claude Code will not serve 1M on your plan.
- `autoMemoryEnabled`: enables Claude Code's auto-memory system (default `false`).
- `pathToClaudeCodeExecutable`: path to the `claude` binary. Use it when your system cannot run the musl or glibc binaries bundled with the SDK. With Nix, for example, set it to `"/home/you/.nix-profile/bin/claude"`.

**Extension providers and `models.json`:** Pi's `modelOverrides` in `~/.pi/agent/models.json` do not apply to extension-registered providers such as claude-bridge. To pin a model to 200K, use `provider.forceTwoHundredK`; `contextWindow` and other model fields have no configuration override.

### Claude Code settings and environment

These behaviors are fixed; no configuration key changes them.

- **MCP servers:** The bridge always blocks Claude Code from loading MCP servers on its own from user, project, or plugin settings or from claude.ai. Pi's tools and Pi MCP tools stay available through the bridge's `custom-tools` server.
- **Tool `_meta`:** Every tool on the `custom-tools` server declares `anthropic/maxResultSizeChars: 500000`, so Claude Code passes results to Claude in full up to 500,000 characters. A Pi MCP tool also carries the `_meta` its server declared, unchanged. If the server declares `anthropic/maxResultSizeChars`, its value replaces 500000. The bridge reads this `_meta` from `meta` in `pi.getAllTools()` and from extensions that answer `tool-meta` requests on `pi.events`, such as `@buyong/pi-mcp-adapter`. Pi versions whose `pi.getAllTools()` has no `meta`, such as 1.4.0, need such an extension.
- **Permissions:** The provider runs Claude Code in `dontAsk` permission mode and pre-approves only the bridge's MCP server. The bridge does not request full permission bypass or add the `IS_SANDBOX` value that bypass needs. Tool calls and `@file` expansion outside the working directory were checked on macOS; running as uid 0 in a container was not tested.
- **Environment:** The bridge removes the parent Claude Code's session markers from the child environment and uses the SDK entry point. Variables that block non-essential traffic are set only for the Claude Code child, so Pi's `bash` tool and other extensions keep their environment. Authentication and server-connection variables pass through unchanged, which is why exported Anthropic variables override the child (see [Known issues](#known-issues)).
- **Claude Code settings:** Summary queries, like provider queries, read Claude Code's default settings sources, so `env` and a configured `apiKeyHelper` from your Claude Code user settings apply. Claude Code's instruction files are excluded; Claude receives the context Pi sends instead.
- **Plan notice:** Only when `provider.plan` is unset and the Claude Code login does not reveal your plan (for example, Team), the bridge shows a notice in the TUI on the next bridge request. The recorded `startupNoticeShown` keeps it from repeating.

## Compatibility with other extensions

### Which injection routes reach Claude Code

The bridge forwards Pi's structured parts (project context files, skills, custom prompt, appended instructions, custom prompt sections in `systemPromptOptions.sections`, and explicit prompt and tool guidance) while omitting Pi's generated harness text:

| Route | Reaches Claude Code |
|---|---|
| `before_agent_start` -> `message` | Yes, as literal prompt text in the user turn |
| `context` editing the last user message | Yes, as literal prompt text |
| `--append-system-prompt` | Yes, with Pi's appended instructions |
| `context_with_system` editing the system message | Yes when it wraps Pi's prompt; the turn fails when it replaces Pi's prompt |
| `before_agent_start` -> `systemPromptOptions.sections` | Yes, one `<name>` block per section |
| `systemPromptOptions.promptGuidelines` | Yes, as additional instructions |
| Tool `promptSnippet` and `promptGuidelines` | Yes, for selected tools that are active in the turn |
| `before_agent_start` -> `systemPrompt` | No, dropped |

Tool guidance follows Pi's declared-tool selection, not where a tool was registered: SDK `customTools`, extension tools, and selected built-in tools can all contribute explicit instructions. The bridge copies the guidance, removes repeated rules, and applies the checks described in [System prompt rejections](#system-prompt-rejections). This does not enable live MCP tool refresh; prompt changes apply when the next provider query starts.

Watch for two traps. First, returning `systemPrompt` from `before_agent_start` makes Pi replace the whole system prompt, which discards any `context_with_system` edit in the same run; only one of them reaches the request. Second, system-prompt edits work by *wrapping* Pi's prompt. If an extension replaces Pi's prompt, the bridge has nothing to match, so it refuses the turn rather than send Claude Code a request without your context files, skills, and custom instructions. The error names the closest known prompt and where it diverged.

To add instructions, use `message`, `context`, or a system-message edit that keeps Pi's prompt intact.

### Hooks written for Claude Code

Provider and summary queries run with `disableAllHooks: true`, which turns off user, project, and plugin Claude Code hooks and `statusLine` commands. No bridge setting turns them back on. Pi extension event handling is unchanged.

This flag does not bypass Claude Code's managed policy: under the SDK's policy, hooks enforced by an administrator can still run. Features built into Claude Code are separate from hooks.

### System prompt rejections

Other extensions can change the system prompt. If the text the bridge would forward to Claude Code still contains the opening of Pi's built-in system prompt, or both documentation paths that Anthropic looks for (`docs/custom-provider.md` and `docs/packages.md` in the same prompt), the bridge stops the turn instead of sending it, because Anthropic may otherwise bill these requests as Extra Usage. Fix the source extension before retrying; with `CLAUDE_BRIDGE_DEBUG=1`, the bridge writes the full prompt to the bridge log when this happens.

### Using claude-bridge with @gotgenes/pi-subagents

Add the following to `~/.pi/agent/subagents.json`:

```json
{"promptInheritance": {"claude-bridge": "portable"}}
```

## Debugging

Set `CLAUDE_BRIDGE_DEBUG=1` to enable debug output:

- **Bridge log** at `claude-bridge.log` in Pi's agent directory (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`): provider calls, session sync decisions, tool results, and Claude Code stderr. Change the location with `CLAUDE_BRIDGE_DEBUG_PATH`.
- **Per-query Claude Code CLI logs** at `cc-cli-logs/<timestamp>-<tag>-<seq>.log` beside the bridge log: the subprocess's own debug stream, where the tag is `provider` or `compact-summary`. They show Claude Code's view of session loading, API requests, and tool calls. `CLAUDE_BRIDGE_DEBUG_PATH` also moves this directory beside the relocated bridge log.
- **Diagnostic dumps** at `claude-bridge-diag.log` in Pi's agent directory: unexpected provider-state and prompt-capture failures. These can be written even with debugging off, and `CLAUDE_BRIDGE_DEBUG_PATH` does not move them.

Diagnostic writes are best-effort: a failed write is ignored rather than interrupting the provider or printing over the TUI. Tool-result debug previews are generated only with debugging enabled.

When you report a session-resume failure (for example "No conversation found"), attach the `syncResult:` lines from the bridge log and the matching `cc-cli-logs/` file for the failing query. Review logs before sharing them; they can contain prompts and tool output.

### Manual log cleanup

Logs are never rotated or deleted automatically. Stop the Pi and Claude Code processes that use them, save any diagnostics you need, then remove only the log files. Run the example in a shell with the same `HOME` and path overrides as Pi; it expands `~` and `~/...` in `PI_CODING_AGENT_DIR` the way Pi does:

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

Do not remove `~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR/projects/`) or its `tool-results/` directories as part of log cleanup: earlier sessions can still supply data when the bridge rebuilds a conversation.

## Known issues

**The prompt cache is not always fully reused after a rebuild.** The bridge preserves context attachments, the exact form and key order of tool results, and saved image and large-result files to avoid recaching everything; if Pi edited a tool result, the edited content wins. Even so, with Claude Code 2.1.303 and Haiku 5.5, an ordinary resume without a rebuild rewrites the environment `system` message that Claude Code appends after the first request (about 350 tokens) on the session's second request instead of reading it from the cache. Each later turn also rewrites a small trailing `system` message of about 25 tokens. A rebuild after a process restart, or after conversation that exists only in Pi, costs the same; any extra loss added by the bridge was not measured. Claude Code decides where these messages go and how they are cached, so the bridge cannot remove them, and matching their content shape (block array or string) does not change this. Compaction, tree navigation, and other real history changes, as well as cache expiry, also prevent full reuse.

**A restart does not resume the earlier Claude Code session as is.** The bridge records a `claude-bridge-cc-session` link entry, excluded from model context, on the current Pi branch. On reopening, it reads the earlier Claude Code session only as source material and creates a new Claude Code session UUID. Without the link entry, the file, or a write handle, it rebuilds from the Pi history alone. Earlier sessions and result files are not cleaned up automatically.

**Files Claude Code edits are not carried across a rebuild.** The edit itself survives in the history as a tool call and result; what is lost is the post-edit file snapshot. `@file` expansions *are* carried.

**Exported Anthropic environment variables override the Claude Code child (issue #107).** An exported `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` redirects Claude Code to that gateway, and every turn fails with its authentication error. Unset them for the Pi process.

## Development and release

This section is for contributors working in the `pi-packages` repository.

### Tests

Development needs Node.js 22.19 or later and pnpm 10. Run these commands from the `pi-packages` repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @buyong/pi-claude-bridge typecheck
pnpm --filter @buyong/pi-claude-bridge test:unit
pnpm --filter @buyong/pi-claude-bridge verify --all --report /tmp/cc-bridge-offline.json
pnpm --dir apps/pi-claude-bridge pack
```

Each check exits with code 0 when there are no type errors or unit-test failures. `pack` writes an npm `.tgz` to the app directory and replaces `catalog:` references with real versions. Pi development dependencies come from the workspace catalog, while type checks keep the existing `tsc` and `tsconfig.json`.

The verification CLI is repository-only and not part of the npm package. By default it calls no model and marks live checks as `skipped`; `verify --list` lists the checks. Live checks need a Claude Code subscription login and use quota.

```bash
pnpm --filter @buyong/pi-claude-bridge verify live-smoke --live --report /tmp/cc-bridge-live.json
```

Cache measurement is optional and not part of `verify --all` or `test`; run it only when needed. One run makes about 73 Haiku 5.5 requests. Because of the restart shortfall described in [Known issues](#known-issues), `06-rebuild-cache` reports `fail` and the command exits with 1.

```bash
pnpm --filter @buyong/pi-claude-bridge verify --cache --live --report /tmp/cc-bridge-cache.json
pnpm --filter @buyong/pi-claude-bridge test:cache
```

Live checks use Haiku 5.5 only. If `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or any `CLAUDE_CODE_USE_*` variable is set, they stop with exit code 2 before any request. On success they exit with 0, and the report records versions, source hashes, check results, and the request count. They clean up the temporary working directory and Claude Code sessions, and record hashes instead of request text.

`pnpm --filter @buyong/pi-claude-bridge test` also runs integration tests that call the real API. Set `CLAUDE_BRIDGE_TESTING_ALT_MODEL`, which the alternate-provider check needs, in the app's `.env.test`.

Integration tests spawn real `pi` and Claude Code subprocesses and need write access to `~/.claude`; a sandbox that blocks it makes `--resume` fail with `No conversation found with session ID`.

### Check local loading in isolation

With Node.js and Pi installed and dependencies installed, run from the repository root. The separate settings directory keeps an existing npm installation from loading at the same time.

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

Confirm that Pi starts without extension loading errors and that `/model` lists `claude-bridge/*` models. Successful loading does not prove Claude authentication or a working request. Calling a model in this environment needs separate authentication and can use quota.

### Check the package contents

After installing dependencies, run from the repository root. `tools/package-check/` is a copy of the pi-package-creator package checker and is not part of the npm package. The checker actually loads the extension code, so it runs with your user permissions. It calls no model.

```bash
package_dir="$PWD/apps/pi-claude-bridge"
reports="$(mktemp -d)"
node "$package_dir/tools/package-check/validate-package.mjs" "$package_dir" \
  --expect "$package_dir/tests/fixtures/package-inventory.json" --runtime \
  --report "$reports/package-check.json"
```

A passing run exits with code 0 and the report shows `status: "pass"`: one extension, zero tools, commands, and flags, and no loading diagnostics. `skipped` for `semantic import and bundle inspection` means the checker does not analyze imports statically; it is not a failure. By default the checker uses the Pi installed in the workspace. To check against a globally installed Pi, add `--pi-root "$(npm root -g)/@earendil-works/pi-coding-agent"`.

Check the release archive again from an extracted copy with only production dependencies installed. `npm install` contacts the npm registry. Continue in the same shell to reuse the variables above.

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

The expected result matches the source check. This check confirms that the extension loads with production dependencies only; it does not check Claude authentication or real requests.

### Release and upstream updates

Release from `main` tracking `origin/main`, with clean tracked files and Git index. Changelog entries go in the `UNRELEASED` section of `CHANGELOG.md` (English) and `CHANGELOG.ko.md` (Korean); during the release, `claude -p` drafts any missing entries and records them after you confirm. From the repository root, run the following and select `@buyong/pi-claude-bridge`:

```bash
pnpm release
```

After the changelog draft and version selection, you confirm the commit, tag, and push one by one. To check readiness first without changing files, run `pnpm release:dry-run --app pi-claude-bridge --version <version>`. If you decline or cancel, the remaining steps stop and local changes already made stay in place. The push sends only `main` and the selected `pi-claude-bridge-v<version>` tag. The shared `.github/workflows/pi-packages.yml` at the repository root selects the bridge from the tag, verifies it, publishes to npm with OIDC, and creates the GitHub Release. Stable versions use the `latest` tag; prereleases use their identifier or `next`.

The npm Trusted Publisher must be linked to GitHub user `buYoung`, repository `pi-packages`, and workflow file name `pi-packages.yml`. Enter only the file name in the npm settings, not the full path.

No upstream remote or automatic sync is configured. When needed, pull changes by hand with the [upstream update guide](https://github.com/buYoung/pi-packages/blob/main/apps/pi-claude-bridge/docs/upstream.md).

## License

[MIT](LICENSE). The license notice keeps the copyright of the original author, Eli Dickinson.
