# AGENTS.md

<!-- agents-md-generator: v1; doc-type: single_repo -->

## 1. Overview

This provider runs Claude Code conversations through Pi while leaving tool execution and conversation history under Pi's control. It translates requests, maintains Claude session mirrors, and routes streamed tool results back to their owning query.

## 2. Ownership Map

### Stable Ownership Boundaries

- **Provider lifetime.** Begin in `src/adapters/pi/registration.ts`, `src/app/layer.ts`, and `src/app/runtime.ts`. Registration and shutdown must not replace or remove another instance's provider. Verify with `tests/unit-provider-registration.mjs` and `tests/unit-cross-session-turns.mjs`.
- **SDK requests.** Environment, launch settings, and reasoning policy belong to `src/adapters/claude/environment.ts`, `launch-settings.ts`, and `request-options.ts`. `query-options.ts` assembles them; `client.ts` owns SDK invocation and instance-local injection. Follow changes to the final captured options and the child-env, launch-settings, and request-options unit cases.
- **Prompt ownership.** `src/features/prompt/capture.ts` connects structured Pi instructions to `src/features/query/service.ts`. Preserve instruction provenance and reject unsafe projection rather than substituting an empty prompt. The prompt-capture, turn-failure, and agent-start-capture tests exercise this boundary.
- **Session reconstruction.** Start in `src/features/session/service.ts`, `continuity.ts`, and `mirror-store.ts`. Pi history is authoritative; prior Claude files supply compatible carried data, not permission to resume an old writer. Check shared-session, continuity, and rebuild-fidelity tests.
- **Tool delivery and cleanup.** `src/features/tool-bridge/service.ts` routes results, `src/features/query/registry.ts` identifies their owner, and `completion.ts` with `lifecycle.ts` ends or cancels work. Use the querycontext, deliver-tool-results, discard-rewritten-query, and query-exception tests to check late events and replacement queries.
- **Models and summaries.** `src/features/models/policy.ts` governs both registered context windows and actual Claude model IDs. `plan-detection.ts` supplies account-plan information; `src/features/summary/service.ts` handles one-shot summaries. Check model/request-option tests and the summary's final SDK options together.

## 3. Core Behaviors & Patterns

### Instance and request boundaries

- `createBridgeRuntime()` synchronously builds an instance-local `ManagedRuntime` from `Context.Service` contracts and `Layer` implementations. Service assembly must not invoke another service's runtime operations. Session shutdown withdraws hooks, not the runtime: retained provider registries can call the same instance again. The first instance registers the provider immediately; later instances register on `session_start` only when that registry lacks it. Shutdown removes the global registration marker only when its stream function is still the owner.
- Mirrors and top-level `QueryContext` objects are keyed by Pi session ID. Calls without an ID share `(none)`. Compaction and tree changes mark only that session for rebuilding. The `releaseSessionQueriesHooks` fanout also identifies the session: active work finishes through its own execution signal, while idle pending handlers can be released immediately. An instance whose runner has shut down leaves both hook sets once its final query and session context are released, and rejoins on its next stream call.
- Child environment preparation copies the host environment and removes parent Claude-session variables, retaining authentication, routing, and unknown caller variables. Provider queries disable Claude's built-in tools and hooks, allow only the Pi-tool MCP server, and avoid duplicate project instructions. Summary queries also disable tools and hooks, use their own system prompt, and set empty skills, `persistSession: false`, and `maxTurns: 1`. Duplicate `extraArgs` keys are errors.
- Reasoning uses a valid model `thinkingLevelMap` before the generic mapping. An absent level may fall back; `null` or unsupported mappings do not send effort. Explicit enabled reasoning requests adaptive thinking for Claude 4.6 and later. Off disables thinking unless the model declares `off: null`.
- Context-window policy applies `forceTwoHundredK` first and requests `[1m]` only for measured models. Opus 4.6 requires Max or extra usage; Sonnet 4.6 requires extra usage. Unknown models remain at 200K. Update registered metadata and the final Claude model ID through the same policy.
- Project provider settings override global settings. An explicit plan disables detection. Otherwise `accountInfo()` is attempted once per runtime; an exception permits another attempt on a later query, but an unrecognized response remains a diagnostic outcome. Do not infer Max from a Team label. A recognized result updates memory and is saved best-effort; malformed JSON and non-object config roots are ignored and are not overwritten. Extension-written fields replace the global config through a sibling temporary file and rename at the resolved path, so concurrently starting processes never parse a partial file and a symlinked config stays a link. Only the registering instance refreshes provider models.

### Prompt and history reconstruction

- Capture structured options at `before_agent_start` and completed prompts at `agent_start`/`turn_start`. Resolve an exact capture first, then a reachable inherited capture, then a temporary child containing a known prompt. Keep a temporary child's outer instructions. Projection includes project instructions, selected tool guidance, available skills, and custom/append/section content while removing duplicate skills. Unresolvable, cyclic, or prohibited projection fails before claiming a query. Input with no prompt is a separate supported case.
- Synchronization excludes system messages and imports history before the current user turn. Reuse requires no rebuild marker, sufficient history for the cursor, and either no missing messages or one missing assistant message. Shorter history rebuilds an ordinary identified session. Without a rebuild marker, reentrant or ID-less calls instead preserve the existing mirror and use a temporary session, deleted afterward. No prior history starts a clean session.
- A rebuild normally retains its UUID. `forceRotate` allocates another when an abandoned or canceled writer could collide. Restart recovery consults only the latest `claude-bridge-cc-session` entry on the branch; an invalid latest entry must not revive an older one. A matching session/cwd/file link is read-only carry input, and a new process creates a new Claude UUID. Failed carry reads do not block reconstruction from Pi history. Same-UUID rebuilding preserves valid `tool-results/` without following symlinks during cleanup. Verification warnings reach logs/UI but do not themselves block execution.
- Replay thinking only when it has the bridge's own signature. Drop genuinely empty assistant messages, but retain a placeholder when filtering removed all their content. Group parallel results after their assistant before repairing pairs; calculate attachment placement after repair. Restore a prior Claude result representation only when tool ID, error status, and content fingerprint match Pi's result.
- Carried text files must be regular, non-symlink files under the same project's UUID-specific `tool-results/`, no larger than 32MiB. Validate descriptor identity and size, and close every descriptor. Intact inline image data can remain usable even when the previous image file is missing.

### Tool and query lifetime

- Pi executes tools. MCP handlers and results meet through `claudecode/toolUseId`, not arrival order; missing IDs fail. Early results wait in a query-owned queue. Await steer's stdin acknowledgment before delivering tool results. A failed steer schedules rebuilding but does not discard the tool result.
- An orphan result ends quietly only when its own call signal is already aborted. Otherwise resume or rebuild from current history. When a pending query transfers to another execution, detach its previous abort listener and bind the current caller's signal.
- Cancellation and discard release prompt waits, answer pending MCP handlers, and then interrupt/close the SDK query. A discarded query's late completion cannot update its replacement's stream or mirror. Ordinary failure leaves the cursor unchanged and schedules a rebuild. Cleanup checks ownership before releasing listeners, prompts, queries, or session-link writers. SDK consumption failures become terminal Pi stream results.
- `cacheRetention: "none"` selects isolated summarization before ordinary session synchronization. Resolve cwd from the registered call session, then the session associated with the operation signal, then `process.cwd()`. Forward caller reasoning and system prompt without creating or resuming a mirror. Accept final/assistant text and SDK usage, reject an empty summary, check cancellation before creating a query, classify canceled iteration as aborted, and remove cancellation listeners and close the query on every exit.

## 4. Conventions

- Keep policies in their owning modules and dependency composition in `src/app/layer.ts`. Query and summary scopes belong to the instance lifetime, not to one Pi output stream. Test-only adapters stay in `tools/verify`, outside the published runtime. For example, `createSdkQueryClient()` owns its injected query function; `setQuery(null)` restores that instance's SDK default.
- Keep shared data types, service contracts, and factory dependency types in each feature or adapter's `types.ts`, using `import type`. Runtime classes, `Context.Service` tags, and Layers stay with their implementations; small implementation-only aliases may remain local.
- Runtime TypeScript uses ESM `.js` relative imports but ships as source. `src/index.ts` is the extension entry. Runtime code must not depend on `tests/`, `diag/`, or maintenance tools; `src/diagnostics/` is a runtime service.
- MCP tool schemas must be objects. Normalize only root `anyOf`, `oneOf`, and `allOf`: root properties win; `allOf` contributes required fields; alternative branches describe constraints without making all their fields required. Pi still validates the original arguments.
- Shared symbol keys, session-entry formats, tool IDs, and diagnostic prefixes such as `syncResult:`, `Case 1` through `Case 4`, `usage:`, `WARNING:`, and `BUG:` have consumers outside their defining module. Follow those consumers when changing the contract.

## 5. Working Agreements

Apply the [root working agreements](../../AGENTS.md). After code changes, run `pnpm typecheck` from this package directory. Distinguish fixture/option-capture checks from actual Claude execution, account access, and cache measurements; those external effects require an explicitly authorized scope.
