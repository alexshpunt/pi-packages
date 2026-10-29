# Changelog

## [Unreleased]

### New

- With Computer Use on, `/computer-use-check` now connects to the native service through a temporary runtime and lists apps once, so the report shows whether Computer Use actually answers. No app is operated, and the session's server is not touched.

### Fixed

- Browser Use tasks no longer fail with `The browser access host is unavailable`. Runtime approval dialogs still apply.

## [0.2.1] - 2026-10-21

### Improved

- The README keeps the setup path and a summary of approval, cancellation, and output limits, and the usage guide owns the detailed rules, including the start conditions and expected result of the browser task.

## [0.2.0] - 2026-10-21

### Improved

- Logs summarize image sizes without serializing the image payloads.
- After the first connection, sessions start the `cua_repl` server on the first tool call instead of at session start, using a saved tool catalog. Sessions and subagents that never use Computer Use no longer keep an idle server, and session startup no longer waits for it.

### Fixed

- Oversized MCP responses now fail the running call with an error instead of waiting indefinitely for cancellation; the connection stays usable.
- Large runtime errors now follow the same output limit and full-output file handling as other results.
- Unexpected server exits update the footer, and runtime startup/shutdown failures are visible in print/JSON mode.
- Shutdown no longer leaves its turn-notification wait timer active after cleanup.

## [0.1.3] - 2026-10-20

### Improved

- Source code, issues, and release notes moved to the [pi-packages](https://github.com/buYoung/pi-packages) repository.
- The npm archive includes the usage guide at `docs/usage.md` and `docs/usage.ko.md` instead of under `docs/computer-use/`.
