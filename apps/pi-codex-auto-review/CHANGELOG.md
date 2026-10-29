# Changelog

## [Unreleased]

## [0.8.0] - 2026-10-29

### Improved

- MCP review reads each tool's `_meta` (`codex_strict_auto_review`, `codex_sensitive_action`, `codex_requires_user_input`, and the connector and account fields) from extensions that answer the `tool-meta` event channel, such as pi-mcp-adapter. Pi's built-in MCP support does not pass `_meta` on, so with it these flags stay unset.
- The guarded CLI and `createGuardedRuntime()` load Pi's MCP extension themselves, configured by their `mcp` option. `createGuardExtension()` now accepts only `mcp: false`, which leaves MCP calls unreviewed. MCP package approvals are keyed by the registered tool definition instead of the server configuration and version, so MCP approvals saved by earlier versions are reviewed once more.

### Fixed

- Auto Review no longer connects MCP servers or registers `/mcp`. Installed next to pi-mcp-adapter or another MCP extension, it showed a second `/mcp` command and started every MCP server twice. Pi's built-in MCP support, or the extension that replaces it, now connects the servers, and Auto Review reviews each MCP tool call in Pi's `tool_call` hook before Pi runs it.

### Removed

- Answers to approval requests that a running MCP call sends (`elicitation/create`), and the transport checks that bound each sent `tools/call` to its reviewed call. `tool_call` handlers of extensions loaded after Auto Review can now change MCP input after its review.

## [0.7.1] - 2026-10-21

### Improved

- The README and usage guide put the pre-install checks and a first review with its expected result first, list the protected files and accepted policy values, say where saved allow rules are stored, and describe running the guarded CLI from an npm installation.

## [0.7.0] - 2026-10-21

### New

- Guard Pi's Windows `powershell` tool like `bash`: a literal PowerShell grammar ported from Codex, cmdlet and alias path/network classification, rule matching of inner commands that also covers the documented names of aliases, read-only review reuse, and review evidence that names the shell. The guarded tool is registered inactive, so `defaultTools` or `--tools` still decides whether it runs; guarded startup no longer excludes it.

### Fixed

- Preserve MCP cancellation and timeout signals, and release failed or cancelled requests.
- Preserve Pi shell discovery and shell/image settings in ordinary installations and Off mode.
- Windows: stop treating `C:\tmp` as a default writable root (`excludeSlashTmp` has no effect there); map Git Bash, MSYS2, and Cygwin drive paths such as `/c/...` so protected files stay denied, and review other POSIX-absolute operands and WSL paths; normalize `/c/...` and `~\` file-tool paths as Pi does; detect `bash.exe` wrappers and Pi's actual shell for rules; recognize `.git` metadata with backslash separators and CRLF `gitdir` pointers; never resolve another host's share path before approval; keep shell-call evidence structured when a long Windows environment exceeds its budget. When a shell target has no known location, previously approved skill packages no longer skip review and trusted `allow` rules no longer authorize the command.
- Protected paths can no longer be aliased by case or Unicode-normalization differences on macOS and Windows, or on Windows by alternate data streams, device namespaces, reserved device names, drive-relative paths, local administrative shares, trailing dots or spaces, or short names in missing components. Such paths are denied or fail with `INVALID_PATH`; allowed roots still compare exactly.
- Mask complete, size-limited investigation files before excerpts, including multiword `.env` values.
- Avoid creating the review database during help/package loading, and bound in-memory audit history. Clarify startup failures and manual audit-file cleanup.
- Resend a review request up to twice after a dropped connection, overload, or rate limit while the review deadline allows, instead of denying the action on the first transient failure.
- Keep persistent rules, package approvals, and `/approve` settings that another running Pi session saved, and wait up to 1 second for a busy review cache instead of treating it as a miss after 100ms.

## [0.6.0] - 2026-10-20

### Improved

- The guarded CLI and SDK start on Pi 1.0.0 and later. Pi versions other than 1.0.0 and 1.1.0 no longer fail with `UNSUPPORTED_PI`; versions before 1.0.0 still do.
- Source code, issues, and release notes moved to the [pi-packages](https://github.com/buYoung/pi-packages) repository.

### Removed

- The npm archive no longer includes `docs/publishing.md` and `docs/publishing.ko.md`; releases follow the pi-packages repository process.
