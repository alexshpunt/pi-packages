# Changelog

## [Unreleased]

## [0.1.1] - 2026-10-29

### Fixed

- Other bug fixes

## [0.1.0] - 2026-10-28

### New

- MCP servers connect to Pi through this package instead of Pi's built-in MCP support, with the same `mcp.json`, `/mcp` manager, and tool exposures.
- The text limit of MCP results can be set in bytes: a tool's `_meta["pi/maxOutputBytes"]`, else the server's `maxOutputBytes`, else the top-level `maxOutputBytes` of `mcp.json`, else 20 KB.
- Other extensions read the `_meta` of each MCP tool through the `tool-meta` channel of `pi.events`.
