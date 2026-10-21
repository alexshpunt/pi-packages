# @buyong/pi-codex-computer-use

**English** | [한국어](README.ko.md)

Operate native apps and Chrome from Pi using the runtime already installed by Codex Desktop. The extension starts Codex's unified `cua_repl` MCP server, forwards its text/images, and brings runtime approval dialogs into Pi.

Use it when Desktop's runtime is available on your machine; it cannot supply that runtime itself. **Computer Use and Browser Use both default to on** and can be switched separately. This is a host bridge, not an automation engine or OS sandbox, and it never bundles, downloads, copies, or redistributes OpenAI's runtime.

## Requirements

| Requirement | What you need |
| --- | --- |
| Node.js | 22.19 or later |
| Pi | 1.0.0 or later. Recorded live checks used 0.99.1; 1.0.2 has only a status smoke-check record. Older versions in the broader manifest peer range are unverified. |
| Codex Desktop | Installed with its Computer Use runtime and signed in to an account with Codex access. The package cannot verify subscription eligibility or login. |
| Computer Use | Desktop's native service. On macOS, grant Accessibility and Screen Recording to `Codex Computer Use.app`. |
| Browser Use | Running Google Chrome, the enabled ChatGPT Chrome extension, and Desktop's Chrome/Browser plugin with native messaging host registration |

Recorded live verification used macOS `ChatGPT.app` (bundle ID `com.openai.codex`) `26.930.31730`. Windows discovery/checks are implemented but **not verified on a Windows machine**. Linux and other platforms are unsupported. Keep Desktop running; desktop-quit operation is unverified.

**Chrome is the only enabled browser backend.** `iab`, `mcpapps`, and Edge examples in Desktop's runtime documentation do not make those backends available in Pi.

## Install and confirm the connection

Install a published release:

```sh
pi install npm:@buyong/pi-codex-computer-use
pi list
pi
```

Append `@<version>` to pin a release. For the current checkout or a package not yet published, use the source instructions below. Do not enable this individual extension alongside `@buyong/pi-codex`.

Inside Pi:

1. Run `/computer-use-check`. Resolve missing requirements for the surfaces you plan to use. `user-owned` needs your confirmation; `unverified` is not a pass. The check can run Desktop's installed validation scripts; it is not an installer or an app/browser task.
2. Run `/computer-use` and leave only the required surfaces on. Changing either switch restarts their shared runtime.
3. Run `/computer-use status` and check for a running server. If it is not running, follow the reported runtime/setup problem before asking the model to operate anything.
4. Ask for an inventory without opening tabs or operating apps:

```text
Use mcp__cua_repl__js to run await cua.getState(). Summarize the available apps and browsers without operating them.
```

The expected first result is an inventory for the enabled surfaces from `mcp__cua_repl__js`. A connection also exposes `mcp__cua_repl__js_reset`. If startup fails or the server exits unexpectedly, the footer reports an error and runtime tools stay hidden until a restart. A running MCP server or a passed prerequisite check is not proof that every app/browser operation will succeed.

For a browser task after that check, follow the [Chrome task and approval instructions](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-computer-use/docs/usage.md#4-run-a-task-and-answer-approvals). The runtime returns API documentation with its first entry call; the model must read it before continuing.

## Change features and inspect status

`/computer-use` opens a single TUI settings list. Use **↑/↓** to select Computer Use or Browser Use and **Enter/Space** to toggle it. Changes save immediately and restart the runtime. The list stays open with the selected row preserved; Esc closes it without undoing saved changes.

| Command | Purpose |
| --- | --- |
| `/computer-use-check` | Prerequisite report and first-use setup guide |
| `/computer-use status` | Current switches, settings path, runtime source, and server state |
| `/computer-use computer on` / `/computer-use computer off` | Change Computer Use |
| `/computer-use browser on` / `/computer-use browser off` | Change Browser Use |
| `/computer-use check` | Compatibility alias for `/computer-use-check` |

RPC uses a repeating two-feature picker with a Close choice. Without UI, the bare command prints status and explicit arguments remain available. Status/check text and runtime discovery, startup, shutdown, and unexpected-exit failures are written to stderr in print/JSON mode.

### Settings file and restart behavior

Settings live at `<agentDir>/codex-computer-use/settings.json`. `agentDir` honors `PI_CODING_AGENT_DIR` and normally is `~/.pi/agent`.

```json
{
  "computerUse": true,
  "browserUse": true
}
```

A missing file uses defaults without creating it. An existing file must contain exactly these two boolean keys. Invalid or unreadable settings force both features off; toggle commands will not overwrite an invalid file. Fix it and run `/reload` or restart Pi.

Switch changes wait for the agent to become idle. A saved switch is a preference, not proof of a successful runtime restart: check status after changing it. Restarting clears REPL variables and app/tab bindings for both surfaces. With both features off, no server starts and its tools are hidden. Manual settings edits need reload or restart.

## Approvals and limits

- The runtime owns remembered permissions. Where offered, Pi shows **Allow**, **Allow for this session**, **Always allow**, and **Cancel**; non-tool requests also offer **Deny**. These permissions allow operating the app/origin, not just reading it.
- An ordinary empty-form `js` execution approval from `node_repl` follows Codex's user-reviewer auto-approval rule. Sensitive requests or requests needing user input are not covered by that rule. This bridge does not implement Guardian automatic review.
- Requests needing user interaction are declined in print/JSON mode. RPC clients must answer Pi UI requests. Supported ordinary forms can use Pi input/select/confirm dialogs; browser sign-in/QR, email OTP, URL-mode requests, and unsupported forms are declined.
- Cancellation sends MCP cancellation, but already-running JavaScript may continue until completion or the runtime's timeout. No immediate OS-level stop is guaranteed.
- An MCP response frame over 16 MiB closes the connection and fails pending calls instead of waiting for cancellation. Tools stay hidden until a restart (for example, `/reload`); reacquire REPL bindings and request smaller results. Approval waits still have no fixed client timeout.
- Long result text, including JSON-RPC errors, is middle-truncated using the runtime output limit. When saving succeeds, the result names an owner-only temporary file with the complete text. These files are not automatically deleted by the bridge.
- Cold service launch from the macOS app-bundle fallback, Windows execution, desktop-quit operation, permanent grants, downloads/uploads, full CDP, and WebMCP remain unverified.
- Desktop updates can change private interfaces. Runtime telemetry outside Codex has not been established; check applicable OpenAI terms.

Logs rotate at 5 MiB under `<agentDir>/codex-computer-use/mcp.log`. Image payloads are logged only as base64 character counts, not image data. Key-based masking does not remove every page/app detail. Inspect and redact logs before sharing.

For a missing runtime, unavailable browser, rejected approval surface, or delayed cancellation, use the [troubleshooting table](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-computer-use/docs/usage.md#troubleshooting). The [full usage guide](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-computer-use/docs/usage.md) owns discovery details, task examples, and recorded verification; the archive includes it at `docs/usage.md`.

## Build and load from source

Run from the [pi-packages](https://github.com/buYoung/pi-packages) repository root:

```sh
pnpm install
pnpm --filter @buyong/pi-codex-computer-use typecheck
pnpm --filter @buyong/pi-codex-computer-use lint
pnpm --filter @buyong/pi-codex-computer-use build
pnpm --filter @buyong/pi-codex-computer-use exec pi -ne -e ./dist/index.js
```

`-ne` disables automatic extension discovery and `-e` loads this extension for one invocation. Desktop setup is still required. The typecheck, lint, and build checks should exit successfully without Desktop. After source changes, rebuild and reload/restart Pi, then run `/computer-use status` again: expect a running server or an explicit runtime error, not hidden tools with a stale `running` footer.

## License

Bridge code: [Apache-2.0](LICENSE), included as `LICENSE` in the archive, with attribution in [NOTICE](NOTICE). OpenAI's proprietary runtime is not included or relicensed. [Implementation and verification records](https://github.com/buYoung/pi-packages/blob/main/docs/verification/computer-use) describe historical checks, not new results from installing the package.
