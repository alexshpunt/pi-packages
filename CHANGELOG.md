# Changelog

## Unreleased

- Add `background` parameter to AskClaude — runs Claude in the background while pi continues working; result delivered as a follow-up message on completion; footer status shows progress
- Add `defaultBackground` and `defaultIsolated` config options for AskClaude
- Remove skill path aliasing (`.pi/` → `.claude/` round-trip); pass through real paths instead
- Rewrite skills block to reference MCP-bridged read tool (`mcp__custom-tools__read`)
