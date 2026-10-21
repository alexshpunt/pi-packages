# Changelog

## [Unreleased]

### Fixed

- Oversized MCP responses now fail the running call with an error instead of waiting indefinitely for cancellation; the connection stays usable.
- Large runtime errors now follow the same output limit and full-output file handling as other results.
- Unexpected server exits update the footer, and runtime startup/shutdown failures are visible in print/JSON mode.
- Shutdown no longer leaves its turn-notification wait timer active after cleanup.

### Improved

- Logs summarize image sizes without serializing the image payloads.

## [0.1.3] - 2026-10-20

### Improved

- Source code, issues, and release notes moved to the [pi-packages](https://github.com/buYoung/pi-packages) repository.
- The npm archive includes the usage guide at `docs/usage.md` and `docs/usage.ko.md` instead of under `docs/computer-use/`.
