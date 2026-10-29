# @buyong/pi-codex-computer-use

**English** | [한국어](README.ko.md)

Operate native apps and Chrome from Pi using the runtime already installed by Codex Desktop. The extension starts Codex's unified `cua_repl` MCP server, forwards its text/images, and brings runtime approval dialogs into Pi.

Use it when Desktop's runtime is available on your machine; it cannot supply that runtime itself. **Computer Use and Browser Use both default to on** and can be switched separately. The extension is a bridge to that runtime, not an automation engine or OS sandbox. It does not bundle, download, copy, or redistribute OpenAI's runtime.

## Requirements

| Requirement | What you need |
| --- | --- |
| Node.js | 22.19 or later |
| Pi | 1.0.0 or later. Recorded live checks used 0.99.1; 1.0.2 has only a status smoke-check record. Older versions in the broader manifest peer range are unverified. |
| Codex Desktop | Installed, signed in to an account with Codex access, and with its Computer Use plugin enabled at least once so that the runtime configuration exists. The package cannot verify subscription eligibility or login. |
| Computer Use | Desktop's native service. On macOS, grant Accessibility and Screen Recording to `Codex Computer Use.app`. |
| Browser Use | Running Google Chrome, the enabled ChatGPT Chrome extension, and Desktop's Chrome/Browser plugin with native messaging host registration |

Recorded live verification used macOS `ChatGPT.app` (bundle ID `com.openai.codex`) `26.930.31730`. Windows discovery/checks are implemented but **not verified on a Windows machine**. Linux and other platforms are unsupported. Keep Desktop running; desktop-quit operation is unverified.

**Chrome is the only enabled browser backend.** `iab`, `mcpapps`, and Edge examples in Desktop's runtime documentation do not make those backends available in Pi.

## Install and confirm the connection

If you already use `@buyong/pi-codex`, it includes this extension; do not install or enable it separately. Otherwise, install a published release (append `@<version>` to pin one):

```sh
pi install npm:@buyong/pi-codex-computer-use
pi list
pi
```

`pi list` shows `npm:@buyong/pi-codex-computer-use` and its installed path under `User packages:`.

To run unreleased changes, [build and load from source](#build-and-load-from-source).

Inside Pi:

1. Run `/computer-use-check`. Resolve missing requirements for the features you plan to use (Computer Use, Browser Use, or both). Items marked `user-owned` (account, login, or OS permissions) need your own confirmation; `unverified` is not a pass. The check can run Desktop's installed validation scripts and, with Computer Use on, lists apps once through a temporary runtime connection. It does not install anything or operate apps or browsers.
2. Run `/computer-use` and leave on only the features you need: **↑/↓** selects a feature, **Enter/Space** toggles it, and **Esc** closes the list. Changing either switch restarts the shared runtime once the agent is idle, which clears REPL variables and app/tab bindings.
3. Run `/computer-use status` and check for a running server. If it is not running, follow the reported runtime/setup problem before asking the model to operate anything.
4. Ask for an inventory without opening tabs or operating apps:

```text
Use mcp__cua_repl__js to run await cua.getState(). Summarize the available apps and browsers without operating them.
```

The expected first result is an inventory of the enabled features from `mcp__cua_repl__js`. A connection also exposes `mcp__cua_repl__js_reset`. A running MCP server or a passed prerequisite check is not proof that every app/browser operation will succeed.

After the first connection, later sessions register the tools from a saved catalog and start the server on the first tool call; the footer shows `ready` until then. If startup fails or the server exits unexpectedly, the footer reports an error and runtime tools stay hidden until a restart.

For a browser task after that check, follow the [Chrome task and approval instructions](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-computer-use/docs/usage.md#4-run-a-task-and-answer-approvals). The runtime returns API documentation with its first entry call; the model must read it before continuing.

## Change features and inspect status

`/computer-use` opens a single TUI settings list. Use **↑/↓** to select Computer Use or Browser Use and **Enter/Space** to toggle it. Esc closes the list without undoing saved changes.

| Command | Purpose |
| --- | --- |
| `/computer-use-check` | Prerequisite report and first-use setup guide |
| `/computer-use status` | Current switches, settings path, runtime source, and server state |
| `/computer-use computer on` / `/computer-use computer off` | Change Computer Use |
| `/computer-use browser on` / `/computer-use browser off` | Change Browser Use |
| `/computer-use check` | Compatibility alias for `/computer-use-check` |

A change is saved at once to `<agentDir>/codex-computer-use/settings.json` (`agentDir` is `PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`). It waits for the agent to become idle and then restarts the shared runtime, which **clears REPL variables and app/tab bindings for both features**. A saved switch does not prove that the restart worked, so run `/computer-use status` afterwards. With both features off, no server starts and the runtime tools are hidden.

The [settings section of the usage guide](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-computer-use/docs/usage.md#3-select-only-the-features-you-need) covers the file format, what happens with an invalid file, and how RPC and print/JSON mode handle these commands.

## Before you approve or run tasks

- An approval lets the runtime operate the app or website origin, not only read it. Pi shows **Allow**, **Allow for this session**, **Always allow**, and **Cancel** where the runtime offers them; the runtime stores remembered permissions. An ordinary `js` execution request from `node_repl` with an empty form, nothing sensitive, and no user input is approved automatically. Browser sign-in/QR, email OTP, URL-mode, and unsupported form requests are declined. See [What an approval allows](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-computer-use/docs/usage.md#what-an-approval-allows).
- Print/JSON mode declines requests that need user interaction. RPC clients must answer Pi UI requests.
- Cancellation does not stop JavaScript that is already running; it continues until it finishes or reaches the runtime's timeout.
- Results longer than the runtime output limit (100,000 bytes, about 25,000 tokens, when the runtime does not report one) are shortened in the middle. When saving succeeds, the result names an owner-only file in the system temporary directory with the complete text; the bridge does not delete these files. Logs under `<agentDir>/codex-computer-use/` can contain page and app content; review them before sharing. Limits and paths are in [Turn end and long output](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-computer-use/docs/usage.md#turn-end-and-long-output) and [Logs and saved tool catalog](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-computer-use/docs/usage.md#logs-and-saved-tool-catalog).
- Cold service launch from the macOS app-bundle fallback, Windows execution, desktop-quit operation, permanent grants, downloads/uploads, full CDP, and WebMCP remain unverified.
- Desktop updates can change private interfaces. Runtime telemetry outside Codex has not been established; check applicable OpenAI terms.

For a missing runtime, unavailable browser, rejected approval surface, or delayed cancellation, use the [troubleshooting table](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-computer-use/docs/usage.md#troubleshooting). The [full usage guide](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-computer-use/docs/usage.md) owns discovery details, task examples, and recorded verification; the archive includes it at `docs/usage.md`.

## Build and load from source

Run from the [pi-packages](https://github.com/buYoung/pi-packages) repository root. The typecheck, lint, and build steps work without Codex Desktop; the last command, which runs the extension, needs the Desktop setup in [Requirements](#requirements).

```sh
pnpm install
pnpm --filter @buyong/pi-codex-computer-use typecheck
pnpm --filter @buyong/pi-codex-computer-use lint
pnpm --filter @buyong/pi-codex-computer-use build
pnpm --filter @buyong/pi-codex-computer-use exec pi -ne -e ./dist/index.js
```

`-ne` disables automatic extension discovery and `-e` loads this extension for one invocation. The typecheck, lint, and build steps should exit successfully. After source changes, rebuild and reload/restart Pi, then run `/computer-use status` again: expect a running server or an explicit runtime error, not hidden tools with a stale `running` footer.

For package releases, use the [repository release process](https://github.com/buYoung/pi-packages#shared-ci-and-per-package-releases).

## License

Bridge code: [Apache-2.0](LICENSE), included as `LICENSE` in the archive, with attribution in [NOTICE](NOTICE). OpenAI's proprietary runtime is not included or relicensed. [Implementation and verification records](https://github.com/buYoung/pi-packages/blob/main/docs/verification/computer-use) describe historical checks, not new results from installing the package.
