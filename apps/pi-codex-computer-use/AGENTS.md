# AGENTS.md

<!-- agents-md-generator: v1; doc-type: single_repo -->

## 1. Overview

This extension connects Pi to the Computer Use runtime already installed by Codex Desktop. It does not own the automation engine, OS isolation, runtime installation, or remembered application/browser permissions.

## 2. Ownership Map

### Stable Ownership Boundaries

- **Discovery and launch.** `src/runtime.ts` and `src/platform.ts` decide which installation is usable; `src/connection.ts` launches it with a controlled environment and MCP connection. Do not bundle, copy, download, or replace the private runtime. Check discovery plans, enabled surfaces, and `/computer-use status`, distinguishing unavailable and simulated plans from a working native installation.
- **Connection and tools.** `src/index.ts` replaces the shared connection; `src/tools.ts` registers and executes tools. An old connection's exit must not clear its replacement. Only `js` and `js_reset` are model-facing. Inspect exposure and logged turn metadata across startup, failure, restart, and disabling both surfaces.
- **Runtime approval requests.** `src/elicitation.ts` owns classification, dialogs, and responses; `src/active-call.ts` supplies the owning invocation and signal. Check accept/decline/cancel, non-UI behavior, and persistence metadata at the wire boundary. Automatic acceptance is a narrowly defined empty-form exception.
- **Preferences and diagnostics.** `src/settings.ts` validates the two flags, and `src/commands.ts` changes them after idle. `src/install.ts` and `src/browser-checks.ts` perform a separate diagnostic flow. Compare saved preferences with actual diagnostic results; `missing`, `unverified`, `skipped`, and `user-owned` are not success states.

## 3. Core Behaviors & Patterns

### Discovery and connection

- Only macOS and Windows have supported discovery paths. Search plugin-cache versions in descending numeric order and select the first enabled `cua_repl` entry with a command file. Simulation alone skips that command-file check. Without a cache match, only macOS checks application bundles. An explicit app path replaces default candidates, and a known different bundle ID is rejected.
- Bundle fallback validates the manifest's node, node_repl, and module paths plus the actual launcher and module directory. Find the service app through `SKY_CUA_SERVICE_PATH`, then `CODEX_HOME/computer-use`, then installed `@oai/sky`; do not copy it. Discovery proves file availability, not successful automation. Windows implementation and simulation results are not evidence of a live Windows run.
- `composeEnvironment()` overlays plan values on an allowlisted host environment. It emits `CUA_REPL_ENABLED_SURFACES` in browser/computer order and retains only active `browser`/`sky` entries in trusted-services JSON. Missing or malformed JSON is omitted so the launcher can calculate it. When browsing is enabled, force `BROWSER_USE_AVAILABLE_BACKENDS=chrome` regardless of Desktop's plan. The `@earendil-works/pi-mcp` `StdioTransport` uses `inheritEnv: false`.
- The extension factory registers handlers without launching the runtime. `session_start` loads preferences and starts one shared server when either surface is enabled. MCP initialization advertises form elicitation; failure to list tools closes the client. Discovery/startup failures hide tools and report the problem. Lifecycle failures also report to stderr without UI. An oversized stdio frame, which pi-mcp discards without its request ID, fails the single in-flight bridged call as a tool error and keeps the line-delimited connection open. An unexpected-exit callback may clear state and update the footer only while `connection === opened`.
- Public exposure is the intersection of `EXPOSED_TOOLS`, plan permissions, and the server catalog. Keep `turn_ended` and module-path management internal. Pi cannot remove a previously registered tool, so a disappeared public name is replaced with a hidden error stub rather than left callable against stale state.

### Preferences and execution

- A missing settings file enables both flags by default without creating the file. An existing file must contain only valid boolean `computerUse`/`browserUse` settings. Unreadable or invalid data disables both for the session, and commands refuse to overwrite it.
- Changes wait for idle, save through a unique `wx`, `0600` temporary file and rename, clean up, and restart the server. Saved preference is not rolled back when startup fails. Either flag's change restarts the shared REPL and invalidates JavaScript variables and app/tab bindings. With both flags off, no server is started.
- Tool executions are sequential. Each owns an `ActiveCall`, cleared in `finally` only if it remains the current call. Forward caller cancellation and call/session/thread/turn metadata; automatic-review flags remain false. Model tool calls use MCP timeout `0`, which is separate from the runtime's internal execution timeout.
- Return text, images, and runtime `_meta`. Long text, including JSON-RPC error messages and data, is shortened in the middle using the plan token limit multiplied by four bytes. Attempt to save the complete text to an owner-only temporary file; retain images and either the path notice or a storage-failure notice. The bridge does not automatically delete these output files.
- `TurnTracker` treats `agent_start` through `agent_settled` as one turn and starts external-call turns when needed. Aborted work maps to `Interrupt`; completion/error maps to `Stop`. `agent_end` also catches cancellation when no pre-settle event occurred. Settling clears state before asynchronously sending one `turn_ended`, with a 120000ms timeout. Notification failures are logged.
- Shutdown waits at most 3000ms for pending turn notifications with an unreferenced timer cleared in `finally`, then closes the connection; transport close timeout is 5000ms. MCP cancellation can leave runtime JavaScript running until completion or its own timeout. Do not promise immediate cancellation of OS actions.

### Approval and diagnostic boundaries

- Automatic acceptance requires an actual object schema with empty properties, `tool_name=js`, `connector_id=node_repl`, `codex_approval_kind=mcp_tool_call`, and neither sensitive-action nor user-input flags. A strict-review flag alone does not disable this exception. Combine runtime and active-call signals and handle cancellation before other decisions.
- Decline URL requests, browser login, email OTP, and unsupported forms with a reason. Other supported requests require UI; non-UI execution declines them. Supported text/number/boolean, enum/oneOf, and implemented length/range checks are not full JSON Schema validation. Closing a dialog cancels it. Return session/always choices in `_meta.persist` only when the runtime offered them; this bridge stores no grant. Add decline reasons to the active tool result as well.
- For real plans, `checkPrerequisites()` normally runs Desktop's installed setup script, then node-version/import/node_repl validation. `runSetupScript: false` skips both setup and that runtime validation. Remove temporary import-check links/directories in `finally`. A setup failure caused by a missing launcher is `unverified` and still permits the subsequent runtime checks.
- Chrome checks prefer the newest installed diagnostic script and use file inspection only when no diagnostic exists. Simulation remains unverified/skipped, and unrecognized diagnostic failures remain unverified. Login, subscription, and OS permissions require user confirmation. These executable diagnostics are not equivalent to passive status discovery.
- `BridgeLog` replaces image data with base64 character counts before encoding it as JSON, rotates around 5MiB, shortens long lines, and treats write failures as nonfatal. Recursive masking protects values under suspicious keys, not every raw string or page/application payload. Do not assume a log is safe to publish.

## 4. Conventions

- Preserve server descriptions, annotations, and namespace instructions. Add Pi-specific constraints through `promptGuidelines` and `prepareLoadout`; fill absent schema properties with `{}`. Entry/reset/compaction guidance must reflect enabled backends rather than advertise unsupported Desktop examples.
- Keep unavailable and invalid-configuration states explicit through `RuntimeDiscovery.kind` and `SettingsLoadResult.source`. `BridgeToolResult` reports `isError`, `durationMs`, and optional `cancelled`; a missing connection is not empty success.
- `_meta.persist`, `hook_event_name`, and `x-codex-turn-metadata` are external contracts. Keep their transformations in `responseForChoice`, `hookEventNameFor`, and `buildCallMeta`.
- Use strict ESM TypeScript and `.js` relative imports. Keep process/transport work in `connection.ts`; UI panels call command-owned setters rather than launch children directly.

## 5. Working Agreements

Apply the [root working agreements](../../AGENTS.md). After code changes, run `pnpm typecheck` from this package directory. Report actual Desktop, browser, platform, and remembered-permission verification separately. Material under `../../docs/verification/computer-use` records earlier observations, not the result of the current run.
