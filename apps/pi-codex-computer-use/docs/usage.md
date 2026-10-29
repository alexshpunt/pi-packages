# Computer Use and Browser Use in Pi

**English** | [한국어](usage.ko.md)

Set up Codex Desktop's installed runtime, choose which surfaces Pi may expose (Computer Use for native apps, Browser Use for Chrome), and run app/browser tasks with runtime approval. This package supplies the MCP bridge, not an automation engine or OS sandbox. Computer Use and Browser Use both default to on.

## Before starting

- Use Node.js 22.19 or later and Pi 1.0.0 or later. Recorded live sessions used Pi 0.99.1, and Pi 1.0.2 has only a status smoke-check record; neither implies compatibility with other Pi versions.
- Install Codex Desktop, sign in with a Codex-capable account, and enable its Computer Use plugin once to prepare the runtime configuration. Codex CLI alone is insufficient.
- For native app work on macOS, grant Accessibility and Screen Recording to `Codex Computer Use.app`.
- For Browser Use, run Google Chrome with the ChatGPT Chrome extension enabled and Desktop's Chrome/Browser plugin/native messaging host installed.
- Keep Desktop running. macOS has live verification records; Windows discovery is implemented but actual Windows execution is unverified. Linux is unsupported.

The package does not read Codex credentials or confirm subscription/login eligibility. You must confirm those requirements yourself. Chrome is the only enabled browser backend; `iab`, `mcpapps`, and Edge are unavailable through this bridge.

## 1. Install and load the package

Load the extension one way only: either the npm release or the source build, and not alongside `@buyong/pi-codex`, which already includes it.

For a published npm release:

```sh
pi install npm:@buyong/pi-codex-computer-use
pi list
pi
```

`pi list` shows `npm:@buyong/pi-codex-computer-use` and its installed path under `User packages:`.

For the current source checkout, run from the [pi-packages](https://github.com/buYoung/pi-packages) repository root instead:

```sh
pnpm install
pnpm --filter @buyong/pi-codex-computer-use build
pnpm --filter @buyong/pi-codex-computer-use exec pi -ne -e ./dist/index.js
```

`-ne` disables automatic extension discovery, and `-e` loads `./dist/index.js` for that invocation only.

A successfully loaded extension registers `/computer-use` and `/computer-use-check`. Runtime tools appear only when a feature is on and the runtime connects; the footer reports feature/server state.

The first connection saves the server's tool catalog. Later sessions with the same runtime and switches register the tools from it and start the server on the first tool call (footer `ready` until then); a different catalog from the started server replaces the registered tools and the saved copy. If startup fails or the server exits unexpectedly, the footer reports an error and the runtime tools stay hidden until the next restart.

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

When Computer Use is on, the last check, `Computer Use connection`, starts a separate temporary `cua_repl` with only Computer Use, calls `cua.listApps` once, and closes it. `ok` means the native service answered with an app list. The session's own server and its REPL bindings are not touched, and no app is operated. The check accepts only the plain `js` execution approval described in [What an approval allows](#what-an-approval-allows) and declines every other approval request. With Computer Use off, without a runtime, or on a simulated platform, this check is `skipped`.

Resolve requirements in this order: Desktop installation and login, native service/permissions if using Computer Use, Chrome extension/native host if using Browser Use, then rerun the check. You can leave an unused surface off even when its prerequisites are missing.

Browser Use works in Pi. Origin approvals from the Chrome extension still apply, and Chrome's extension and native messaging host are unchanged.

### Where runtime discovery looks

1. The newest enabled Desktop configuration under `CODEX_HOME/plugins/cache/openai-bundled/unified-computer-use/<version>/.mcp.json`.
2. On macOS only, when no usable plugin cache is found: `Contents/Resources/cua_node/manifest.json` in the Codex Desktop app bundle (`ChatGPT.app` or `Codex.app` in `/Applications` or `~/Applications`).

When `CODEX_HOME` is unset or empty, it defaults to `%USERPROFILE%\.codex` on Windows and `~/.codex` elsewhere. Windows requires a Desktop-written cache entry and has no app-bundle fallback. The bridge does not write discovery results back to Codex settings.

The macOS app-bundle fallback and cold native-service launch remain unverified. `PI_CODEX_COMPUTER_USE_APP_PATH` can select a nonstandard macOS app bundle. A discovered plan or an `ok` file check does not establish that a private runtime will work after a Desktop update.

## 3. Select only the features you need

```text
/computer-use
```

In the single TUI list, use **↑/↓** to select Computer Use or Browser Use and **Enter/Space** to toggle it. A change is saved immediately; the bridge then waits for the agent to become idle and restarts the shared server, which **clears all REPL variables and app/tab bindings**, including bindings from the other surface. The view and selected row remain, and Esc closes the view without undoing saved changes. After changing switches, check `/computer-use status`.

For Browser Use only:

```text
/computer-use computer off
/computer-use browser on
```

| Switches | Exposed surfaces | Server/tools |
| --- | --- | --- |
| Both on | `browser,computer` | Shared server; `mcp__cua_repl__js` and `mcp__cua_repl__js_reset` |
| Computer only | `computer` | Shared server; `mcp__cua_repl__js` and `mcp__cua_repl__js_reset` |
| Browser only | `browser` | Shared server; `mcp__cua_repl__js` and `mcp__cua_repl__js_reset` |
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

Manual file changes need `/reload` or a Pi restart.

## 4. Run a task and answer approvals

For a first inventory without operations, ask:

```text
Use mcp__cua_repl__js to run await cua.getState(). Summarize the available apps and browsers without operating them.
```

For a bounded browser task, turn Browser Use on, start Chrome, and ask:

```text
Use Browser Use to open https://example.com in Chrome, read its accessibility state, and close the tab. Do not submit forms or download anything.
```

If the runtime asks permission to operate `https://example.com`, Pi shows an approval dialog; see [What an approval allows](#what-an-approval-allows) before choosing. A successful run reports the page's accessibility state and closes the tab it opened.

The model must follow the runtime documentation returned by the first call. `cua` is already initialized; do not manually import/bootstrap the legacy `@oai/sky` or browser-client flow. The rules the bridge adds for the model are in [Reference: runtime rules the model follows](#reference-runtime-rules-the-model-follows).

### What an approval allows

Runtime permission can allow **operating** the selected app/origin, not only reading it. Choose the narrowest persistence you intend:

| Choice | Effect |
| --- | --- |
| **Allow** | This request once |
| **Allow for this session** | Remember for the session, if the runtime offers it |
| **Always allow** | Remember for future requests, if offered; this can change runtime-owned permissions |
| **Cancel** | Dismiss the request; non-tool requests can also offer **Deny** |

Not every request offers every choice. The bridge has no second permission store. Permanent grants were not exercised in the recorded live verification.

Ordinary empty-form `js` execution approvals from `node_repl` (the runtime's JavaScript REPL that runs `mcp__cua_repl__js` calls) follow Codex's user-reviewer auto-approval rule when they are not sensitive and need no user input. Supported ordinary form fields use Pi dialogs. Browser sign-in/QR, email OTP, URL-mode requests, and unsupported forms are declined. Guardian automatic review is not implemented, so Guardian-required prechecks can fail.

Print/JSON mode declines requests that require a user interface. RPC clients must answer the UI requests. The client sets no fixed timeout on approval waits; the runtime's own execution timeout still applies.

Esc/caller cancellation sends MCP cancellation and dismisses a pending approval, but it does not stop the runtime process. **Already-running JavaScript continues** until it finishes or reaches the runtime's timeout, and the runtime runs JavaScript calls one at a time, so a later call waits until it ends.

## 5. Finish a task

When a task finishes, ask the model to close the tabs it created.

Closing or reloading Pi stops the bridge's server process tree, not Desktop's own processes. Resetting the REPL discards bindings; do not treat it as proof that task-created tabs were closed.

### Turn end and long output

When the agent settles, the bridge sends the runtime one `turn_ended` notification: `Stop` normally and `Interrupt` after an abort. A cancelled call that is still running can delay that notification.

Long text, including JSON-RPC error messages and data, is middle-truncated according to the discovered runtime output limit. The fallback is 25,000 approximate tokens, calculated as 100,000 bytes. When saving succeeds, the result identifies a full-output file in the system temporary directory with owner-only permissions. Image blocks are forwarded as image content. The bridge does not automatically delete full-output files.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Runtime unavailable | Install/update Desktop, enable its plugin once, and inspect `/computer-use status`. For a nonstandard macOS app, set `PI_CODEX_COMPUTER_USE_APP_PATH`. |
| `platform-unsupported` | Use a supported platform. Windows implementation still needs actual-machine verification. |
| Invalid settings | Fix the exact two boolean keys at the reported path; reload/restart. |
| Setup script stops at missing `bin/npm` or `bin/npx` | The recorded Desktop build omitted those launchers. The check reports that script as `unverified` and separately validates the runtime. Do not install/copy launchers into Desktop based on this message. |
| Chrome prerequisite missing | Follow the report to install/start Chrome, enable its ChatGPT extension, or configure Desktop's Chrome/Browser plugin. The bridge does not repair the native host. |
| `Browser is not available: iab` / `mcpapps` | Use Chrome. The Desktop examples describe unavailable Pi backends. |
| No approval UI in print/JSON | Use interactive Pi or a UI-capable RPC client; the tool error explains why the request was declined. |
| Login/OTP/URL request declined | Complete login through the supported app/browser flow yourself; this bridge cannot handle those elicitation surfaces. |
| Cancelled call delays later calls | Let the runtime finish or reach its timeout; it serializes JavaScript calls. Inspect status if the server exited. |
| A call fails with `MCP stdio message exceeds 16777216 bytes` | The response was over 16 MiB and was discarded. The connection and REPL bindings stay available; ask for smaller results, such as specific elements instead of a full snapshot. |

### Logs and saved tool catalog

Logs rotate at 5 MiB at `<agentDir>/codex-computer-use/mcp.log`. The saved tool catalog is `<agentDir>/codex-computer-use/tool-catalog.json`; deleting it only restores an immediate server start for the next session. Image data is replaced with its base64 character count before JSON encoding. Key-based masking can leave page/app content. Review logs before sharing. Private runtime interfaces and telemetry outside Desktop are not guaranteed by this bridge.

## Reference: runtime rules the model follows

The model follows these runtime rules when it calls `mcp__cua_repl__js`; the bridge adds them to the tool declarations. You do not run these calls yourself.

- On the first `js` call, or right after a REPL reset (`mcp__cua_repl__js_reset`) or a settings restart, call exactly **one supported entry API**, optionally assigning its result. Do not combine it with other calls, waits, or snapshots. Read the returned documentation/state before continuing.
- For a new page without a requested backend, use `cua.createBrowserTab("chrome", url, { sessionName: "🔎 Task" })`. For an existing tab, use its observed reference through `cua.getTab`; do not invent a tab ID or open a replacement for an ambiguous reference.
- Entry APIs and default `getAXState()` already emit documentation/state. Do not wrap those results in `nodeRepl.write` or `emitImage` again. Use `nodeRepl.write()` for additional values and await `nodeRepl.emitImage()` for additional images. Bare expression values are not printed.
- Reuse established bindings. After reset or server restart, reacquire them. After context compaction, call `await cua.rewriteDocumentation()` before continuing.

The bridge preserves the original runtime description and adds current Pi host guidance to tool declarations. That guidance remains visible with a custom system prompt. It does not rewrite code, retry failures automatically, reset the REPL automatically, or silently substitute an unavailable browser backend.

## Recorded verification and remaining gaps

The repository records a 2026-10-05 macOS run with `ChatGPT.app` `26.930.31730` and Pi `0.99.1`: app/browser inventories; Finder once/session/cancel/delayed approvals; RPC abort; Chrome `example.com` origin approval, accessibility state, and close; all four switch combinations; image forwarding and truncation.

The same records cover the single-list settings UI in actual Pi TUI and RPC, Chrome host guidance with custom prompts, and the standalone setup-check command. A successful create/read/close follow-up is one observed run, not a measured reduction in overall failure rate. These are historical records, not live checks performed by following this guide.

Still unverified: Windows execution, cold native-service launch from the app-bundle fallback, Desktop-quit operation, permanent **Always allow**, downloads/uploads, full CDP, WebMCP, and Guardian-dependent flows.

Evidence owners: [host guidance/settings](https://github.com/buYoung/pi-packages/blob/main/docs/verification/computer-use/09-guidance-and-settings.json) and [setup check](https://github.com/buYoung/pi-packages/blob/main/docs/verification/computer-use/10-setup-check.json), alongside the earlier [Computer Use handoffs](https://github.com/buYoung/pi-packages/blob/main/docs/verification/computer-use). OpenAI runtime files are not distributed or relicensed; account eligibility and applicable terms remain your responsibility.
