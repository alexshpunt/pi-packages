# pi-claude-code-acp (experimental)

Pi extension that integrates Claude Code via ACP (Agent Client Protocol). Provides two ways to use Claude Code from pi:

1. **Provider** — Offers Opus/Sonnet/Haiku as models that can be selected in pi like usual
2. **AskClaude tool** — pi can use this to delegate tasks or ask questions of Claude Code without having to switch from another model/provider

Behind the scenes, it is automating a real Claude Code session and using MCP to bridge tool calls from Claude Code back to Pi where they are executed.

It a little janky, but actually mostly works! 

This is a heavily reworked fork of [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi), which does a similar thing using the Agent SDK. The advantage of ACP over the Agent SDK or pi's built-in Claude Code emulation is that (I believe) the ACP approach is a fully compliant way to use Claude Max/Pro subscription. It follows the rules: only the real Claude Code touches Anthropic's API and requests are part of a user-driven coding session.

(IANAL and obviously this extension is unofficial and neither endorsed nor supported by Anthropic.)


<a href="screenshot.png"><img src="screenshot.png" width="600"></a>

## Setup

1. Install via git (recommended while experimental):
   ```
   pi install git:github.com/elidickinson/pi-claude-code-acp
   ```

2. Ensure Claude Code is installed and logged in (`claude` CLI works).

3. Reload pi: `/reload`

## Provider

Provider ID: `claude-code-acp`

Use `/model` to select:
- `claude-code-acp/claude-opus-4-6`
- `claude-code-acp/claude-sonnet-4-6`
- `claude-code-acp/claude-haiku-4-5`

Claude Code's built-in tools are disabled. Instead, pi's tools are forwarded through an MCP bridge so all tool calls flow through pi — this means pi sees every tool call in the TUI and maintains control. The tradeoff is that tool names show up as `mcp__pi-tools__Read` etc. instead of native names.

## AskClaude Tool

Available when using any non-claude-code-acp provider. Pi's LLM can delegate to Claude Code for second opinions, analysis, or autonomous tasks.

**Default tool description** (what pi sees):

> **AskClaude** - Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories). Read-only — Claude Code can explore the codebase but not make changes. Prefer to handle straightforward tasks yourself.

You can override this description via config (see below). You can also steer when and how AskClaude gets called by adding instructions to a skill or AGENTS.md — e.g., "Always call AskClaude in read mode to review any complicated feature implementations before the task can be considered complete."

**Parameters:**
- `prompt` — the question or task (include relevant context — Claude Code has no conversation history)
- `mode` — tool access preset:
  - `"read"` (default): read-only codebase access — for review, analysis, research
  - `"none"`: no tools, reasoning only — for general questions, brainstorming
  - `"full"`: read, write, run commands — requires `allowFullMode: true` in config (see below)
- `model` — Claude model to use (e.g., `"opus"`, `"sonnet"`, `"haiku"`, or full ID). Defaults to Claude Code's preference.
- `thinking` — extended thinking effort level:
  - `"off"` — disable extended thinking
  - `"minimal"`, `"low"`, `"medium"` (default), `"high"`, `"xhigh"` — increasing thinking depth

Unlike the provider, AskClaude uses Claude Code's own built-in tools directly (Glob, Read, etc.) — not pi's tools via MCP. This means tool calls happen inside Claude Code and pi only sees the final result. Claude Code's tools are auto-approved (bypass permissions mode). Pre-existing MCP servers from user/project config are suppressed via `--strict-mcp-config`. Pi's skills are forwarded to Claude Code's system prompt.

## Configuration

Config files: `~/.pi/agent/claude-code-acp.json` (global) and `.pi/claude-code-acp.json` (project overrides global).

```json
{
  "askClaude": {
    "enabled": true,
    "name": "AskClaude",
    "label": "Ask Claude Code",
    "description": "Custom tool description override",
    "defaultMode": "full",
    "appendSkills": true
  }
}
```

- `"enabled": false` — disable the AskClaude tool
- `"allowFullMode": true` — enable full mode (read + write + run). Off by default — AskClaude only offers read and none modes unless this is set.
- `"appendSkills": false` — don't forward pi's skills to Claude Code

## Debugging

Set `CLAUDE_ACP_DEBUG=1` to stream the ACP child process's stderr in real-time. Useful for diagnosing opaque errors like "Internal error".

## Limitations

**AskClaude has no shared conversation history.** Each call creates a fresh Claude Code session. The calling LLM must pack relevant context into the prompt string. Persistent sessions are planned (see TODOs).

**Claude Code loads its own skills** from `~/.claude/skills/` and `.claude/skills/` in addition to the pi skills we forward. These are additive — Claude Code may have skills pi doesn't know about.

**Provider and AskClaude use different tool strategies.** The provider disables Claude Code's built-in tools and routes everything through pi via MCP — pi sees all tool calls but tool names appear as `mcp__pi-tools__*`. AskClaude uses Claude Code's native tools directly — faster and cleaner, but pi only sees the final result, not individual tool calls.

**Provider context awkward when switching between providers.** See [Session Sync](#session-sync) below for details on how cross-provider context is handled.

See [docs/acp-meta-reference.md](docs/acp-meta-reference.md) for the full set of available ACP `_meta` options.

## Session Sync

The provider maintains a Claude Code session that mirrors pi's conversation history using [cc-session-io](https://www.npmjs.com/package/cc-session-io). This lets Claude Code resume with full context across turns and provider switches.

**How it works:**

1. **First turn**: Pi's prior messages (from other providers) are translated into Claude Code's JSONL format and written as a seed session. Claude Code then resumes from this session via `--resume`. Up to 20 messages are mirrored (roughly 3-5 full exchanges including tool results).

2. **Continuation turns**: On each subsequent turn, any messages added since the last cursor (e.g., by another provider between our turns) are appended to the JSONL and the session is resumed. Messages from our own provider are skipped since Claude Code already wrote those itself.

3. **Content block translation**: Pi's message types are converted to Anthropic API format — `toolCall` → `tool_use`, `toolResult` → `tool_result`, etc. Thinking blocks are only included when they carry a valid signature from the API; unsigned thinking blocks are dropped because the Anthropic API rejects invalid signatures on resume.

4. **Model selection**: The model is set via CLI args (`extraArgs.model`) on session creation to avoid polluting the JSONL with `/model` command records. Mid-session model changes (when the user switches models between turns) use `unstable_setSessionModel`.

The JSONL file lives at `~/.claude/projects/-<path-hash>/<session-id>.jsonl` and can be resumed directly with `claude --resume <id>`.

## TODOs

- **Markdown rendering** in expanded tool result view. Currently plain text — code blocks, headings, lists render as raw syntax. Use `Markdown` from `@mariozechner/pi-tui` with a `MarkdownTheme` built from pi's theme (see `buildMdTheme` in `extensions/claude-acp.ts`). Requires returning a `Box` instead of `Text` from `renderResult`.
- **Persistent AskClaude session**: reuse the same Claude Code session across calls so context accumulates (e.g., plan a feature → implement → review). Use `_meta.claudeCode.options.resume` to reconnect. Add `/claude:clear` to reset. Reset automatically on session fork/switch. Tradeoff: `allowedTools` is set at session creation and can't change per-call, so a persistent session would need to be created with `full` tools and rely on prompt-level instructions for mode restrictions. This is more concerning when AskClaude is auto-invoked (e.g., a skill that always delegates planning to Claude) rather than explicitly requested by the user — the user may not realize Claude Code has full tool access. Worth considering whether persistent sessions should default to `read` or require explicit opt-in.
- **`/claude-acp config` slash command** for runtime configuration. E.g. `/claude-acp config` opens a settings menu, `/claude-acp config askclaude` jumps to AskClaude settings (mode, appendSkills, etc.). Changes should persist to `~/.pi/agent/claude-code-acp.json`. Currently the only way to change settings is to edit the JSON file and `/reload`.
- **`/claude:btw` command** for ephemeral questions (like Claude Code's own `/btw`): quick question, response displayed but not added to LLM context. Mode `read` by default. Two approaches for showing the full response:
  - **displayOnly message**: `sendMessage` with `display: true` + `displayOnly` detail, filtered from LLM context via `on("context")`. Proven pattern from `extensions/claude-acp.ts`.
  - **Overlay**: `ctx.ui.custom()` with `{ overlay: true }` for a dismissible panel.
  - Stream progress into a widget during execution, clear on next user input via `on("input")`.
