# CHANGELOG

All notable changes to this project will be documented in this file.

## Unreleased

- Fix `/api/chat` requests not disabling thinking when Pi's thinking level is set to `off`, by mapping Pi `off` to `reasoning_effort: "none"` for models that support it (#6).
- Add thinking-level mapping: Pi levels `off`/`low`/`medium`/`high` map directly to Ollama Cloud's OpenAI-compatible `reasoning_effort` values (`none`/`low`/`medium`/`high`). `minimal` and `xhigh` are hidden. GPT-OSS has no off mode.
- Document how thinking levels are determined and how to refresh the cached model metadata.
- Treat stale local model caches as usable for immediate startup while triggering the same visible refresh flow as `/ollama-cloud-refresh` on `session_start`; use fallback models only when the cache is missing or invalid.
- Add a single-line `/ollama-cloud-refresh` progress widget showing the current stage, count, percentage, failures, and progress bar.
- Add thinking on/off assertions to the CI smoke test.

## [0.3.1] - 2026-05-05

- Fix `OLLAMA_API_KEY` env var not being respected by `fetchModels` and web tools. pi-ai does not know about the `ollama-cloud` provider ID, so `AuthStorage.getApiKey()` alone misses the env var. Added explicit `process.env.OLLAMA_API_KEY` fallback.
- Switch web tools to `AuthStorage.create()` for API key lookup, matching the `models.ts` auth pattern from v0.2.1.
- Add null-safe access to `data.details?.family` in `resolveThinkingLevelMap`.
- Change `OLLAMA_BASE` from `export let` to `export const` to prevent accidental mutation.
- Fix fallback model IDs to use real Ollama Cloud identifiers (`glm-5.1`, `gemma4:31b`) instead of synthetic `:cloud` suffixes.
- Add smoke test workflow for CI.

## [0.3.0] - 2026-05-04

- Derive `thinkingLevelMap` from pi's built-in model definitions instead of hardcoding model-family mappings. The extension now picks up thinking level metadata automatically when pi-mono adds or updates it for any model.
- Add family-based fallback matching: when an Ollama Cloud model ID doesn't match a pi model ID exactly, the extension now tries matching by model family (via Ollama's `details.family` field). For example, `gemma4:31b` correctly picks up Gemma 4's thinking level map from pi.

## [0.2.1] - 2026-04-29

- Fix API key retrieval by using `AuthStorage` instead of `ctx.modelRegistry.getApiKeyForProvider`. The provider-level API key lookup was failing, causing auth to only work when an environment variable was set. Now reads from `auth.json` directly via the pi `AuthStorage` class.

## [0.2.0] - 2026-04-28

- Add `PI_OLLAMA_WEB_TOOLS` environment variable to optionally disable `ollama_web_search` and `ollama_web_fetch` tool registrations. Set to `0`, `false`, `no`, `off`, or an empty string to opt-out. The model provider and `/ollama-cloud-refresh` command remain active regardless.

