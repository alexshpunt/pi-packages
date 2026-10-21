# AGENTS.md

<!-- agents-md-generator: v1; doc-type: single_repo -->

## 1. Overview

This package exposes Devin accounts as a Pi model provider and supplies a source-only CLI for protocol verification. Local contract checks, live-service observations, and parity with the original CLI are separate forms of evidence.

## 2. Ownership Map

### Stable Ownership Boundaries

- **Protocol transport.** Change wire encoding, compression, deadlines, and authentication-error handling in `src/core/protocol/transport.ts`. Both Pi and the CLI use it through `DevinClient`. Check the auth-policy, compression, HTTP, and protocol tests at the actual dispatch/cleanup boundary rather than duplicating transport in a consumer.
- **Login.** `src/core/auth/login.ts` owns `loginAccount()`. `src/cli/auth-command.ts` and `src/pi/auth.ts` adapt interaction and storage. Keep one-time code exchange separate from UI and persistence, and do not automatically transfer authentication between Pi and CLI stores. Account-login, CLI-login, and Pi-auth tests cover these adapters.
- **Model catalog.** `src/core/models/variants.ts` classifies variants; `src/pi/models.ts` projects Pi models, IDs, capabilities, and snapshots. Follow thinking level to exact UID to final `chatModelUid`. Keep CLI alias selection separate. Check model, model-source, model-store, and Pi-provider tests together.
- **Pi execution.** `index.ts`, `src/pi/extension.ts`, and `provider.ts` connect the provider. `messages.ts`/`stream.ts` translate history and events; `lifecycle.ts` owns run budgets and branch identity. Pi owns tool execution and upper-level retries; do not import the CLI's `runConversation()` loop. Use Pi-integration, Pi-runtime, and Pi-lifecycle tests.
- **Fusion.** `src/pi/models.ts` projects Fusion, `fusion-settings.ts` stores the global selection, and `fusion-command.ts` exposes it. `sidekick.ts` owns tool/report behavior; `sidekick-runtime.ts` owns the child Pi RPC process. Check the child-recursion guard, separation from the lead's lifecycle/IDs, and one-time report delivery.
- **Settings and usage.** `/devin` is implemented in `src/pi/devin-command.ts`, global toggles in `devin-settings.ts`, and presentation in `usage.ts`. Panels/pickers require `ctx.mode === "tui"`. Inspect the resulting model list and `devin-usage` status; displaying usage consumes recorded account/branch data rather than fetching it again.
- **Runtime schema and archives.** `src/core/protocol/protobuf.ts` loads `proto/` relative to `import.meta.url` with `keepCase` and reuses its process-local root. The archive contains `index.ts`, `src/core`, `src/pi`, and `proto`. Check `verification/inventory.json` against the actual archive. `verification/scripts/verify-proto.mjs` compares source-built schema and actual codec wire results as development verification.
- **CLI-only behavior.** Titles, analytics, bounded tools, and file sessions belong to `src/cli/`. The CLI entry, CLI sources, and verification runners are excluded through inventory `devOnlyPaths`. Source execution does not establish that an extracted package works; keep CLI selectors and tool loops out of the Pi runtime.

## 3. Core Behaviors & Patterns

### Authentication and transport

- Register only `auth.oauth` with Pi. Accept session credentials established by login, refresh, `toAuth`, or the host's OAuth credential flow. Reject an unrelated `apiKey` before network dispatch as an ordinary error, without recording token expiration. Wire `metadata.apiKey` carries the OAuth session token; its name does not introduce API-key authentication. `expires: 0` describes the existing session-check contract, not a server TTL or newly issued token.
- Default `loginAccount()` uses REST for browser flow and Connect for manual flow. Distinguish that from `login()`'s legacy-connect default and explicit encoding choices. Do not reuse a failed one-time code through another flow. Validate callback state, accept a code once, and clean up input waits, clients, listeners, and the loopback server on exit.
- Only real authentication errors invalidate the matching auth generation. A 401 blocks active, waiting, and subsequent requests; 403, 429, and local timeout do not mean expiration. A late failure from an older generation cannot invalidate a new login.
- A lease owns serial admission, cancellation, and client cleanup, and rechecks the current run/state/session identity. The provider combines caller and lifecycle signals; transport adds its RPC deadline. Core defaults to 90000ms, while a Pi-supplied `timeoutMs` wins. Existing Pi-runtime tests distinguish Pi's 300000ms default from an explicit 5000ms reaching the final HTTP signal.
- Gzip the final streaming protobuf at the default 8192-byte threshold. Only an initial compressed response with status 408, 415, 500, 502, 503, or 504 permits one uncompressed retry, retaining the body, trace, and deadline. This retry still consumes the run's model-request budget.

### Model identities and persisted state

- Exclude nonchat, disabled, router, missing-limit, and ambiguous-thinking entries. Do not publish a group whose thinking levels reuse a UID or whose variants disagree on capabilities. Select only verified exact UIDs and supported levels, without alias, pricing, or default-model substitution.
- Pi hides exact UIDs already selectable through a group; sidekick children expose all exact entries. The recommended-model filter changes presentation, and falls back to the ordinary list when nothing qualifies.
- `publicModelIDs()` assigns `familyID[-distinct dimensions]` to groups, catalog UIDs to variants, and `fusion` to Fusion. Groups win collisions; variants receive suffixes such as `-exact`. Internal `family:…` keys, `modelIDForUID()`, and `resolveBackendSelection()` serve different contracts. `resolveUID()` still validates catalog UIDs hidden from the picker.
- `effectiveFusion()` interprets saved legacy `family:`/`uid:` choices against current IDs. A disappeared choice falls back individually to its default; without a valid default combination, no Fusion model is created. Do not turn this migration into blanket replacement of existing choices.
- Scope catalog caches by credential and endpoint. Before restoration, validate provider/API/URL, metadata version/scope, and consistency of duplicated configuration. Publish state changes only inside an accepted `context.publish()`. A transient same-scope refresh failure keeps the last good catalog, but account changes/logout must not expose the old account's models.
- The lead and child share `models-store.json` containing the unfiltered base catalog and complete configuration. Each process rebuilds its own filtered or child-specific list from that base. Numeric zero cost means unknown, not free usage.
- Cache-retention precedence is caller option, provider environment, then `PI_CACHE_RETENTION`. Allow `long` only for a variant advertising 24h Prompt Cache Retention, and check again if a payload hook changes the model. `none` removes prompt-cache options. Because server TTL is unverified, `cache_warming_decision` stops warming for Devin models.

### Runs, streams, and child work

- `DevinLifecycle` opens a pending run for pre-agent automatic compaction, then lets the agent inherit it. Tool continuations, retry, overflow, compaction, and compressed-transport fallback count actual model HTTP requests against the same budget until `agent_settled`. Default budget is 8, capped at 100. Manual compaction has its own run; `agent_end` alone does not reset the budget.
- Persist only owner hash, session/conversation IDs, phases, and budget in `pi-devin.state.v1`. Resume/reload restores an unfinished budget. Fork/new with another session ID creates new IDs, and tree navigation starts another trajectory. Reject malformed state and prevent history tied to another verified account from being sent.
- Return the Pi stream immediately, then emit start, balanced content events, and exactly one terminal result. After payload replacement, reject changes to run/session/phase IDs and revalidate UID, image/tool capabilities, output limit, and cache retention. Await response hooks before body consumption and frame hooks before processing each frame.
- Keep requested, actual-response, and usage UIDs distinct. Do not replay failed/incomplete assistants or the results of their failed tool calls. Preserve owned signature metadata, tool IDs, system instructions, tools, and images. Release the client and lease on every completion, error, or cancellation path.
- Start one child Pi lazily on the first sidekick handoff for a lead session and reuse its context. Another call during active work steers that child. Changed launch settings replace it only when idle. Pass the lead's active tools minus sidekick tools. `PI_DEVIN_FUSION_CHILD` prevents recursive registration: children omit Fusion models/tools/commands, `/devin`, status, and recommended filtering.
- Handoffs normally wait for a report. `block: false` or actual user input moves them to background; extension-generated input does not. Cancellation aborts child work, and session change/shutdown closes the child. Deliver a background report once as `followUp` only if the work was not canceled and its runtime is still current.
- All report paths, including errors and background delivery, use a 131,072-token-times-four-character limit. When truncated, attempt to preserve the complete body in a private temporary file. Storage failure changes the notice, not the bounded report contract.

### Settings and presentation

- Direct SDK consumers receive memory stores by default; `index.ts` wires global file stores. Read failure yields defaults/no selection without repairing a file merely because it was read.
- After saving the recommended filter, refresh provider/Pi registry state without network access and retain a now-hidden current model in the session. After saving Fusion selection, perform that refresh and also call `pi.setModel()` when the current model is Fusion.
- Quota display uses the last received account status. Branch usage belongs to that branch; do not merge child usage into the lead's branch totals or manufacture another service request for UI refresh.

## 4. Conventions

- Keep `src/core/` independent of Pi SDK integration, CLI UI, and persistence adapters. Use host packages through public entry points and wildcard peers; this app's development SDK versions use `catalog:devin`. Limit TUI imports to screen modules rather than CLI paths.
- Runtime source uses Node-executable ESM TypeScript and `.ts` relative imports. Preserve `erasableSyntaxOnly`; avoid syntax requiring transformation, such as parameter properties.
- The protobuf boundary translates camelCase DTO fields and original snake_case fields, but leaves user map keys intact. Reject unknown fields/enums and malformed repeated inputs. Tool-schema conversion recurses through schema maps, not data inside enum/const/default/examples. Treat versioned authentication, state, catalog, and native wire keys as contracts.
- Do not log tokens, fingerprints, or JWTs or add them to session entries. Remove explicit sensitive header values from errors. `DeviceSystem` reports actual observations: on macOS, ioreg serial first, then ifconfig MAC if missing/short/failed; elsewhere, empty serial and Node's network API for MAC. Do not fabricate identifiers.
- Public names use the Devin prefix, including `devin_sidekick`, `/devin`, and `/devin-fusion`. Runtime imports must not reach CLI, tests, experiments, or verification. Use de-identified fixtures and keep earlier experiment/evidence snapshots distinct from new results.

## 5. Working Agreements

Apply the [root working agreements](../../AGENTS.md). After code changes, run `pnpm --dir apps/pi-devin typecheck` from the repository root.

Use `verification/README.md` to locate existing offline and extracted-package checks. Pi execution changes also affect `verification/scripts/host-contract.mjs`, which checks a pinned Pi executable; SDK checks alone do not cover TUI, print, JSON, or RPC environment/catalog behavior. Use fake credentials, temporary HOME/agent stores, and controlled I/O for offline verification. Report source, archive, SDK, native/live, and parity results separately. `PI_OFFLINE=1` is not a security sandbox, and a new verification run does not by itself resolve an older cleanup defect.
