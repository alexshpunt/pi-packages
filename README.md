# pi-claude-code-acp

Pi extension that integrates Claude Code via ACP (Agent Client Protocol). Provides two ways to use Claude Code from pi:

1. **Provider** — route pi's LLM calls through Claude Code (`claude-code-acp` provider)
2. **AskClaude tool** — delegate specific questions or tasks to Claude Code from any provider

## Setup

1. Install:
   ```
   pi install npm:pi-claude-code-acp
   ```

2. Ensure Claude Code is authenticated (`claude` CLI works).

3. Reload pi: `/reload`

## Provider

Provider ID: `claude-code-acp`

Use `/model` to select:
- `claude-code-acp/claude-opus-4-6`
- `claude-code-acp/claude-sonnet-4-6`
- `claude-code-acp/claude-haiku-4-5`

Claude Code handles tool execution internally via ACP. Pi's tools are forwarded through an MCP bridge so Claude Code can call them. Built-in Claude Code tools are disabled in provider mode — all tool calls go through pi.

## AskClaude Tool

Available when using any non-claude-code-acp provider. Pi's LLM can delegate to Claude Code for second opinions, analysis, or autonomous tasks.

**Parameters:**
- `prompt` — the question or task (include relevant context — Claude Code has no conversation history)
- `mode` — tool access preset:
  - `"full"` (default): read, write, run commands — for tasks that need changes
  - `"read"`: read-only codebase access — for review, analysis, research
  - `"none"`: no tools, reasoning only — for general questions, brainstorming

Claude Code's tools are auto-approved (bypass permissions mode).

## Configuration

Config files: `~/.pi/agent/claude-code-acp.json` (global) and `.pi/claude-code-acp.json` (project overrides global).

```json
{
  "askClaude": {
    "enabled": true,
    "name": "AskClaude",
    "label": "Ask Claude Code",
    "description": "Custom tool description override",
    "defaultMode": "full"
  }
}
```

Set `"enabled": false` to disable the AskClaude tool registration.

## Limitations

**AskClaude has no shared context with pi.** Each call creates a fresh Claude Code session. Claude Code doesn't see pi's conversation history, skills, or AGENTS.md. The calling LLM must pack relevant context into the prompt string. Both skills forwarding and persistent sessions are solvable (see TODOs).

**Claude Code may load extra MCP tools** from `~/.claude.json` or `.mcp.json`. Solvable via `_meta.claudeCode.options.extraArgs: { "strict-mcp-config": null }` or explicit `allowedTools` (see TODOs).

See [docs/acp-meta-reference.md](docs/acp-meta-reference.md) for the full set of available ACP `_meta` options.

## TODOs

- **Markdown rendering** in expanded tool result view. Currently plain text — code blocks, headings, lists render as raw syntax. Use `Markdown` from `@mariozechner/pi-tui` with a `MarkdownTheme` built from pi's theme (see `buildMdTheme` in `extensions/claude-acp.ts`). Requires returning a `Box` instead of `Text` from `renderResult`.
- **Persistent AskClaude session**: reuse the same Claude Code session across calls so context accumulates (e.g., plan a feature → implement → review). Use `_meta.claudeCode.options.resume` to reconnect. Add `/claude:clear` to reset. Reset automatically on session fork/switch.
- **`/claude:btw` command** for ephemeral questions (like Claude Code's own `/btw`): quick question, response displayed but not added to LLM context. Mode `read` by default. Two approaches for showing the full response:
  - **displayOnly message**: `sendMessage` with `display: true` + `displayOnly` detail, filtered from LLM context via `on("context")`. Proven pattern from `extensions/claude-acp.ts`.
  - **Overlay**: `ctx.ui.custom()` with `{ overlay: true }` for a dismissible panel.
  - Stream progress into a widget during execution, clear on next user input via `on("input")`.
- **Forward pi's skills and AGENTS.md** to Claude Code via `_meta.systemPrompt.append`. Hook `before_agent_start` or use `ctx.getSystemPrompt()` to capture pi's system prompt, extract the `<available_skills>` block (see `extractSkillsAppend()` in `claude-agent-sdk-pi/index.ts`), and pass via `_meta: { systemPrompt: { append: skillsBlock } }` in `newSession`. This appends to Claude Code's default system prompt — same mechanism the Agent SDK uses.
- **Suppress Claude Code's MCP tools.** Two approaches: (a) pass `_meta: { claudeCode: { options: { extraArgs: { "strict-mcp-config": null } } } }` to ignore MCP servers from config files, (b) use explicit `allowedTools` listing only built-in tool names to exclude `mcp__*` patterns. Both need testing.
