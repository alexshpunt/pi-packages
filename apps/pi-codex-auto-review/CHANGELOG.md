# Changelog

## [Unreleased]

### New

- Guard Pi's Windows `powershell` tool like `bash`: a literal PowerShell grammar ported from Codex, cmdlet and alias path/network classification, rule matching of inner commands that also covers the documented names of aliases, read-only review reuse, and review evidence that names the shell. The guarded tool is registered inactive, so `defaultTools` or `--tools` still decides whether it runs; guarded startup no longer excludes it.

### Fixed

- Preserve MCP cancellation and timeout signals, and release failed or cancelled requests.
- Preserve Pi shell discovery and shell/image settings in ordinary installations and Off mode.
- Windows: stop treating `C:\tmp` as a default writable root (`excludeSlashTmp` has no effect there); map Git Bash, MSYS2, and Cygwin drive paths such as `/c/...` so protected files stay denied, and review other POSIX-absolute operands and WSL paths; normalize `/c/...` and `~\` file-tool paths as Pi does; detect `bash.exe` wrappers and Pi's actual shell for rules; recognize `.git` metadata with backslash separators and CRLF `gitdir` pointers; never resolve another host's share path before approval. When a shell target has no known location, previously approved skill packages no longer skip review and trusted `allow` rules no longer authorize the command.
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
