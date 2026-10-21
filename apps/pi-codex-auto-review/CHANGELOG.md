# Changelog

## [Unreleased]

### Fixed

- Preserve MCP cancellation and timeout signals, and release failed or cancelled requests.
- Block unsupported PowerShell calls while approval controls are active; preserve Pi shell discovery and shell/image settings in ordinary installations and Off mode.
- Mask complete, size-limited investigation files before excerpts, including multiword `.env` values.
- Avoid creating the review database during help/package loading, and bound in-memory audit history. Clarify startup failures and manual audit-file cleanup.

## [0.6.0] - 2026-10-20

### Improved

- The guarded CLI and SDK start on Pi 1.0.0 and later. Pi versions other than 1.0.0 and 1.1.0 no longer fail with `UNSUPPORTED_PI`; versions before 1.0.0 still do.
- Source code, issues, and release notes moved to the [pi-packages](https://github.com/buYoung/pi-packages) repository.

### Removed

- The npm archive no longer includes `docs/publishing.md` and `docs/publishing.ko.md`; releases follow the pi-packages repository process.
