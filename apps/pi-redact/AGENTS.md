# AGENTS.md

## 1. Overview

This extension applies `@buyong/redact` to what Pi stores from tool calls and to everything Pi sends to a model. It owns where masking happens, the `{{REDACTED}}` rendering, the write guard, settings layering, the on/off switches, the `/redact`, `/redact-custom`, and `/redact-analytics` pages, and the analytics store; detection rules belong to `packages/redact`.

## 2. Ownership Map

- **Composition and host safety.** `src/index.ts` creates the instance's owners. `src/pi/session.ts` restores branch state and settings and closes session resources. `src/pi/hooks.ts` translates Effect exits into Pi results. Pi logs most handler errors and continues with the original data, so masking failures, defects, and interruptions must produce withholding, cancellation, or an abort rather than escape the adapter.
- **Rendering and scanning.** `src/render.ts` merges detection ranges and writes the marker per line; `src/decorations.ts` finds grep, line-number, and diff prefixes whose remainder is scanned again; `src/engine.ts` combines both with the redactor and the optional `src/cache.ts`.
- **Message shapes and write checks.** `src/messages.ts` maps each `AgentMessage` role and summarized session entry. `src/tool-results.ts` builds `tool_result` patches; `src/guard.ts` checks `write`, `edit`, `bash`, and `powershell` inputs. The Pi guard adapter forwards the caller's signal to its Effect program and blocks failed or interrupted checks.
- **Settings and masking state.** `src/settings.ts` owns validation, layering, trust checks, and file effects, including the global-only `enabled` and `disabledRules`. Its atomic write owns temporary-file cleanup. `src/masking-session.ts` owns the effective settings, session choice, and both engines in a private `Ref`; applying settings replaces both engines and the request cache together. `src/session-choice.ts` encodes the custom entry restored from the current branch.
- **Commands and display.** `src/pi/controller.ts` translates command callbacks into feature programs; `src/pi/commands.ts` registers the three commands and provides RPC and no-UI fallbacks. Terminal pages remain in `src/ui/`. `src/pi/feedback.ts` owns session counters, warning deduplication, and the status-bar projection.
- **Analytics.** `src/engine.ts` reports each changed string with the `labeled()` name. `src/analytics-session.ts` collects each synchronous masking step's observations and owns the lazily acquired store's `Scope`. `src/analytics.ts` owns SQLite storage of bounded excerpts from `src/excerpt.ts` for a fixed 30 days. Commands resolve the current store per operation instead of retaining a connection.

## 3. Core Behaviors & Patterns

- Use Effect v4 programs for feature workflows and typed operational failures. Masking hooks use `runSyncExit`; do not introduce asynchronous work into these programs. Analytics flushes on both success and failure without replacing the masking outcome. Settings replacement is uninterruptible until its temporary-file finalizer finishes, so cancellation cannot leave a late write racing cleanup. Existing Promise settings and guard exports remain compatibility boundaries.
- Engines return their input itself when nothing is detected, and callers copy only changed branches. Keep this identity contract: it keeps unchanged requests byte-identical for prompt caches and lets hooks return `undefined`.
- Never mask system messages, thinking blocks, images, ids, or provider signatures. Tool-call `arguments` and `argumentsError` are masked.
- `tool_result` skips calls with `parentToolCallId`; returning `content` without `structuredContent` drops it, so always return both together.
- `context_with_system` runs after all `context` handlers. Do not move masking to `context` or `before_provider_request`: the bridge provider never calls `onPayload`, and compaction and branch summaries bypass both context hooks.
- `session_before_compact` reassigns `preparation` fields, which Pi's `compact()` reads afterwards. `session_before_tree` must replace array elements in place, because Pi keeps its own reference to `entriesToSummarize`. Never mutate session entry or message objects.
- The request engine caches by text, bounded by characters and entries. The stored-result engine has no cache so raw tool output is not retained in memory. Analytics deliberately keeps original lines on disk for the user; recording failures warn and never change masking.
- While masking is off, the masking hooks return `undefined`; the write guard and the model guideline stay, because history masked earlier can still hold the marker.
- Settings problems name files, keys, and indexes only; never echo `JSON.parse` messages or configured values.

## 4. Working Agreements

Apply the [root working agreements](../../AGENTS.md). After code changes, run `pnpm --filter "@buyong/pi-redact..." build`, then `pnpm typecheck`, `pnpm lint`, and `pnpm test:unit` from this directory. Tests import `dist/`. `tests/integration/session.test.mjs` runs a real Pi session with a scripted stream function; it does not prove provider-specific payload handling or behavior with Pi versions other than 1.3.0.
