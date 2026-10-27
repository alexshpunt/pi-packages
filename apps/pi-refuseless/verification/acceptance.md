# Refuseless package acceptance record

**English** | [한국어](acceptance.ko.md)

Local verification passed for the source package and its npm archive. The automated checks use a local mock of the Refuseless API that serves a real `GET /v1/models` response captured on 2026-10-27. A live check on the real service then passed all 10 turns with each of three models.

On 2026-10-28 this record was updated for the credits display, `/pi-refuseless` and the catalog's `abliterated` flag. Those were checked against the mock only. The live check was not repeated, so its results below are from 2026-10-27.

## Checked package

| Item | Value |
| --- | --- |
| Package | `@buyong/pi-refuseless` 0.1.0 |
| Source | `apps/pi-refuseless` on branch `feat/pi-refuseless-credits`, based on `c0201d6`, uncommitted working tree of 2026-10-28 |
| Archive | `buyong-pi-refuseless-0.1.0.tgz` from `npm pack --ignore-scripts`, SHA-256 `6e7b0e47fa6d8d021386da7547f13ffd0384d634051023c1adcf2e8287dbe33b` |
| Archive files | `package.json`, `src/index.ts`, `src/api.ts`, `src/command.ts`, `src/credits.ts`, `src/credits-status.ts`, `src/models.ts`, `src/settings.ts`, `src/thinking.ts`, `README.md`, `README.ko.md`, `CHANGELOG.md`, `CHANGELOG.ko.md`, `LICENSE` |
| Extension entry | `pi.extensions: ["./src/index.ts"]`; `skills`, `prompts` and `themes` are `[]` |
| Command | `/pi-refuseless`; no tools or flags |
| Host peers | `@earendil-works/pi-ai: *`, `@earendil-works/pi-coding-agent: *`, `@earendil-works/pi-tui: *`; no runtime `dependencies` |
| Provider | ID `refuseless`, name `Refuseless`, `auth.apiKey` only (no OAuth), base URL `https://api.refuseless.com/v1`, API `openai-completions` |
| Environment | Installed Pi 1.4.0 (`~/.nvm/versions/node/v24.14.0/bin/pi`), workspace Pi SDK 1.3.0, Node.js 24.14.0, macOS 15.7.1 arm64 |

### Catalog conversion

The Refuseless documentation lists these model catalog fields: `id`, `object`, `created` and `owned_by` (openapi.json, `ModelObject`), an optional `context_length` (api/models), `reasoning_efforts` and `reasoning_default` (guides/reasoning), and a required boolean `abliterated` (openapi.json, `ModelObject`; api/models says to filter on it rather than on the `-abliterated` suffix). It lists no field for prices, output limits or input types.

The response captured on 2026-10-27 predates `abliterated` and has the other fields for six models:

- `context_length`: 524,288 for `deepseek-v4.1-flash-free`, 1,048,576 for the other five
- `reasoning_efforts`: `["off","low","high","max"]` for `deepseek-v4.1-flash-abliterated` and `deepseek-v4.1-flash-fast`, `["low","high","max"]` for the other four
- `reasoning_default`: `"low"` for all six
- `abliterated`: missing. The mock adds `true` for the three IDs that end in `-abliterated` and `false` for the other three; the real values were not checked

The package turns each catalog entry into a Pi model as follows:

| Pi field | Value |
| --- | --- |
| `id`, `name` | `id`; entries without a string `id` are skipped |
| `contextWindow` | `context_length` when positive, else 128,000 (Pi's default for custom models) |
| `reasoning`, `thinkingLevelMap` | From `reasoning_efforts`: each Pi thinking level sends the listed value of the same name (`none` counts as `off`), and levels not listed map to `null`. Without the field, no thinking levels. `reasoning` is false when only `off` is listed |
| `reasoningDefault` (extra field, saved with the model) | `reasoning_default` when it is one of the offered levels and the model has thinking levels |
| `abliterated` (extra field, saved with the model) | `abliterated` when it is a boolean, else unset; the ID is not used |
| `maxTokens` | 131,072 (the Pi setup in docs.refuseless.com/sdks), capped at `contextWindow` |
| `input` | `["text"]` |
| `cost` | All zero |
| `compat` | `supportsDeveloperRole: false`; openapi.json `ChatMessage.role` lists `system`, `user`, `assistant`, `tool` |

### Credit balance

`GET /v1/credits` (api/credits) returns `balance`, `reserved`, `available` and `key_limit` in US dollars and charges nothing. The package reads it with the key Pi resolves for `refuseless` (the saved key, else `REFUSELESS_API_KEY`) from the provider's base URL, including a `models.json` override. A response without numeric `balance`, `reserved` and `available` is an error, and a `key_limit` that is not a number counts as no budget. Amounts show at least 2 and up to 6 decimal places.

| Where | What it shows | When it reads |
| --- | --- | --- |
| Status line (key `refuseless-credits`) | `Refuseless <available>`, as in `Refuseless $41.30`; nothing without a key or after a failed read | Interactive Pi only, while a Refuseless model is active: session start, model pick, each `agent_end`, and turning the switch on |
| `/pi-refuseless` in interactive Pi | `Available`, `Balance`, `Reserved`, `Key limit` (`none` for null) or the error, and the switch `Credits in status line` | Once when the panel opens; closing the panel cancels the read |
| `/pi-refuseless` in other modes | The same four lines as a notification (RPC) or on stderr (print, JSON) | Once |

A newer read, a switch to another provider's model, turning the switch off and `session_shutdown` cancel a read still running, and its result is dropped. The switch is on unless `refuseless.json` in Pi's agent directory has `"creditsStatus": false`. Changing it applies at once and merges the value into that file, keeping other keys, through a temporary file and a rename. A file that is not a JSON object is left unchanged; the panel then shows the reason, and the choice lasts until Pi restarts or reloads.

## How to reproduce

Run the checks from the repository root after `pnpm install`:

```bash
pnpm --filter @buyong/pi-refuseless typecheck
pnpm --filter @buyong/pi-refuseless test:unit
pnpm --filter @buyong/pi-refuseless cli verify
```

`cli verify` runs the steps below in order and writes the validator reports and `summary.json` to the directory it prints. To run the validator and TUI steps by hand instead, run these from `apps/pi-refuseless`:

```bash
pi_root="$(dirname "$(dirname "$(dirname "$(realpath "$(command -v pi)")")")")"   # installed pi-coding-agent
reports="$(mktemp -d)"
node verification/scripts/validate-package.mjs . --expect verification/inventory.json \
  --runtime --pack --pi-root "$pi_root" --report "$reports/source.json"
archive_dir="$(node -e 'console.log(require(process.argv[1]).artifact.packageDir)' "$reports/source.json")"
node verification/scripts/validate-package.mjs "$archive_dir" --expect verification/inventory.json \
  --runtime --pi-root "$pi_root" --report "$reports/archive.json"
REFUSELESS_PACKAGE_DIR="$archive_dir" REFUSELESS_PI_SDK="$pi_root" pnpm exec vitest run test/integration.test.ts
```

The `pi_root` line assumes the npm global layout (`…/pi-coding-agent/dist/bundle/cli.js`); `cli verify` finds the package root itself.

To repeat the live check on the real service, run this from the repository root with your own key. Chat requests spend credits:

```bash
REFUSELESS_API_KEY=<key> pnpm --filter @buyong/pi-refuseless cli live --model glm-5.3-abliterated --model glm-5.3-flash-abliterated --model deepseek-v4.1-flash-abliterated
```

## Results

| Check | Target and Pi | Status | Evidence |
| --- | --- | --- | --- |
| `typecheck` (`tsgo --noEmit`) | source | pass | exit 0 |
| `lint` (`biome check .`) | source | pass | exit 0 |
| All tests, 80 cases | source, Pi 1.3.0 | pass | `test/provider.test.ts` 40, `test/credits.test.ts` 19, `test/integration.test.ts` 10, `test/cli.test.ts` 11; the full suite passed 3 consecutive runs |
| TUI flow tests, 10 cases | source, Pi 1.4.0 | pass | `REFUSELESS_PI_SDK` set to the installed Pi |
| Validator with inventory, runtime and pack | source, Pi 1.4.0 | pass | 79 pass, 2 skipped, 4 not_applicable |
| Archive file list matches the inventory (`verification/inventory.json`) | archive | pass | the 14 files under Checked package |
| Validator with inventory and runtime | archive, Pi 1.4.0 | pass | 47 pass, 1 skipped, 6 not_applicable |
| TUI flow tests, 10 cases | archive, Pi 1.4.0 | pass | `REFUSELESS_PACKAGE_DIR` set to the extracted archive |
| Installed CLI fetches the list (RPC-mode start) | source and archive, Pi 1.4.0 | pass | `get_available_models` reports the mock's 6 models; the mock saw `GET /v1/models` with `Bearer abl_verify` |
| Installed `pi -p` with the saved list | source and archive, Pi 1.4.0 | pass | `POST /v1/chat/completions (Bearer abl_…, model=glm-5.3-flash-abliterated, reasoning_effort=high, messages=2, tools=4)`; a new session starts at Pi's default level `medium`, which Pi moves up to `high` because Refuseless has no `medium` |
| Installed `pi -p "/pi-refuseless"` | source, Pi 1.4.0 | pass | the four balance lines on stderr and exit 0; the mock received only `GET /v1/credits (Bearer abl_…)` |
| Import review | source | pass | see below |
| Release tooling | repository | pass | `changelog.mjs check` exit 0; `dry-run.mjs --list` lists `pi-refuseless` with `hasConfig: true` and no changelog problems; `configProblems` is empty |
| Credential scan | 31 package files, 14 archive files, reports | pass | only fixture keys such as `abl_unit-test-key`; the mock log shows the first four key characters; the live-check key is in no file |
| `GET /v1/models` with a valid key | real service, Pi 1.4.0, 2026-10-27 | pass | each model appeared in Pi's model list after an RPC-mode start with the test key |
| Live conversation, 10 turns per model, three models at once (`cli live`) | real service, Pi 1.4.0, 2026-10-27 | pass | 30 of 30 turns; see [Live service](#live-service) |

Validator entries that are not `pass`:

- `skipped`, semantic import and bundle inspection: reviewed by hand. The source files import only `@earendil-works/pi-ai` and its `compat` entry (mapped by the Pi 1.3.0 and 1.4.0 extension loaders), `@earendil-works/pi-coding-agent` (types, plus `DynamicBorder`, `getSettingsListTheme` and `getAgentDir`), `@earendil-works/pi-tui` (`SettingsList`, `Text`), `node:crypto`, `node:fs`, `node:path`, and the package's own files; they use the global `fetch`. Nothing imports another app or a development file.
- `skipped`, extracted artifact runtime and behavior (source report only): done by the archive validator run, the archive TUI tests and the archive CLI checks.
- `not_applicable`: theme contract and the skill, prompt and theme filters (the package has none); npm metadata and the packed artifact in the archive run (packing applies to the source).

## Native user flow

`test/integration.test.ts` runs Pi's own `InteractiveMode` in-process with a virtual terminal and types what a user types. Pi loads the package through its resource loader from the package directory, as `pi -e <dir>` does. The agent directory's `models.json` points `refuseless` at a local mock that serves the real catalog. Pi's own catalog server is replaced by a closed local port, and the test fails if any request leaves 127.0.0.1. Observed on Pi 1.3.0 and 1.4.0, for the source and the archive:

| Step | Observation |
| --- | --- |
| Startup | One provider with ID `refuseless` and no models. The other provider IDs and the selected model equal a run of the same agent directory without the package. |
| `/login` | `Select authentication method:` → `Sign in with an API key` → `Select provider to configure:`; filtering for `Refuseless` shows `Refuseless • not configured`, or `Refuseless ✓ stored` once a key exists. |
| Key prompt | `Login to Refuseless` / `Enter Refuseless API key`. Entering `  abl_tui-native-key  ` prints `Saved API key for Refuseless. Credentials saved to <agent>/auth.json`. |
| Stored credential | `auth.json` keeps a pre-existing credential for another provider unchanged and adds `"refuseless": { "type": "api_key", "key": "abl_tui-native-key" }`. The session model and the default-model setting are unchanged. |
| Model list | Right after login Pi sends `GET /v1/models` with `Bearer abl_tui-native-key` and lists all six catalog models, abliterated or not. |
| `/model` | Filtering for a model shows `<id> [refuseless]`; choosing it shows `Model: <id>`. |
| Request | The reply `Mock Refuseless reply from glm-5.3-flash-abliterated` appears; the mock received one `POST /v1/chat/completions` with `Bearer abl_tui-native-key` and that model ID. |
| Starting level | In a new session without a model (thinking level `off`), picking `deepseek-v4.1-flash-abliterated`, which supports `off`, shows `deepseek-v4.1-flash-abliterated • low` and sends `reasoning_effort: "low"`. |
| Chosen level | Shift+Tab moves through `high`, `max` and `thinking off`. Switching to `deepseek-v4.1-flash-fast` keeps `off` and sends `"off"`. Switching to `glm-5.3-abliterated` offers only `low`, `high`, `max`; Pi moves `off` to `low` and sends `"low"`. |
| Restart | A new process on the same agent directory starts with the six saved models and sends `Bearer abl_tui-native-key` for `minimax-m3.1-flash` without another login. |
| Rejected key | Entering `wrong-key` saves it, the model list request gets `401`, and Pi shows `Saved API key for Refuseless, but its model catalog could not be refreshed; using cached models.`; no models are listed. |
| Cancelled first login | Escape at the key prompt saves nothing; `auth.json` keeps only the pre-existing credential. Pi reports `Failed to save API key for Refuseless: This operation was aborted`. Pi shows the same message for its built-in Cerebras key prompt, so the message comes from Pi, not from this package. |
| Cancelled and blank replacement | Escape, and Enter on `   `, keep the saved key. The blank entry shows `Failed to save API key for Refuseless: API key is empty`. The next request still sends the saved key. |
| `/logout` | `Select provider to logout:` → Refuseless → `Removed stored API key for Refuseless. Environment variables and models.json config are unchanged.` Only the `refuseless` entry is removed, and no Refuseless key resolves afterwards. |
| Selected model routing | After picking a model, every chat request of the session carries that model ID and the Refuseless key, including a tool round trip. A second provider configured for the test (`stub`) receives nothing. |
| New session | With the test's second provider (`stub`) saved as the default, a new session starts on `stub-model`, not on the previously picked Refuseless model, and Pi shows no warning. The status line shows `(stub) stub-model`. With the Refuseless model saved as the default, a new session starts on it. |
| Credits in the status line | With a saved key, nothing is read before a Refuseless model is picked. Picking `glm-5.3-flash-abliterated` shows `Refuseless $41.30` in the status line, and the mock receives `GET /v1/credits` with the saved key. After the reply, Pi reads the balance again. |
| `/pi-refuseless` | Shows `Refuseless credits`, `Available  $41.30`, `Balance    $42.50`, `Reserved   $1.20`, `Key limit  none` and `Credits in status line  on`, after one more balance read. |
| Turning it off | Enter on `Credits in status line` shows `off` and writes `{"creditsStatus": false}` to `<agent>/refuseless.json`. Later replies read no balance, also in a new process on the same agent directory, where `/pi-refuseless` shows `off`. |
| `/pi-refuseless` without a key | Shows `No Refuseless API key. Run /login and choose Refuseless.` and `Credits in status line  on`, and sends nothing. |
| `/reload` | With a saved key and no saved model list, opening `/model` fetches the list. After `Reloaded keybindings, extensions, skills, prompts, themes, and context files` there is still one `refuseless` provider, Pi restores the same six models from the saved list, they still point at the mock, and the saved key is used for the next request. |

Pi 1.4.0's source also shows that compaction and cache warming use the session's own model and key, so they do not reach another provider.

## Model list and requests

`test/provider.test.ts` covers:

- Model list request: `GET /v1/models` sends the saved key, or, through Pi, `REFUSELESS_API_KEY` when no key is saved. Without any key it sends nothing and keeps the saved model list. A `401`, a `503` or a response without `data` fails with the HTTP status and the Refuseless error.
- Conversion: the rules in [Catalog conversion](#catalog-conversion), including a missing `context_length`, the `none` alias, a context smaller than the output limit, and entries without an ID. `abliterated` follows the flag whatever the ID says (`true` for an ID without the suffix, `false` for one with it); a missing or non-boolean flag leaves it unset, and it is restored with the saved model list.
- Saving and restoring: with a `models.json` endpoint override, Pi fetches from the override, saves the model list, and restores it in a new runtime without a request. A model removed from the catalog disappears on the next refresh, and a failed refresh keeps the previous model list.
- Thinking levels sent: every Pi level on the real catalog and on made-up entries (`["high","max"]`, only `off`, no `reasoning_efforts`). The mock rejects any value a model does not list. On a model without `off`, a request without a thinking level sends no `reasoning_effort`, and a model with only `off` never sends one.
- Starting level: `reasoning_default` is kept when the model supports it and ignored otherwise (`none` counts as `off`), and it is restored with the saved model list. When you switch from no model, or from a model without thinking levels, to a Refuseless model, Pi carries over `off`, or the model's lowest level if it has no `off`. The package then replaces that level with the model's `reasoning_default`. A level set any other way stays, and a resumed session is not changed. The tests cover each case, including a previous model with thinking levels, a level set by a Pi setting, and a level already at the default.
- Chat requests: the `system` role for the system prompt with every model, text with `reasoning_content`, tool calls and results, usage with cached tokens, and cancellation mid-stream. HTTP 401, 402, 404, 429 and 503, an invalid JSON frame, a stream without `finish_reason`, and the mid-stream `insufficient_credits` event each end with one `error` event and no `done`.

Streaming and requests use Pi's built-in OpenAI chat-completions implementation.

## Credits display

`test/credits.test.ts` covers the rules in [Credit balance](#credit-balance):

- Request: `GET /v1/credits` sends the key. A key budget is kept, and a missing one counts as none. HTTP 401 `invalid_key`, 429 `rate_limit_exceeded`, 503 `gateway_down` and a body without amounts fail with the HTTP status and the Refuseless error.
- Key and endpoint, through Pi's `ModelRegistry` and `ModelRuntime`: without a key nothing is sent; then `REFUSELESS_API_KEY`, and then the saved key, each go to the `models.json` endpoint. Without a provider base URL the request goes to `https://api.refuseless.com/v1/credits`, which the test blocks.
- Status line: shown at session start, read again after `agent_end`, and cleared on a switch to another provider's model and on `session_shutdown`; nothing is read while another model is active. Print mode shows and reads nothing. No key, and a `401`, clear the entry. A read still running when the model changes is cancelled (the mock sees the connection close), and its result is dropped.
- Switch: off clears the entry and saves `creditsStatus: false` beside an unknown key, which stays. A new extension instance starts off and reads nothing; turning it on reads at once. A file that is not valid JSON is left unchanged, the call returns the reason, and a new instance starts on.
- Other modes: in print mode the balance goes to stderr. In RPC mode the balance (`info`), a missing key (`error`) and a `401` (`error`) are notifications.
- Amounts: `$41.30`, `$0.00`, `$0.000125`, `$1,234.50`.

## Live service

On 2026-10-27, `cli live` ran with a valid API key against `glm-5.3-abliterated`, `glm-5.3-flash-abliterated` and `deepseek-v4.1-flash-abliterated` at the same time. For each model, the installed Pi 1.4.0 loaded the package in a new agent directory, fetched the model list, switched to the model, and held this conversation:

`—` in the thinking level column means the turn keeps the previous turn's level.

| Turn | Prompt | Thinking level set | Passes when |
| --- | --- | --- | --- |
| 1 | Reply READY | — | reply has `READY` |
| 2 | Remember the code word AMBER-42 | — | reply has `OK` |
| 3 | 17 × 23 | — | reply has `391` |
| 4 | Run `cat notes.txt` with bash | — | bash runs; reply has `4096` |
| 5 | Create `result.txt` with bash | — | bash runs; the file has `pi-refuseless-ok`; reply has `DONE` |
| 6 | Why the sky looks blue | `high` | reply mentions scattering or wavelength |
| 7 | The primary colors of light | `low` | reply has red, green and blue |
| 8 | Recall the code word | — | reply has `AMBER-42` |
| 9 | "Good morning" in Korean | `off` | reply has Korean text |
| 10 | Summarize the conversation | — | reply is not empty |

Every turn also had to end with `stopReason` `stop`, and every reply had to come from `refuseless/<model>`.

| Model | Turns passed | Starting thinking level | Tokens, input (with cached) / output |
| --- | --- | --- | --- |
| `glm-5.3-abliterated` | 10/10 | `low` | 20,090 / 346 |
| `glm-5.3-flash-abliterated` | 10/10 | `low` | 19,834 / 228 |
| `deepseek-v4.1-flash-abliterated` | 10/10 | `low` | 22,313 / 238 |

- Each model started at `low`, its `reasoning_default`, as the starting-level rule gives for a new session.
- The GLM models do not support `off`, so Pi used `low` for turns 9 and 10. `deepseek-v4.1-flash-abliterated` ran turns 9 and 10 at `off`.
- In Pi, `deepseek-v4.1-flash-abliterated` showed no thinking text on any turn, at any level. A direct request to `https://api.refuseless.com/v1/chat/completions` with `reasoning_effort: "high"` returned only `"."` as `reasoning_content`, so this comes from the service. The GLM models returned thinking text on some turns, up to 492 characters (`glm-5.3-abliterated`, turn 6 at `high`).
- The other models in the list (`deepseek-v4.1-flash-fast`, `minimax-m3.1-flash`, `deepseek-v4.1-flash-free`) were not tried on the real service.
- One unintended live request happened while the test harness was being written: the prototype wrote `models.json` outside the agent directory, so a single `Say ok.` request with the fixture key `abl_tui-test-key` reached `https://api.refuseless.com/v1/chat/completions`. The service returned `401 {"code":"invalid_key","message":"Invalid API key.","type":"api_error"}`, matching the documented error. It used no credits and proves nothing about successful inference. The harness now writes the override itself, refuses to start unless every Refuseless model points at the mock, and fails a test on any request that leaves 127.0.0.1.

## Known limits

- A model picked in `/model` with Enter applies to the current session only. A new session starts on the first model Pi finds in this order: a `--models` model, the saved default model (Ctrl+S in `/model`), then the first available model, preferring Pi's built-in default for each provider; Refuseless has none. Pi prints no warning for this, so `/model` and the status line are the only indication.
- Pi's own model-restore fallback (`Could not restore model …. Using …`) applies to resumed sessions whose saved model is unavailable. These checks did not reach it, because the test harness starts a new session each time.
- The model list is fetched by interactive Pi (after login, when `/model` opens, at startup) and by RPC-mode startup. `pi -p` and `pi --list-models` use only the saved list, and `pi update --models` does not refresh catalogs of extension providers (observed with Pi 1.4.0). A first `pi -p --model refuseless/…` in a fresh agent directory therefore needs one interactive session first.
- If a catalog entry omits `reasoning_efforts`, the model has no thinking levels in Pi. Its requests carry no `reasoning_effort`, so Refuseless uses the model's own default.
- When you switch from no model, or from a model without thinking levels, Pi does not tell extensions where the thinking level came from. So a per-model or default thinking level of `off` (or of the model's lowest level, when it has no `off`) is replaced by `reasoning_default` too. A new session that starts on a Refuseless model follows Pi's own rule: `--thinking`, then the `/settings` default, else `medium`, which Pi moves up to `high`.
- Output limits, input types and prices are not in the catalog. All models use 131,072 output tokens (capped at `contextWindow`), text-only input and no cost display, even where refuseless.com or the Refuseless SDKs guide states other values.
- After a first login without a selected model, Pi 1.3.0 and 1.4.0 also print `Saved API key for Refuseless, but no default model is configured for provider "refuseless". Use /model to select a model.` The message comes from Pi; the README tells users to continue with `/model`.
- A `refuseless` entry with models in `models.json` (from the Pi setup in the Refuseless SDKs guide) replaces this package's models that have the same IDs, including their thinking levels. The README says to remove it.
- The credits display, `/pi-refuseless` and `abliterated` were checked only against the mock, which follows the documented response shapes. The real `GET /v1/credits` and the real `abliterated` values have not been tried.
- The status line shows only `available` and is read after each reply, not during it, so a long reply can lower the balance before the status line changes. `/pi-refuseless` reads once when it opens and does not refresh while it is open.
- `balance` counts paid credits only (api/credits); promo credits and plan allowances are not shown.
- Refuseless allows 60 balance reads per minute per key. The status line reads once per session start, model pick and reply; if it ever gets a `429`, it shows nothing until the next successful read.
