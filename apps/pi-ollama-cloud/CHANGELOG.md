# CHANGELOG

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.15.1] - 2026-10-21

### Improved

- The README is now in English, with the Korean version shipped as `README.ko.md`. It explains the installation routes before the install command and corrects when `!command` key references are read again.

## [0.15.0] - 2026-10-21

### Improved

- Wait for a free slot when an account is at its concurrent request limit (`429 "too many concurrent requests"`), which parallel sessions and subagents on one account hit in bursts. The request is resent on the same account after about 1, 2, 4, 8 and 16 seconds before Pi's own retries take over.
- Say that Pi must be restarted when an upgrade under a running session removed the file Ollama Cloud requests load, instead of showing only "Cannot find module".

### Fixed

- Preserve unsaved account-state changes after lock or write failures, and retry saving them on the next update unless another process changed the file.
- Show `/ollama` results, settings-save messages, and errors on stderr in print and JSON modes without disrupting JSON stdout.
- Recheck referenced keys after a rejected balance check so updated environment references work without a reload; command references still require a Pi restart.

## [0.14.0] - 2026-10-20

- 진입점을 `src/index.ts`로 옮기고 루트의 호환용 재노출 파일을 제거합니다. 직접 import와 파일 경로를 지정한 로드는 새 `src/` 경로로 변경해야 합니다. 공급자·도구·명령 이름은 유지하며, 개발 CLI에 모델 조회·1+1 채팅·메타데이터 출처·기능별/배포물 진단을 연결합니다.
- 저장 인증의 환경 변수·명령 참조를 공식 Pi resolver로 해석합니다. CLI·생성기·실제 소비자가 같은 인증 경로를 사용하며 동기 명령의 취소 지연 한계는 유지합니다.
- native thinking 정보를 우선하고 미확인 가격·출력 한도 별칭의 추정 상속을 방지합니다. 카탈로그 실패 시 마지막 정상 목록과 성공 시각을 보존하고 실패 재시도 간격을 별도로 관리합니다.
- fetch refresh 실패 뒤 정상 재시도를 복구하고 렌더러의 잘못된 이전 컴포넌트 재사용과 폭 변경 문제를 수정합니다.
- 메모리·디스크 보관 예산과 반환 바이트·줄 수 상한을 분리합니다. search expand와 fetch full에도 이어 읽기를 적용하고 제거·만료 뒤 재요청 가능성을 알립니다.
- 파일 잠금과 변경분 병합으로 세션 간 캐시 덮어쓰기를 방지하고 동등한 진행 중 요청을 공유합니다. 전체 구독자 취소 시 전송을 중단합니다. 사용량 표시의 끄기·공급자 전환·종료도 진행 중 요청을 취소합니다.
- 모델·가격·추론과 출력 한도 생성 데이터를 `src/generated/`로 옮기며 기존 값은 보존합니다. 모델·가격·추론은 단일 catalog transaction으로 게시하고, 출력 한도 측정의 모호한 실패는 기존 값을 보존합니다.
- source와 실제 packed artifact의 lifecycle·도구·payload 검증을 CI에 추가합니다. 기존 채팅·thinking-off·웹·최신 Pi 검사는 유지하고 웹 smoke를 등록된 도구 실행 경로로 전환합니다.
- 호환성 변경: 명령을 `/ollama` 하나로 합칩니다. `/ollama-cloud-usage`, `/ollama-usage-status`, `/ollama-webtools`는 제거하고 `/ollama usage`, `/ollama status [on|off]`, `/ollama webtools [on|off]`로 대신합니다. TUI에서 `/ollama`는 제목 아래에 사용량 보고서를 보여 주고, 사용량 상태 표시·웹 도구 토글과 계정 목록·추가·관리를 담은 설정 화면을 엽니다. 보고서는 화면이 열려 있는 동안만 잔액을 5초, 요청 통계를 15초마다 갱신하며 429를 받으면 30초 뒤에 다시 조회합니다.
- 동작 변경: `/ollama`에서 바꾼 사용량 상태 표시와 웹 도구 설정은 전역 `ollama-cloud.json`에 저장되어 다음 시작에도 유지됩니다. 프로젝트 설정과 `PI_OLLAMA_WEB_TOOLS`의 우선순위는 그대로이며, 올바르지 않은 전역 설정 파일은 덮어쓰지 않습니다.
- 여러 Ollama Cloud 계정을 지원합니다. Pi의 `ollama-cloud` 자격 증명을 기본 계정으로 쓰고, `/ollama`에서 추가한 계정은 `auth.json`과 같은 형식·권한·잠금을 쓰는 `ollama-cloud-accounts.json`에 저장합니다. 계정 목록과 키 입력은 키의 앞 6자리만 표시하고 계정별 사용량을 함께 보여 주며, `$ENV`·`!command` 참조도 지원합니다.
- 각 세션은 계정 하나를 고정해 쓰며 Pi 재시작·resume·reload 뒤에도 같은 계정을 유지합니다. 새 세션과 fork는 여러 Pi 프로세스가 공유하는 순번에 따라 다음 계정을 받고, 웹 도구도 세션 계정을 사용합니다.
- 응답 시작 전 사용량 한도(429)·키 거부(401)·모델 거부(403)가 발생하면 계정을 표시하고 같은 요청을 다음 계정으로 다시 보냅니다. 모든 계정을 쓸 수 없으면 Pi가 자동 재시도하지 않는 오류를 반환하고, 사용량 한도 429는 일반 요청 제한과 구분해 안내합니다.
- 동작 변경: 구매 크레딧이 있는 계정은 포함 사용량이 3% 이하로 남으면 계정이 하나여도 요청을 보내지 않습니다. 이를 위해 계정마다 첫 요청 전과 주기적으로 `/api/balance`를 조회하며, 실서비스 검사도 이 조회 1회를 허용합니다.
- `/ollama usage`가 모든 계정의 잔액과 상태를 표시하고, 하단 사용량 표시는 계정이 여러 개일 때 현재 세션 계정 이름을 함께 보여 줍니다.

## [0.13.2] - 2026-10-18

- npm 이름과 공개 모듈 경로를 유지하면서 전체 Git 이력을 `pi-packages` 모노레포로 편입하고 패키지 저장소·지원 링크를 갱신합니다.
- Pi 호스트 의존성과 TypeBox를 공통 catalog에 맞추고, 생성 스크립트의 출력 위치를 앱 경로에 고정합니다.
- 기존 단위 테스트, 최신 Pi 호환성 검사와 실서비스 검사를 공통 CI로 이전합니다. 배포물의 모델 응답을 확인한 뒤 앱별 태그로 npm과 GitHub Release를 배포합니다.
- 설치 전환·설정·검증·유지보수 문서를 정리하고 `check`를 파일을 수정하지 않는 검사로 변경합니다.

## [0.13.1] - 2026-10-10

- Add `mistral-large-4` to the generated model catalog with image and tool support, on/off reasoning controls, official pricing, a 1048576-token context window, and a probed 262144-token output limit.
- Prepare the fork for publication as `@buyong/pi-ollama-cloud`, with the fork repository URL, public npm access, updated installation examples, and first-publication and trusted-publishing instructions.

## [0.13.0] - 2026-10-07

- Fix the usage command and status bar after Ollama moved quota data to `/api/balance`, supporting both legacy remaining-percentage windows and the included-balance allowance shape. Show allowance renewal dates and purchased credits when returned, and optionally display request totals from the documented `/api/usage` histogram endpoint.

## [0.12.3] - 2026-10-06

- Keep the usage indicator accurate when turning it off or switching providers, and show clearer errors for connection problems and invalid responses.
- Hide unsupported reasoning controls on affected gpt-oss models and limit disk space used by web-tool caching.
- Keep Ollama Cloud models compatible with Pi 1.0.
- Allow model-limit updates to use the API key configured in Pi, with `OLLAMA_API_KEY` as a fallback.
- Run the test suite successfully before publishing a release.

## [0.12.2] - 2026-09-27

- Refresh the model catalog for the September 25, 2026 retirements (`deepseek-v4-flash:0731`, `glm-5.1`, `qwen3.5:397b`): dropped from the generated catalog and pricing, 20 -> 17 models. Recommended replacements per Ollama: `deepseek-v4.1-flash`, `glm-5.3`, and `glm-5.3-flash` / `deepseek-v4.1-flash`.

## [0.12.1] - 2026-09-14

- Omit empty `openRouterRouting` / `vercelGatewayRouting` from `buildCompat` (set to `undefined`, not `{}`): pi-ai reads the raw `model.compat` and treats `{}` as truthy, sending a stray `provider: {}` on every Ollama chat completion. Fixes #60. Thanks @0xbentang (#61).

## [0.12.0] - 2026-09-11

- Source per-model thinking levels from models.dev instead of hardcoded maps. `scripts/generate-reasoning.ts` fetches the `ollama-cloud` provider's `reasoning_options` into `reasoning.generated.ts`, and `thinking-levels.ts` maps each model's effort values onto Pi's levels (toggle-only models become a binary on/off map; models with no models.dev entry fall back to `DEFAULT`). The `off` switch is handled by a small override table for models verified not to honor `reasoning_effort:"none"` (`gpt-oss:20b`, `gpt-oss:120b`, `minimax-m2.7`). Removed the now-stale per-family maps and the `docs/think-experiment.md` doc.
- `generate-models` now also refreshes `reasoning.generated.ts` (runs `generate-pricing`, `generate-reasoning`, then `generate-models`).
- Fix `generate-pricing` mis-dropping models whose pricing-page cached-input cell is `-` (no cache rate): those rows now match and their `cacheRead` equals `input`. This restored pricing for `mistral-large-3:675b`, `nemotron-3-nano:30b`, and `qwen3.5:397b`, which the earlier regex had left at zero cost.
- Refresh the model catalog: added `deepseek-v4.1-flash` (probed max output 393216).

## [0.11.0] - 2026-09-07

- Fix `/ollama-cloud-usage` and the usage status bar failing with "unexpected response shape" after the undocumented `/api/usage` endpoint flipped between a single `limits.monthly` bucket and `limits.session` plus `limits.weekly` (the shape has flip-flopped repeatedly as of 2026-09). Any bucket present (`monthly`, `session`, `weekly`) is accepted alone or in combination, and whichever are present are displayed as `5h`/`7d`/`30d` segments. Thanks @johanngyger (#56).
- Cache `ollama_web_search` results (24h) and `ollama_web_fetch` pages (24h success / 15 min failure) on disk under the pi agent home, so repeated queries and page reads cost 0 API calls. Expired entries are pruned on write, the cache is capped at 500 entries per kind (oldest evicted beyond the cap; `PI_OLLAMA_SEARCH_MAX_ENTRIES`), a partially corrupted cache file is validated per entry and degrades to "no cache" instead of crashing tool calls, and the file is written with `0600` permissions since it stores page content and URLs that can embed credentials. Tune with `PI_OLLAMA_SEARCH_TTL_HOURS`, `PI_OLLAMA_SEARCH_FAIL_TTL_MINUTES`, `PI_OLLAMA_SEARCH_MAX_ENTRIES`, and `PI_OLLAMA_SEARCH_CACHE_PATH`.
- Bound web tool context usage: search snippets truncate to 500 chars with `[truncated]`/`[complete]` markers, `expand=<index>` returns a truncated result's full content from the cached search (0 extra API calls), and `ollama_web_fetch` pages long pages in 3000-char chunks via `offset`/`full` with a `Continue:` hint for the next offset (`PI_OLLAMA_SEARCH_SNIPPET_CHARS`/`PI_OLLAMA_SEARCH_CHUNK_CHARS` to tune).
- Add `refresh=true` to both web tools to bypass the cache (including a cached failure) and re-call the API; the fresh result replaces the cache entry.
- Failed page fetches are negative-cached for 15 min with a diagnostic message (likely cause + next steps) instead of a bare error. Auth (401/403), rate-limit (429), transport (timeout/abort/network), server (5xx), and unexpected-response-shape failures are never cached — search reports transport errors as `transport error` instead of a confusing `status 0` — so retrying after a fixed key, an expired rate-limit window, or a transient server blip re-calls the API immediately.
- Note: `ollama_web_fetch` tool results now carry `details: { title, totalChars, links }` (previously `{ title, content, links }`); paged content is read via the tool output text, not `details.content`.

## [0.10.0] - 2026-09-03

- **Breaking:** Adapt to the changed `/api/usage` response shape. The endpoint now returns a single `limits.monthly` bucket (replacing `limits.session` and `limits.weekly`) and adds an `activity.models` array. `UsageData`, `isUsageResponse`, `formatUsage`, and `formatUsageStatusColored` now read the monthly limit; the status bar shows a single `30d` segment instead of `5h`/`7d`.
- Refreshed the generated catalog from the live API: added `deepseek-v4-pro:0813`, `glm-5.3`, and `glm-5.3-flash`; removed `deepseek-v4-flash:preview` and `deepseek-v4-pro`, which are no longer listed.
- Source per-token pricing from the official model table on ollama.com/pricing instead of models.dev estimates, which no longer track Ollama's published rates (up to ~13x off per model). `scripts/generate-pricing.ts` now scrapes the pricing page (the table is server-rendered; no JSON endpoint exists) and matches catalog IDs to pricing rows by exact or `:tag`-family match, replacing the `OLLAMA_TO_MODELSDEV` mapping. Regenerated `pricing.generated.ts` with the official rates, including new models (`glm-5.3`, `glm-5.3-flash`, `deepseek-v4-pro:0813`). Fixes #51. Thanks @Hackbard (#52).
- Probe per-model max output tokens against the live API via `scripts/generate-limits.ts` into `limits.generated.ts`, replacing the fixed 32768 default for known models (unprobed models still fall back to 32768). The probe timeout is 60s so slow first-token models are not dropped from the table. Thanks @f440 (#49).

## [0.9.0] - 2026-08-11

- Add `/ollama-cloud-usage` command to show Ollama Cloud session (5h) and weekly (7d) usage limits, per-model request counts, and the 4-week activity cost, fetched from the undocumented `/api/usage` endpoint with the already-resolved API key.
- Add a footer usage status bar (`5h ▕███░░░░░░░▏ 34% 7d ▕████░░░░░░▏ 45%`) while an `ollama-cloud` model is active, refreshing every 5 minutes and after each agent turn (throttled so it never exceeds one /api/usage call per 5 minutes). Segments are colored by usage level (green <60%, yellow 60-79%, red 80%+). The quota-bar concept is inspired by `@entelligentsia/pi-ollama-cloud-usage-tracker`. Off by default; enable with `/ollama-usage-status on` or `"usageStatus": true` in `ollama-cloud.json`.
- Add `/ollama-usage-status [on|off|enable|disable]` to toggle the footer usage status bar at runtime (toggles without an argument).
- Document the exported usage API (`fetchUsage`, `formatUsageStatusColored`, `getCloudApiKey`, validators) so custom status bars can reuse it.

## [0.8.0] - 2026-08-09

- **Breaking:** Migrate model refresh to pi's native `refreshModels` mechanism. Remove the `/ollama-cloud-refresh` command and the manual `~/.pi/agent/cache/ollama-cloud-models.json` cache. The catalog now refreshes automatically on startup, on `/model` open, and via `pi update --models`, persisted through pi's own `FileModelsStore`. Users should delete the orphaned cache file after upgrade: `rm ~/.pi/agent/cache/ollama-cloud-models.json`.
- The shipped `GENERATED_MODELS` list is now a first-launch fallback; releases are no longer required for model freshness (only for deprecation or pricing changes).
- Refresh the generated catalog from the live API: add `deepseek-v4-flash:0731`, `deepseek-v4-flash:preview`, and `kimi-k3`; remove `kimi-k2.5` and `minimax-m2.5`, which are no longer listed. Refresh models.dev pricing, including the new models. Thanks @noruthedev (#43).
- Requires a pi version with the `stored`/`publish` `RefreshModelsContext` (pi 0.84.0+). Add `@earendil-works/pi-ai` as a peer dependency.
- Web tools now throw on errors instead of returning an `isError` result, aligning with pi 0.84.0's `AgentToolResult` contract.
- Fix `ollama_web_fetch` failing on pages where the API returns `links: null` (e.g. GitHub PR pages); the response is now accepted and rendered without a links list.
- Refresh robustness: add a 4-hour cooldown so repeated `/model` opens don't re-fetch the catalog; on a partial refresh failure, keep the last-good catalog and surface the error instead of silently returning an incomplete list.
- Add `tsgo --noEmit` type-checking to `npm run check` and CI.

## [0.7.0] - 2026-07-18

- Fix extension crash on pi 0.80.8+ where `AuthStorage` is no longer exported by `@earendil-works/pi-coding-agent`. Web tools now resolve the API key through the tool execution context's `modelRegistry.getApiKeyForProvider()`, preserving runtime/CLI overrides and the registered `apiKey: "$OLLAMA_API_KEY"` config. Thanks @badlogic for the cross-version analysis (#34, #35, #37).
- Restore the `OLLAMA_API_KEY` env-var fallback in `ollama_web_search` and `ollama_web_fetch`. Thanks @cawilliamson (#26).
- Add a 15s timeout to web search/fetch requests and preserve tool-cancellation by extending `fetchJsonWithTimeout` with an external `AbortSignal`.
- Always target `https://ollama.com` and warn when `OLLAMA_API_BASE` is set to a non-cloud host, instead of silently querying a local Ollama daemon. Thanks @valueforvalue (#32, #33).
- Add a `glm-5.2` thinking level map exposing `off`, `high`, and `xhigh` (`reasoning_effort: "none"`, `"high"`, `"max"`). Thanks @Thinkscape (#29).
- Add estimated per-token pricing for Ollama Cloud models so `/cost` shows comparable usage. Prices are generated from [models.dev](https://models.dev) (the same source pi uses) via `scripts/generate-pricing.ts` into `pricing.generated.ts`, not hand-typed, and regenerate with the catalog via `npm run generate-models`. Prices are pinned to the installed package version: `/ollama-cloud-refresh` updates the model list and metadata but does not re-fetch prices, so newly added models register with zero cost until the next release. Not actual subscription charges. Thanks @DxTa (#9).
- Refresh the generated model catalog from the live Ollama Cloud API. Adds `glm-5.2` (1M context, text-only) and `kimi-k2.7-code` (262K context, text + image). `deepseek-v4-pro` context window is now 524288 (was 1048576).
- Retire models deprecated per https://docs.ollama.com/cloud#deprecations: July 15, 2026 batch (`deepseek-v3.1:671b`, `deepseek-v3.2`, `devstral-2:123b`, `devstral-small-2:24b`, `ministral-3:14b`, `ministral-3:3b`, `ministral-3:8b`, `gemini-3-flash-preview`, `gemma3:12b`, `gemma3:27b`, `gemma3:4b`, `glm-4.7`, `glm-5`, `minimax-m2.1`, `qwen3-coder-next`, `qwen3-coder:480b`) and June 30 (`rnj-1:8b`). The shipped catalog goes from 30 to 18 models.
- Bump `@earendil-works/pi-coding-agent` runtime dependency to 0.80.10.

## [0.6.0] - 2026-06-05

- Fix `apiKey` registered as a literal string instead of an environment variable reference. Changed `apiKey: "OLLAMA_API_KEY"` to `apiKey: "$OLLAMA_API_KEY"` in `registerProvider`, resolving the deprecation warning emitted by pi v0.77.0+ and making the `OLLAMA_API_KEY` env var work alongside `auth.json` (env var takes priority, falls back to `auth.json`). Thanks @mandusm (#21).
- Make `scripts/generate-models.ts` produce a stable output: sort models by `id` and each object's keys alphabetically (with `id` and `name` first), so regenerating the catalog produces minimal diffs. Thanks @shyim for the idea (#22).
- Exclude models announced for retirement (effective 2026-06-16) from the generated `GENERATED_MODELS` list: `kimi-k2-thinking`, `kimi-k2:1t`, `minimax-m2`, `glm-4.6`, `qwen3-next:80b`, `qwen3-vl:235b`, `qwen3-vl:235b-instruct`, `cogito-2.1:671b`. See https://docs.ollama.com/cloud#deprecations. `/ollama-cloud-refresh` will still register them from the live API until Ollama removes them.

## [0.5.0] - 2026-05-22

- Update `peerDependencies` and imports to the new `@earendil-works/*` packages.
- Add build script (`scripts/generate-models.ts`) to generate `models.generated.ts` with Ollama Cloud tool-capable models from live API data. The script requires no API key.
- Drop `FALLBACK_MODELS` in favor of `GENERATED_MODELS` which ships with the package.
- Remove `apiKey` requirement from `fetchModelIds` and `fetchModelDetails`. Ollama Cloud's public `/v1/models` and `/api/show` endpoints do not require authentication for model metadata. (#15)
- Remove `getOllamaCloudApiKey`, `refreshModelsFromAuth`, and the "No API key found" notification path from `fetchModels`. Users can now browse model metadata without configuring a key.
- Remove `401`/`403` error handling from the model metadata fetch functions.
- Add configuration system (`config.ts`) with JSON config files (global + project-local) and `/ollama-webtools` command for runtime web tools toggling.
- Add test infrastructure (`vitest`) and model validation tests (`test/models.test.ts`).
- Add HTTP status-aware error handling in web tools (`401`/`403` → auth error, `429` → rate limit).
- Add explicit `buildCompat()` with all 17 `OpenAICompletionsCompat` flags set explicitly, verified against Ollama API docs.
- Set the provider display name to `Ollama Cloud` so it reads cleanly in `/login`, `/model`, and the model selector.
- Document `/login` as the recommended way to configure the API key.
- Update README to clarify baked-in model list and refresh behavior.
- Document web-tools.ts module boundaries in file header comment.

## [0.4.1] - 2026-05-07

- Add `renderCall` to `ollama_web_search` and `ollama_web_fetch` tools so the TUI displays the query/URL in the tool call header instead of just the bare tool name. (#12)

## [0.4.0] - 2026-05-06

- Fix `/api/chat` requests not disabling thinking when Pi's thinking level is set to `off`. Maps Pi `off` to `reasoning_effort: "none"` on models where the API respects it, hides the `off` level on models where it doesn't (gpt-oss, kimi-k2-thinking, minimax, qwen3-vl). (#6)
- Add `thinking-levels.ts` with curated per-model thinking level maps (DEFAULT, GPT_OSS, QWEN3, NO_OFF), validated against all 24 thinking-capable models via automated experiment (see docs/think-experiment.md).
- Fix system prompt (AGENTS.md content) not being read by GLM models by setting `supportsDeveloperRole: false` on all registered models.
- Rename smoke test to test, add lint step.
- Treat stale local model caches as usable for immediate startup while triggering the same visible refresh flow as `/ollama-cloud-refresh` on `session_start`; use fallback models only when the cache is missing or invalid.
- Add a single-line `/ollama-cloud-refresh` progress widget showing the current stage, count, percentage, failures, and progress bar.
- Add thinking on/off assertions to the CI test workflow.

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

