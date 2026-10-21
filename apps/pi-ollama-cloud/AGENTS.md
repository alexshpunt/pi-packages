# AGENTS.md

<!-- agents-md-generator: v1; doc-type: single_repo -->

## 1. Overview

This provider connects Pi to Ollama Cloud models, web tools, and usage reporting. It manages session-bound accounts, conditional failover, catalog restoration, and bounded reuse of fetched content.

## 2. Ownership Map

### Stable Ownership Boundaries

Verification names below refer to `test/`.

- **Integration.** Change registration/lifecycle in `src/index.ts` and `src/pi/lifecycle.ts`, settings in `config.ts`/`ollama-command.ts`. Preserve provider/tool names and unrelated active tools. Check `fixtures/package-contract.ts`.
- **Accounts.** `src/accounts/router.ts`, `policy.ts`, and `session.ts` own selection; `src/pi/account-stream.ts` and `account-requests.ts` apply different retry rules. Check account-policy/router/session-lifecycle and stream/request tests. Storage belongs to `accounts/credentials.ts`/`state.ts`, polling to `render/settings-panel.ts`; credential/state/panel tests cover failed saves and cancellation.
- **Catalog.** `src/models/catalog-service.ts` refreshes, `snapshot.ts` restores, and `metadata.ts` assembles policy. ModelsStore owns snapshots; diagnostics owns retry/provenance only. Check catalog-runtime/model-metadata-consumer across live, stored, generated, and CLI inputs.
- **Web/cache.** Start in `src/web/search.ts`/`fetch.ts`, schemas in `src/pi/web-tools.ts`, paging in `web/paging.ts`. `cache/bounded-storage.ts`/`merge.ts`/`lock.ts` own retention; `coordinator.ts`/`publication.ts` own sharing. Check cache/cache-concurrency/web-tools-cache-paging/web-budgets, including injected stores.
- **Usage/display.** `src/usage/api.ts`, `status-controller.ts`, and `src/render/result.ts` own responses, footer work, and components. Check usage/usage-status/render-result.
- **Maintenance.** `scripts/lib/generation/pipeline.ts` publishes catalog/pricing/reasoning; limits remain separate. `scripts/cli/registry.ts` wires diagnostics. Check generators/core-consumer/package-gates. Live effects belong to `scripts/lib/verification/live.ts`, checked by live-budget.

## 3. Core Behaviors & Patterns

### Catalog and model policy

- Keep a service per diagnostics path. Restore usable stored models or generated fallback, retaining names/context/modalities but reapplying current price/limit/compatibility/off policy. Stored native-thinking provenance requires matching `snapshotCheckedAtMs` and `checkedAt`. False `allowNetwork` or cancellation blocks network. Pi's authenticated refresh phase differs from keyless-capable catalog endpoints.
- Successful snapshots last four hours; failure retry defaults to 15 minutes via `PI_OLLAMA_MODEL_FAIL_RETRY_MINUTES`. `force` bypasses timing gates. Partial/total failure or no tool-capable models preserves the old catalog/success timestamp. List/detail errors throw; empty results return fallback. Signal/generation checks protect `context.publish()`: rejection/staleness returns fallback; persistence errors may return fresh models without claiming a save.
- `assembleModels()` requires `tools`, derives vision/thinking, and keeps exact IDs. Context fallback is 128000; exact-ID output-limit fallback is 32768. Prices/limits never infer alias/date-tag equivalence. Unknown zero cost does not mean free. Disabled compat flags remain `false`; unused routing objects remain `undefined`, not `{}`.
- Reasoning uses validated native `thinking.values`, generated exact-ID/`:tag`-family options, then defaults. Diagnose unknown native values without forwarding them; no usable enabled level falls back. Keep `OFF_NULL_EXACT`/`OFF_NULL_FAMILIES` in both paths. Server defaults do not replace caller choices. Model/price/reasoning key sets can differ.

### Accounts and settings

- Order Pi's `default` credential before additional auth.json-format accounts; deduplicate key fingerprints. Retain a usable binding or choose the next account after the shared round-robin cursor. Exclude disabled/rejected keys, usage limits, blocked models, and purchase-protected accounts.
- `ollama-cloud-account` stores session/account IDs only. Resume/reload uses the latest matching session ID; forks ignore parent bindings. Failed persistence retains memory binding only. A changed key's fingerprint separates it from old health.
- Stream failover requires a classified first-event error; after `start`/another event, pass failures through. Never switch on cancellation. A first-event `429 "too many concurrent requests"` is not an account failure: wait `CONCURRENCY_RETRY_DELAYS_MS` (jittered 0.5–1.5×, abort-aware, one notice) and resend on the same account, then pass the retryable error to Pi. Prefix a missing Pi bundle-chunk error with the restart hint. Set the selected `apiKey` and existing case-insensitive Authorization headers; preserve other options/signals. Web failover permits usage-limit/rejected-key errors, not 403, ordinary rate limits, or transport failure. Try each account once and retain the last error if alternatives fail.
- Prefer a future server reset for usage-limit exclusion. Without one, session/unknown waits 30 minutes, weekly six hours, monthly 24 hours. A model-specific 403 excludes that account/model for six hours, not the entire account.
- With purchased credits, stop at 3% or less included allowance: minimum quota-window fraction, else balance/allowance, else zero. Balance rechecks: no purchases, 15 minutes; purchased with at least 25% remaining, 10 minutes; at least 10%, two minutes; otherwise 30 seconds; nearly exhausted, five minutes. A passed reset also makes snapshots stale.
- Failed checks suppress retries for one minute. Block stale purchased snapshots below 10% remaining or at least 30 minutes old. Never-verified accounts may proceed as unverified after a recent check failure: this is not guaranteed charge prevention. Canceling one balance subscriber ends its wait, not shared work.
- Resolve extra credentials through private `ModelRuntime` with model networking off, never raw env/command references. Reject built-in provider names, duplicate IDs, and unsupported credentials. Errors hide file contents/keys/commands; malformed files are not overwritten as empty. UI addition removes unusable/duplicate/401-rejected keys but warns and retains them after transient balance failure. Pi's default credential is not deleted here. Request and balance-check 401 responses invalidate the local resolved-account cache for the next load; Pi's process-wide `!command` cache requires a restart to pick up changed command output.
- Health stores fingerprints/balances/timestamps/cursor, never keys. Validate fields, cap reads at 256KiB, and retain up to 64 health entries for 30 days. Reread/update under a cross-process lock and rename a 0600 file. Lock/write failure leaves memory-only changes until a later file revision; the next locked update persists them if that revision is unchanged.
- Precedence is defaults < global JSON < project JSON < `PI_OLLAMA_WEB_TOOLS`; ignore wrong types, unknown keys, and nonobjects. Env `0`/`false`/`no`/`off`/empty locks web tools off. Load at first `session_start`; register idempotently and change only owned active tools.
- `/ollama` toggles apply immediately and save globally/atomically, preserving unknown file keys. Failed saves are run-local; report restart overrides from project/env. Malformed JSON is not overwritten; invalid arguments leave state unchanged. Command results, save outcomes, and errors use notifications when `hasUI` is true, otherwise stderr, never JSON-mode stdout.

### Authentication, requests, and retained output

- Resolve primary auth through the provider registry, then env. CLI/generators use `auth/pi-resolver.ts`/`ModelRuntime.getAuth()` for `$ENV`/`!command`, forwarding resolved env and cancellation. Catalog bearer headers require an env key; `OLLAMA_BASE` ignores local-server overrides. `fetchJsonWithTimeout()` combines timeout/cancellation, cleans timers/listeners in `finally`, and returns `{ ok, status, data, error }`. Consumers validate shapes and distinguish transport/auth/rate-limit/server errors.
- Cache hits require resolved auth. Search caches successes; fetch also caches eligible failures. TTL: success 24 hours, failure 15 minutes. Exclude transport failures, 401/403, 429, 5xx, and malformed responses from negative caching. Noncacheable page refresh deletes the old entry; cancellation deletes only the captured entry by identity, not its replacement. Distinguish retained and uncached live errors.
- Scope coordinators by cache/auth-scope objects; share matching parameters, credential digest, and refresh mode. One canceled subscriber ends its wait; the last aborts transport. Normal/forced jobs differ, but only the latest resource generation publishes. `publishCache()` rechecks inside `updateCache()` and supports synchronous-only injected stores.
- Track memory, fingerprint baseline, and disk revision. Merge without reviving peer deletions; routine eviction must not erase newer peer entries. Evict whole entries. Defaults: 500 per map, 8MiB serialized memory, 256KiB per disk entry/8MiB total. These do not bound heap or response reception.
- Oversized/corrupt files yield validated empty/partial data and diagnostics. Lock, synchronously reread/merge/prune/rename, then release in `finally`; files use 0600. Report lock/write failure. Peer revisions can invalidate memory-only results.
- `createPagedResult()` bounds serialized `content`+`details` by Pi byte/line limits. Metadata previews leave cached source intact. `full`/`expand` stay paged, with UTF-16 `nextOffset` and surrogate-safe ends. No-API continuation requires fresh retained data; errors are bounded too.
- Expanded/error rendering reuses only `Text`; collapsed rendering caches width/styled output and clears both on invalidation. Expanded display is not unbounded retrieval.

### Usage and maintenance consumers

- Validate quota windows, allowances, purchased balances, and resets separately. Manual balance output survives optional statistics failure. The opt-in footer requires TUI and an active cloud model. Its five-minute timer/after-turn cooldown share an in-flight/generation guard. Read the bound or first account without assigning one; record its balance.
- Disable/provider switch/shutdown abort footer requests, remove the timer, and clear status without canceling manual usage work. Stale results cannot publish; current failures clear the footer. Settings-panel polling has its own lifetime, backs off on rate limits, and cancels its timer/request on close/dispose.
- `completeOllamaChat()` shares assembly, requires tools, and checks exact IDs at registration/final payload. Its temporary runtime uses an in-memory key, resolved env, caller signal, 120000ms timeout, and `min(4096, model.maxTokens)`. Clean timers/directories in `finally`. Child-process fixture diagnostics isolate environment/signals from the CLI menu.
- Generation validates IDs, all details, exact standard prices, reasoning schema, and native-thinking warnings before formatting and single-snapshot replacement via a same-directory temporary file. Incomplete/invalid input, cancellation, or write failure keeps the old snapshot. Exclude Off-Peak/extra rounding; unmatched IDs stay unknown.
- Limit probes accept only validated HTTP 400 maximum-output errors as exact limits; success at every tier is a lower bound. Ambiguous results retain old values; no usable measurements means no replacement. Catalog assembly reads existing limits without probing. Dry-run suppresses file replacement, not network calls or inference charges.
- Live verification allows exact cloud endpoints/payloads and one request per slot, including a separate balance slot. Record before dispatch; reject retries, redirects, and extra requests. Attempt cache replay only for retained results. Restore fetch/env and dispose the session/temporary directory. The CLI rejects an existing report path; reports retain failure categories, not credentials or complete responses.

## 4. Conventions

- Use `.ts`/type-only imports; runtime excludes scripts/tests.
- Validate `unknown`, reject null/arrays and prototype-sensitive keys, and align TypeBox integer/URI constraints with execution.
- Keep clock/storage/transport injection and caller signals. Edit generators, not snapshots; order keys stably with `id`/`name` first.
- Put procedures in [the maintenance guide](docs/maintaining.md).

## 5. Working Agreements

Apply the [root working agreements](../../AGENTS.md). After code changes, run `pnpm --filter @buyong/pi-ollama-cloud typecheck` at the root. Separate account-file effects, live requests/probes, and offline verification.
