# AGENTS.md

## 1. Overview

This extension applies `@buyong/redact` to what Pi stores from tool calls and to everything Pi sends to a model. It owns where masking happens, the `{{REDACTED}}` rendering, the write guard, and settings layering; detection rules belong to `packages/redact`.

## 2. Ownership Map

- **Hook wiring and failure policy.** `src/index.ts` registers every hook and decides what happens when masking throws. Handler errors in Pi are logged and the original data continues, so each handler must catch internally and withhold, cancel, or abort instead of rethrowing.
- **Rendering and scanning.** `src/render.ts` merges detection ranges and writes the marker per line; `src/decorations.ts` finds grep, line-number, and diff prefixes whose remainder is scanned again; `src/engine.ts` combines both with the redactor and the optional `src/cache.ts`.
- **Message shapes.** `src/messages.ts` maps each `AgentMessage` role and summarized session entry. `src/tool-results.ts` builds `tool_result` patches; `src/guard.ts` checks `write`, `edit`, `bash`, and `powershell` inputs. `src/settings.ts` reads and merges global and trusted-project settings.

## 3. Core Behaviors & Patterns

- Engines return their input itself when nothing is detected, and callers copy only changed branches. Keep this identity contract: it keeps unchanged requests byte-identical for prompt caches and lets hooks return `undefined`.
- Never mask system messages, thinking blocks, images, ids, or provider signatures. Tool-call `arguments` and `argumentsError` are masked.
- `tool_result` skips calls with `parentToolCallId`; returning `content` without `structuredContent` drops it, so always return both together.
- `context_with_system` runs after all `context` handlers. Do not move masking to `context` or `before_provider_request`: the bridge provider never calls `onPayload`, and compaction and branch summaries bypass both context hooks.
- `session_before_compact` reassigns `preparation` fields, which Pi's `compact()` reads afterwards. `session_before_tree` must replace array elements in place, because Pi keeps its own reference to `entriesToSummarize`. Never mutate session entry or message objects.
- The request engine caches by text, bounded by characters and entries. The stored-result engine has no cache so raw tool output is not retained.
- Settings problems name files, keys, and indexes only; never echo `JSON.parse` messages or configured values.

## 4. Working Agreements

Apply the [root working agreements](../../AGENTS.md). After code changes, run `pnpm --filter "@buyong/pi-redact..." build`, then `pnpm typecheck`, `pnpm lint`, and `pnpm test:unit` from this directory. Tests import `dist/`. `tests/integration/session.test.mjs` runs a real Pi session with a scripted stream function; it does not prove provider-specific payload handling or behavior with Pi versions other than 1.3.0.
