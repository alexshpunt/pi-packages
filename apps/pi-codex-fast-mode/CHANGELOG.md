# Changelog

## [Unreleased]

### New

- Like the Codex CLI, Fast and Ultrafast support now follows the OpenAI Codex model catalog, so models such as `gpt-6.1-terra` can be selected without an extension update. The catalog is read at session start with Pi's `openai-codex` login, or else the `openai` provider's login, and its speed tiers are saved for use when neither lookup works; unlisted models, and sessions with neither a lookup nor saved tiers, use the built-in list.

## [0.4.1] - 2026-10-21

### Improved

- The README quick start explains how to reach the model row in `/codex-fast` and what `/codex-fast status` reports, and the settings section describes the legacy fields written on save and what happens when settings cannot be loaded.

## [0.4.0] - 2026-10-21

### New

- Override speed for the current session with `/codex-fast session` or the first settings row, without changing saved preferences.

### Fixed

- Concurrent settings saves from multiple Pi sessions no longer lose other models' changes.
- Model-list sorting documentation now matches the settings screen.

## [0.3.2] - 2026-10-20

### Improved

- Source code, issues, and release notes moved to the [pi-packages](https://github.com/buYoung/pi-packages) repository.
