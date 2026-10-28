# Changelog

## [Unreleased]

## [0.5.0] - 2026-10-28

### New

- Includes Codex memory v2 with `/codex-memory` management, scoped recall and opt-in automatic generation (`@buyong/pi-codex-memory` 0.1.0); requires Pi 1.4.0+ and Node.js 22.19+.
- Fast and Ultrafast support follows the OpenAI Codex model catalog, so models such as `gpt-6.1-terra` can be selected without an extension update (included `@buyong/pi-codex-fast-mode` 0.5.0).

### Improved

- The bundle now requires Pi 1.4.0 or later, up from 1.0.0, because the included memory extension uses Pi 1.4.0 APIs. The other components keep their own compatibility requirements.

## [0.4.1] - 2026-10-21

### Improved

- The README shows what `pi list` prints after installation, and the bundled components include their revised documentation.

## [0.4.0] - 2026-10-21

### New

- Automatic review guards Pi's Windows `powershell` tool like `bash` (included `@buyong/pi-codex-auto-review` 0.7.0).
- `/codex-fast session` overrides speed for the current session without changing saved preferences (included `@buyong/pi-codex-fast-mode` 0.4.0).
- `image_gen` calls show a short summary with a clickable saved path, and clicking a generated image zooms it to fit the terminal height (included `@buyong/pi-codex-image-gen` 0.3.0).

### Improved

- Computer Use starts its `cua_repl` server on the first tool call instead of at session start, so sessions and subagents that never use it no longer keep an idle server (included `@buyong/pi-codex-computer-use` 0.2.0).
- Image generation bounds large backend responses, returns an error for empty or invalid image data, and respects cancellation while loading local references.
- Automatic review's masking no longer slows down on repeated unterminated private-key headers in JSON or on whitespace-heavy non-matches with healthcare-number detection (included `@buyong/redact` 0.1.4).

### Fixed

- Automatic review keeps protected paths denied across Windows path forms and case or Unicode-normalization differences, resends a review after a transient failure, and keeps rules and approvals that another running Pi session saved.
- Computer Use fails oversized MCP responses instead of waiting indefinitely, and reports unexpected server exits and startup failures.
- Fast mode no longer loses other models' changes when several Pi sessions save settings at once.

## [0.3.3] - 2026-10-20

### Improved

- Automatic review's guarded CLI and SDK start on Pi 1.0.0 and later (included `@buyong/pi-codex-auto-review` 0.6.0). Pi versions other than 1.0.0 and 1.1.0 no longer fail with `UNSUPPORTED_PI`; versions before 1.0.0 still do.
- Source code, issues, and release notes moved to the [pi-packages](https://github.com/buYoung/pi-packages) repository.
