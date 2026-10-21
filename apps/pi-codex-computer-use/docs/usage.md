# Computer Use and Browser Use in Pi

**English** | [한국어](usage.ko.md)

Set up Codex Desktop's installed runtime, choose the surfaces Pi may expose, and run app/browser tasks with runtime approval. This package supplies the MCP bridge, not an automation engine or OS sandbox. Computer Use and Browser Use both default to on.

## Before starting

- Use Node.js 22.19 or later and Pi 1.0.0 or later. Recorded live sessions used Pi 0.99.1; later host compatibility is not implied by that record.
- Install Codex Desktop, sign in with a Codex-capable account, and enable its Computer Use plugin once to prepare the runtime configuration. Codex CLI alone is insufficient.
- For native app work on macOS, grant Accessibility and Screen Recording to `Codex Computer Use.app`.
- For Browser Use, run Google Chrome with the ChatGPT Chrome extension enabled and Desktop's Chrome/Browser plugin/native messaging host installed.
- Keep Desktop running. macOS has live verification records; Windows discovery is implemented but actual Windows execution is unverified. Linux is unsupported.

The package does not read Codex credentials or confirm subscription/login eligibility. You must confirm those requirements yourself. Chrome is the only enabled browser backend; `iab`, `mcpapps`, and Edge are unavailable through this bridge.

## 1. Install and load the package

For a published npm release:

```sh
pi install npm:@buyong/pi-codex-computer-use
pi list
pi
```

For the current source checkout, run from the [pi-packages](https://github.com/buYoung/pi-packages) repository root instead:

```sh
pnpm install
pnpm --filter @buyong/pi-codex-computer-use build
pnpm --filter @buyong/pi-codex-computer-use exec pi -ne -e ./dist/index.js
```

Do not load both paths or overlap with the same extension in `@buyong/pi-codex`. A successfully loaded extension registers `/computer-use` and `/computer-use-check`. Runtime tools appear only when a feature is on and the runtime connects; the footer reports feature/server state. The first connection saves the server's tool catalog. Later sessions with the same runtime and switches register the tools from it and start the server on the first tool call (footer `ready` until then); a different catalog from the started server replaces the registered tools and the saved copy.

## 2. Check and resolve prerequisites

In Pi, run:

```text
/computer-use-check
/computer-use status
```

The first command reports requirements and an ordered setup guide. The second reports current switches, runtime source, and server state without full diagnostics. `/computer-use check` is a compatibility alias for the first command.

| Check status | Meaning |
| --- | --- |
| `ok` | The stated check passed; not proof of a successful automation task |
| `missing` | A required item was not found or a validation failed; follow the reported action |
| `user-owned` | You must confirm account/login or an OS permission |
| `unverified` | Implementation or environment evidence is incomplete; not a pass |
| `skipped` | The check was not run, for example on a simulated platform |

The check inspects installed files and can run the installed runtime's setup/validation commands. It does not itself install or copy the runtime, repair native-host registration, grant privacy permissions, change feature switches, or operate apps/tabs. Those validation scripts belong to the installed Desktop runtime; update Desktop if they fail.

Resolve requirements in this order: Desktop installation and login, native service/permissions if using Computer Use, Chrome extension/native host if using Browser Use, then rerun the check. You can leave an unused surface off even when its prerequisites are missing.

### Where runtime discovery looks

1. The newest enabled Desktop configuration under `CODEX_HOME/plugins/cache/openai-bundled/unified-computer-use/<version>/.mcp.json`.
2. On macOS only, the installed app's `cua_node/manifest.json` when no usable plugin cache is found.

`CODEX_HOME` normally is `~/.codex`; Windows also uses the user's profile directory when appropriate. Windows requires a Desktop-written cache entry and has no app-bundle fallback. The bridge does not write discovery results back to Codex settings.

The macOS app-bundle fallback and cold native-service launch remain unverified. `PI_CODEX_COMPUTER_USE_APP_PATH` can select a nonstandard macOS app bundle. A discovered plan or an `ok` file check does not establish that a private runtime will work after a Desktop update.

## 3. Select only the features you need

```text
/computer-use
```

In the single TUI list, use **↑/↓** to select Computer Use or Browser Use and **Enter/Space** to toggle it. Changes save immediately and restart the runtime; the view and selected row remain. Esc closes the view without undoing saved changes.

For Browser Use only:

```text
/computer-use computer off
/computer-use browser on
```

| Switches | Exposed surfaces | Server/tools |
| --- | --- | --- |
| Both on | `browser,computer` | Shared server; `js` and `js_reset` |
| Computer only | `computer` | Shared server; `js` and `js_reset` |
| Browser only | `browser` | Shared server; `js` and `js_reset` |
| Both off | None | No server; tools hidden |

RPC presents a repeating two-feature picker with Close. Print/JSON mode prints status for the bare command and accepts explicit arguments; it does not render the custom settings screen. Status/check output and runtime discovery, startup, shutdown, and unexpected-exit failures go to stderr.

### Settings file

The path is `<agentDir>/codex-computer-use/settings.json`, where `agentDir` honors `PI_CODING_AGENT_DIR` and defaults to `~/.pi/agent`.

```json
{
  "computerUse": true,
  "browserUse": true
}
```

A missing file uses both defaults without creating a file. An existing file must contain both boolean keys and no unknown keys. Invalid or unreadable settings force both features off for the session; toggle commands refuse to overwrite an invalid file. Fix the file, then reload/restart Pi.

Changing a switch waits for the agent to become idle and restarts the shared server. **The restart clears all REPL variables and app/tab bindings**, including bindings from the other surface. Manual file changes also need reload or restart.

## 4. Run a task and answer approvals

For a first inventory without operations, ask:

```text
Use mcp__cua_repl__js to run await cua.getState(). Summarize the available apps and browsers without operating them.
```

For a bounded browser task, ask:

```text
Use Browser Use to open https://example.com in Chrome, read its accessibility state, and close the tab. Do not submit forms or download anything.
```

The model must follow the runtime documentation returned by the first call. `cua` is already initialized; do not manually import/bootstrap the legacy `@oai/sky` or browser-client flow.

### Entry calls, output, and persistent bindings

- On the first `js` call, or after reset/settings restart, call exactly **one supported entry API**, optionally assigning its result. Do not combine it with other calls, waits, or snapshots. Read the returned documentation/state before continuing.
- For a new page without a requested backend, use `cua.createBrowserTab("chrome", url, { sessionName: "🔎 Task" })`. For an existing tab, use its observed reference through `cua.getTab`; do not invent a tab ID or open a replacement for an ambiguous reference.
- Entry APIs and default `getAXState()` already emit documentation/state. Do not wrap those results in `nodeRepl.write` or `emitImage` again. Use `nodeRepl.write()` for additional values and await `nodeRepl.emitImage()` for additional images. Bare expression values are not printed.
- Reuse established bindings. After reset or server restart, reacquire them. After context compaction, call `await cua.rewriteDocumentation()` before continuing.

The bridge preserves the original runtime description and adds current Pi host guidance to tool declarations. That guidance remains visible with a custom system prompt. It does not rewrite code, retry failures automatically, reset the REPL automatically, or silently substitute an unavailable browser backend.

### What an approval allows

Runtime permission can allow **operating** the selected app/origin, not only reading it. Choose the narrowest persistence you intend:

| Choice | Effect |
| --- | --- |
| **Allow** | This request once |
| **Allow for this session** | Remember for the session, if the runtime offers it |
| **Always allow** | Remember for future requests, if offered; this can change runtime-owned permissions |
| **Cancel** | Dismiss the request; non-tool requests can also offer **Deny** |

Not every request offers every choice. The bridge has no second permission store. Permanent grants were not exercised in the recorded live verification.

Ordinary empty-form `js` execution approvals from `node_repl` follow Codex's user-reviewer auto-approval rule when they are not sensitive and need no user input. Supported ordinary form fields use Pi dialogs. Browser sign-in/QR, email OTP, URL-mode requests, and unsupported forms are declined. Guardian automatic review is not implemented, so Guardian-required prechecks can fail.

Print/JSON mode declines requests that require a user interface. RPC clients must answer the UI requests. Approval wait time is not limited to a fixed 30 seconds by the client; the runtime's own execution timeout still applies.

Esc/caller cancellation sends MCP cancellation and dismisses pending approval. **Already-running JavaScript can continue** until completion or the runtime's timeout. It is not an immediate OS-level kill, and a later call may wait behind it.

## 5. Close task-created resources

Ask the model to close tabs it created and confirm `/computer-use status` after changing switches. The bridge sends one `turn_ended` notification after the agent settles: `Stop` normally and `Interrupt` for an abort. A still-running cancelled call can delay that notification.

Closing or reloading Pi stops the bridge's server process tree, not Desktop's own processes. Resetting the REPL discards bindings; do not treat it as proof that task-created tabs were closed.

Long text, including JSON-RPC error messages and data, is middle-truncated according to the discovered runtime output limit. The fallback is 25,000 approximate tokens, calculated as 100,000 bytes. When saving succeeds, the result identifies a full-output file in the system temporary directory with owner-only permissions. Image blocks are forwarded as image content. The bridge does not automatically delete full-output files.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Runtime unavailable | Install/update Desktop, enable its plugin once, and inspect `/computer-use status`. For a nonstandard macOS app, set `PI_CODEX_COMPUTER_USE_APP_PATH`. |
| `platform-unsupported` | Use a supported platform. Windows implementation still needs actual-machine verification. |
| Invalid settings | Fix the exact two boolean keys at the reported path; reload/restart. |
| Setup script stops at missing `bin/npm` or `bin/npx` | The recorded Desktop build omitted those launchers. The check reports that script as unverified and separately validates the runtime. Do not install/copy launchers into Desktop based on this message. |
| Chrome prerequisite missing | Follow the report to install/start Chrome, enable its ChatGPT extension, or configure Desktop's Chrome/Browser plugin. The bridge does not repair the native host. |
| `Browser is not available: iab` / `mcpapps` | Use Chrome. The Desktop examples describe unavailable Pi backends. |
| No approval UI in print/JSON | Use interactive Pi or a UI-capable RPC client; the tool error explains why the request was declined. |
| Login/OTP/URL request declined | Complete login through the supported app/browser flow yourself; this bridge cannot handle those elicitation surfaces. |
| Cancelled call delays later calls | Let the runtime finish or reach its timeout; it serializes JavaScript calls. Inspect status if the server exited. |
| A call fails with `MCP stdio message exceeds 16777216 bytes` | The response was over 16 MiB and was discarded. The connection stays open; request smaller results. The client does not shorten approval waits. |

Logs rotate at 5 MiB at `<agentDir>/codex-computer-use/mcp.log`. The saved tool catalog is `<agentDir>/codex-computer-use/tool-catalog.json`; deleting it only restores an immediate server start for the next session. Image data is replaced with its base64 character count before JSON encoding. Key-based masking can leave page/app content. Review logs before sharing. Private runtime interfaces and telemetry outside Desktop are not guaranteed by this bridge.

## Recorded verification and remaining gaps

The repository records a 2026-10-05 macOS run with `ChatGPT.app` `26.930.31730` and Pi `0.99.1`: app/browser inventories; Finder once/session/cancel/delayed approvals; RPC abort; Chrome `example.com` origin approval, accessibility state, and close; all four switch combinations; image forwarding and truncation.

The same records cover the single-list settings UI in actual Pi TUI and RPC, Chrome host guidance with custom prompts, and the standalone setup-check command. A successful create/read/close follow-up is one observed run, not a measured reduction in overall failure rate. These are historical records, not live checks performed by following this guide.

Still unverified: Windows execution, cold native-service launch from the app-bundle fallback, Desktop-quit operation, permanent **Always allow**, downloads/uploads, full CDP, WebMCP, and Guardian-dependent flows.

Evidence owners: [host guidance/settings](https://github.com/buYoung/pi-packages/blob/main/docs/verification/computer-use/09-guidance-and-settings.json) and [setup check](https://github.com/buYoung/pi-packages/blob/main/docs/verification/computer-use/10-setup-check.json), alongside the earlier [Computer Use handoffs](https://github.com/buYoung/pi-packages/blob/main/docs/verification/computer-use). OpenAI runtime files are not distributed or relicensed; account eligibility and applicable terms remain your responsibility.

For package releases, use the [repository release process](https://github.com/buYoung/pi-packages#공통-ci와-패키지별-배포).
