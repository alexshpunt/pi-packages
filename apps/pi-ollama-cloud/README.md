# @buyong/pi-ollama-cloud

**English** | [한국어](README.ko.md)

Connects Pi to the Ollama Cloud API without a local Ollama server. The extension provides the cloud model list, web search and page reading, usage reports, and per-session rotation across several accounts.

Source and releases live in [`buYoung/pi-packages`](https://github.com/buYoung/pi-packages/tree/main/apps/pi-ollama-cloud); the npm name is unchanged. The package is a fork of [fgrehm/pi-ollama-cloud](https://github.com/fgrehm/pi-ollama-cloud) and keeps the Git history and MIT license of the former `buYoung/pi-ollama-cloud` repository.

## Install and first use

You need Node.js 22.19 or later, Pi, and an [Ollama Cloud API key](https://ollama.com). The package is developed and tested with Pi 1.3.0, and CI also checks compatibility with the latest Pi.

If you installed from Git, or still use commands or import paths from 0.13 or earlier, first follow [Move from earlier versions](#move-from-earlier-versions), so that only one copy of the extension loads. Otherwise install from npm:

```bash
pi install npm:@buyong/pi-ollama-cloud
```

To install for one project only, run `pi install npm:@buyong/pi-ollama-cloud --local` instead. Project resources follow Pi's project trust setting.

Start Pi, then:

1. In `/login`, choose **Use an API key → Ollama Cloud** and enter your key, or set `OLLAMA_API_KEY` in the environment that runs Pi. Skip this step if a key is already registered. Do not put keys in a repository or in settings examples.
2. In `/model`, select an `ollama-cloud` model.
3. Send a short question and check the reply. This and later model replies and web tools use real API quota. `/ollama` shows per-account usage and settings.

To use more accounts, add them with **+ Add account** in `/ollama`; see [Use several accounts](#use-several-accounts).

### Update

```bash
pi update npm:@buyong/pi-ollama-cloud
```

`pi update` without a target updates Pi itself. To update every installed extension, run `pi update --extensions`. An installation pinned to an exact version does not move to a new version on its own; run `pi install` again with the new version.

## Tools and commands

| Name | Purpose |
| --- | --- |
| `ollama_web_search` | Ollama Cloud web search. Required: `query`. Optional: `max_results` (default 5, maximum 10), `expand`, `offset`, `refresh` |
| `ollama_web_fetch` | Reads a web page's title, body, and links. Required: `url`. Optional: `full`, `offset`, `refresh` |
| `/ollama` | Opens the [settings screen](#settings-screen) in the TUI. Without a TUI, prints the settings and an account summary. |
| `/ollama usage` | Shows balance, quota, status, and known reset dates for every account, plus request statistics for the current session's account. |
| `/ollama status [on\|off]` | Turns the usage display in the TUI footer on or off. Without an argument, switches the current state. Saved to the global settings. |
| `/ollama webtools [on\|off]` | Turns the web tools on or off. Without an argument, switches the current state. Saved to the global settings. |

Without a UI, as in print and JSON modes, `/ollama` writes its summary, usage, settings-save results, and errors to stderr. The JSON-mode event stream on stdout carries no command messages.

The web tools use the same account as model requests: the API key of the account assigned to the current session.

- **`ollama_web_search`**: Each result shows a body preview of up to 500 characters by default. To read more of one result, repeat the same `query` and `max_results` with `expand=<result number, starting at 1>`. To continue, keep `query`, `max_results`, and `expand` and pass each returned `nextOffset` as `offset`; the result also names this next call. `offset` without `expand` is a position in the result-list text.
- **`ollama_web_fetch`**: Returns the page body in 3000-character pieces by default. `full=true` is not unlimited; it requests the largest piece that fits the output limit. While body text remains, the result includes `nextOffset`; pass it as `offset` with the same `url` until no `nextOffset` is returned.
- The combined `content` and `details` follow Pi's output limit (51,200 bytes and 2,000 lines in Pi 1.3.0). Titles, URLs, links, and body text in `details` are length-limited previews as well.
- `offset` is a UTF-16 position in a JavaScript string. Pass `nextOffset` as is rather than calculating it. Reading on makes no extra API call while the cached entry is within its lifetime (24 hours by default) and has not been evicted. After the entry expires or is evicted, or another call refreshes it with `refresh=true`, the search or page is fetched again and its text can change.
- Both tools accept `refresh=true` to bypass the cache. `# live query` in a result means a new request or a shared in-flight request; `# from cache` means a cached result.

## Use several accounts

With several accounts registered, each session keeps one account and each new session gets the next account. When an account reaches its usage limit, the session moves to the next account.

Before adding accounts: the extension cannot tell apart several keys from the same Ollama account, and those keys share one usage limit. Register only accounts that each person legitimately owns. Ollama can treat creating extra accounts to avoid limits as abuse. For shared use by several people, consider the Team plan.

### Accounts

- **Default account (`default`)**: Pi's `ollama-cloud` credential. Set it with `/login` or `OLLAMA_API_KEY`; Pi needs it to mark the models as available. Remove it with `/logout`.
- **Additional accounts**: Stored in `~/.pi/agent/ollama-cloud-accounts.json`, which follows Pi's agent directory if you change it. The format matches Pi's `auth.json`, and the file is read and written through Pi's credential storage, so it has the same `0600` permissions and locking. A key can be written as a literal value or as a `$ENV`, `${ENV}`, or `!command` reference.
- An account ID has 1 to 32 characters: lowercase letters, digits, `-`, and `_`, starting with a letter or digit. `default`, `ollama-cloud`, and Pi's built-in provider names (such as `anthropic`) are not allowed.

In the TUI, **+ Add account** in `/ollama` asks for the key or reference first, then the account ID. An empty ID becomes an unused one such as `account-1`. Keys being typed and keys in the account list show only their first 6 characters, even if you paste a key into the name field by mistake. After saving, the extension checks the key with `/api/balance` and does not save it if Ollama rejects it or it duplicates a registered key. Without a TUI, edit the file directly; the next request reads the changed file.

```json
{
  "work": { "type": "api_key", "key": "$OLLAMA_WORK_API_KEY" },
  "personal": { "type": "api_key", "key": "!op read op://Private/ollama/credential" }
}
```

Pi 1.3.0 caches `!command` results until the process exits. If the command returns a new key, restart Pi to read it; `/reload` does not run the command again.

### Per-session rotation

- A session's first Ollama Cloud request (a model reply or a web tool) assigns the next account in turn. The order is `default`, then the order in `ollama-cloud-accounts.json`; after the last account it starts over.
- The assignment is recorded in the session file. Restarting Pi, `/resume`, or `/reload` keeps the same account for the same session. `/new` and forks are new sessions and get the next account.
- Compaction requests and web tools in the same session use that account too. Several Pi processes and subagents share the rotation order and account state through `~/.pi/agent/ollama-cloud-account-state.json`. That file stores key fingerprints, limit times, and balance responses, never the keys.
- To switch the current session's account yourself, select an account in `/ollama` and choose **Use for this session**.

If the state file is locked or saving fails, the change is kept in the current process only. It is saved with the next update if no other process changed the file in the meantime; otherwise the file's state wins.

### Account switching and limits

If one of these errors arrives before a reply starts, the extension marks the account and sends the same request to the next account. The session moves to the new account and shows a notice once.

| Response | Handling |
| --- | --- |
| 429 `session`, `weekly`, or `monthly usage limit` | The account is skipped until the reset time reported by `/api/balance`. Without a reported time, it is retried after 30 minutes (session), 6 hours (weekly), or 24 hours (monthly). |
| 401 key rejected | The account is skipped until you run **Clear limit markers** in `/ollama` or its key changes. The next request reads `$ENV` and `${ENV}` references again, so if the variable now gives a different key, the account is used again. A `!command` reference keeps its cached result until Pi restarts (see [Accounts](#accounts)). |
| 403 model rejected | The account is skipped for that model only, for 6 hours. A 403 on a web tool request does not switch accounts. |

If the concurrent-request limit (`429 "too many concurrent requests"`) hits before a reply starts, the extension resends on the same account instead of switching. When several sessions or subagents share one account, a slot frees only when another request finishes. It waits about 1, 2, 4, 8, and 16 seconds (each scaled randomly by 0.5 to 1.5), resending up to five times, and shows a notice once when it first waits. If no slot frees, Pi's own retries take over. Cancelling during a wait stops immediately.

Other rate limits (429), server errors, and errors after a reply starts do not switch accounts; Pi's own retries handle them. If no account is usable, the extension returns an error with each account's reason and `quota exceeded`, which Pi does not retry automatically.

## Purchased-credit protection

Ollama spends included usage first and then draws on purchased credits. Because requests keep succeeding without a limit error while purchased credits remain, the extension stops sending requests on an account that holds purchased credits once its included usage drops to 3% or less. This applies even with a single account.

- Before each account's first request, the extension queries `/api/balance` once. Accounts without purchased credits are checked again every 15 minutes to notice a new purchase; accounts with purchased credits are checked every 30 seconds to 10 minutes, depending on how much is left.
- If a balance check rejects the key (401), the next check of that account reads referenced keys again. New environment-variable values apply without `/reload`; `!command` references follow the Pi process cache described above.
- Usage between two checks cannot be stopped. The less included usage remains, the more often the extension checks, to keep that gap small.
- An account whose balance has never been checked successfully is not blocked; it shows `available (balance not verified)`.
- An account with confirmed purchased credits is blocked when a balance recheck fails and either less than 10% of included usage remains or the last successful check is 30 minutes old or more. The balance check is retried after 1 minute, and requests resume once it succeeds.

## Settings screen

Run `/ollama` in the TUI to open the settings screen. Move with the up and down arrows, change an item with Enter or Space, and close with Esc.

A usage report appears right below the title. For each account it shows a quota bar, the included balance and reset date, and purchased credits; for the current session's account (the first account before assignment) it also shows the 7-day request count. The report refreshes only while the screen is open and stops querying when you close it.

- The balance (`/api/balance`) of every account is queried every 5 seconds. The next query is scheduled after the previous one finishes, so requests do not overlap.
- Request statistics (`/api/usage`) have a low rate limit and are queried once every 15 seconds. External observation shows a 429 above about 5 requests per minute.
- If a balance query gets a 429, it is retried after 30 seconds and the report says so.

| Item | Behavior |
| --- | --- |
| Usage status bar | Turns the footer usage display (`usageStatus`) on or off. Saved to the global settings file. |
| Web tools | Turns `ollama_web_search` and `ollama_web_fetch` on or off. Saved to the global settings file; locked while `PI_OLLAMA_WEB_TOOLS` turns them off. |
| Account rows | Show the account ID (`*` marks the current session's account), the first 6 characters of the key, the latest usage, and the status. Usage refreshes with the report. Press Enter to choose **Use for this session**, **Disable**/**Enable**, **Clear limit markers**, or **Remove account** (additional accounts only, after confirmation). |
| + Add account | Enter a key or a `$ENV` or `!command` reference, then the account ID (empty becomes `account-N`). Keys show only their first 6 characters. |

The `default` account cannot be removed here; remove it with `/logout`.

## Settings

The global settings file is `~/.pi/agent/ollama-cloud.json`, and the project settings file is `.pi/ollama-cloud.json`. The global file follows Pi's agent directory if you change it.

```json
{
  "webTools": true,
  "usageStatus": false
}
```

Project settings take precedence over global settings. The `PI_OLLAMA_WEB_TOOLS` environment variable takes precedence over both files; `0`, `false`, `no`, `off`, or an empty value (in any letter case) turns the web tools off, and `/ollama` cannot turn them back on. Any other value turns them on. After editing a settings file, restart Pi or run `/reload`.

Changes made in `/ollama` to the footer usage display and the web tools apply immediately and are saved to the global settings file; other keys in the file are kept. If project settings set the same item, or `PI_OLLAMA_WEB_TOOLS` turns the web tools on, `/ollama` tells you when you change it, and that value takes precedence again at the next start. If the global settings file is not valid JSON, it is not overwritten and the change applies to this run only.

The footer usage display is off by default. When on, it refreshes every 5 minutes only while an `ollama-cloud` model is in use in the TUI, and the end of a conversation turn respects the same 5-minute interval. Turning the display off, switching to another provider, or exiting Pi cancels pending queries and the timer. Outside the TUI, no background queries run. With several accounts, the display shows the current session's account by name (`default` before assignment). The results also feed purchased-credit protection. `/ollama usage` and the usage report on the settings screen are explicit queries, so they call the API even while the display is off.

### Web tool cache

The default file is `~/.pi/agent/cache/pi-ollama-cloud/cache.json`, with `0600` permissions.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `PI_OLLAMA_SEARCH_TTL_HOURS` | `24` | How long successful results are kept |
| `PI_OLLAMA_SEARCH_FAIL_TTL_MINUTES` | `15` | How long cacheable page failures are kept |
| `PI_OLLAMA_SEARCH_CACHE_PATH` | `cache/pi-ollama-cloud/cache.json` in the agent directory | Cache file location |
| `PI_OLLAMA_SEARCH_MAX_ENTRIES` | `500` | Maximum entries, separately for searches and pages |
| `PI_OLLAMA_SEARCH_SNIPPET_CHARS` | `500` | Search result preview length |
| `PI_OLLAMA_SEARCH_CHUNK_CHARS` | `3000` | Page body piece length |

Authentication errors, rate limits, network errors, server errors, and malformed responses are not stored as cached failures. When a `refresh=true` request fails with one of these errors, the earlier entry is removed as well, so the next request retries normally.

The cache is limited to 8 MiB in memory (measured as serialized data) and, on disk, 256 KiB per entry and 8 MiB in total. The memory figure is not a limit on process heap or RSS. When the total limit is reached, whole old entries are removed instead of truncating text. An entry larger than 256 KiB stays in memory only, so another process or a later session fetches it again.

Identical requests in flight at the same time that use the same cache and credentials share one result. Cancelling one call ends only that call; the request stops once every sharing call is cancelled. When several processes use the cache file, saves merge changes under a lock. After another process saves, entries that exist only in memory and not on disk can be dropped.

The cache stores full page text and URLs, and sessions that use the same cache path reuse them. Do not put secrets in URL query strings. If a write fails or the lock wait times out, the entry may not reach the disk.

## Models and thinking levels

- The provider name is `ollama-cloud`, and the endpoint is `https://ollama.com/v1`.
- Models and their capabilities come from `/v1/models` and `/api/show`; only models that support tool calls are registered.
- Pi refreshes the model list at startup, when `/model` opens, and on `pi update --models`. Without credentials, the extension uses the model list bundled in the package and makes no network request.
- Thinking levels come from valid `thinking.values` in `/api/show` first, then from the models.dev data bundled in the package, then from the defaults `off`, `low`, `medium`, `high`, and `xhigh` (`xhigh` is sent as `max`). The server's default level never replaces the level you choose. For models confirmed to keep reasoning when asked to stop (the `gpt-oss` family and `minimax-m2.7`), `off` is hidden.
- An unknown context length defaults to 128,000 tokens; models without a measured output limit default to 32,768 tokens.
- A healthy catalog refreshes every 4 hours. A partial or complete failure, or an empty list, keeps the last good list and its success time and retries after 15 minutes by default (`PI_OLLAMA_MODEL_FAIL_RETRY_MINUTES`). A forced refresh skips the interval.
- The model list is stored in Pi's model store. `~/.pi/agent/cache/pi-ollama-cloud/catalog-state.json` holds only failure, source, and retry information. When a stored list is restored, the package's current prices, output limits, and compatibility rules are applied again.
- The package bundles first-run model, price, and thinking data and measured output limits. This data fills in values the API does not provide, so unlike the live model list it changes only with a new release.

### Price limitations

Prices are estimates based on the standard per-million-token rates on the [Ollama pricing page](https://ollama.com/pricing). They do not guarantee actual charges or credit deductions, and Off-Peak discount hours are not included. Models without a known price show `unknown (not free)` in the development CLI's model metadata view. Pi's numeric cost fields can contain 0, but **that does not mean free**.

Price data is fixed in the package and changes only with a new release. Unconfirmed `:cloud` aliases and date tags do not inherit another ID's price or output limit. If the API does not report cached-token usage, cache discounts are not reflected in `/cost` either. The `cacheWrite` cost field is always 0.

## Limits and support

This extension does not go through a local server as `ollama launch pi` does, and it does not provide local models. Because the provider names differ (`ollama` and `ollama-cloud`), you can use both approaches together. Do not load more than one copy of this extension, though, for example a global and a `--local` installation, or a Git and an npm copy.

Each model detail request has a 10-second limit. If only some detail requests fail, the whole last good catalog is kept. If a model outputs raw markup instead of structured tool calls, retry with another model and report it in an [issue](https://github.com/buYoung/pi-packages/issues) with keys and personal information removed from the reproduction details.

## Move from earlier versions

### From a Git installation to npm

npm installations need no change. For a **Git installation**, find the package entry in `pi list`, remove it, and install from npm:

```bash
pi remove git:github.com/buYoung/pi-ollama-cloud
pi install npm:@buyong/pi-ollama-cloud
```

For a project installation, add `--local` to both commands. If you used another URL form or pinned a version, remove the exact entry shown by `pi list`. For a copy cloned by hand into `~/.pi/agent/extensions/`, save any local changes first, then move it out of the auto-discovery path. Do not load Git, local, and npm copies at the same time.

After the switch, the `ollama-cloud` credential, settings files, cache paths, and public tool names stay the same. `pi install git:github.com/buYoung/pi-packages` installs the repository root, not this app; to run a source checkout, use the commands in [Load in Pi directly](#load-in-pi-directly).

### Removed commands and files

| Used in | Removed item | Use instead |
| --- | --- | --- |
| 0.13 and earlier | `/ollama-cloud-usage`, `/ollama-usage-status`, `/ollama-webtools` | `/ollama usage`, `/ollama status`, `/ollama webtools` |
| 0.13 and earlier | Root compatibility files such as `index.ts`, `usage.ts`, and `utils.ts` (removed in 0.14.0) | `usage.ts`: `src/usage/api.ts` (see [Use the usage API from another extension](#use-the-usage-api-from-another-extension)). `index.ts`: the package directory or `src/index.ts` (see [Load in Pi directly](#load-in-pi-directly)). Other root files such as `utils.ts` were internal and have no public replacement. |
| Before 0.8.0 | `/ollama-cloud-refresh` and the model cache `~/.pi/agent/cache/ollama-cloud-models.json` | Automatic refresh and `pi update --models`. The old cache file is no longer read. |

## Use the usage API from another extension

Other extensions, such as a custom status display, can import this package's usage functions. The runtime and bundled data all live under `src/`. The package ships TypeScript sources, so import with the `.ts` extension.

```ts
import { fetchUsage, fetchUsageStats, formatUsage, formatUsageStatusColored } from "@buyong/pi-ollama-cloud/src/usage/api.ts";
import { getCloudApiKey } from "@buyong/pi-ollama-cloud/src/auth/context.ts";
import type { UsageData } from "@buyong/pi-ollama-cloud/src/usage/api.ts";
```

| Function | Behavior |
| --- | --- |
| `fetchUsage(apiKey, signal?)` | Queries `/api/balance`. Supports both the older quota-window format and balance-based responses. |
| `fetchUsageStats(apiKey, range?, signal?)` | Queries `/api/usage` request statistics. |
| `formatUsage(data, stats?, options?)` | Builds a multi-line usage string. `options.title` replaces the first line. |
| `formatUsageSummary(data)` | Builds a one-line summary, such as `5h 40% used · purchased $5.00`. |
| `formatUsageStatusColored(theme, data)` | Builds the string for the TUI status display. |
| `getCloudApiKey(ctx)` | Checks Pi's provider credential first, then falls back to `OLLAMA_API_KEY`. |
| `isUsageResponse(data)`, `isUsageStats(data)` | Check the response shape. |

`UsageData.included.period.until` holds the reset boundary reported by the API. The status display idea came from [pi-ollama-cloud-usage-tracker](https://github.com/Entelligentsia/pi-ollama-cloud-usage-tracker), but this extension uses an API key and `/api/balance` instead of browser cookies.

## Development and verification

This section is for contributors working in a source checkout. Run from the monorepo root with Node.js 22.19 or later and `pnpm@10.34.9`.

```bash
pnpm install --frozen-lockfile
pnpm --filter @buyong/pi-ollama-cloud check
pnpm --filter @buyong/pi-ollama-cloud test:unit
verification_dir="$(mktemp -d)"
pnpm --filter @buyong/pi-ollama-cloud exec tsx scripts/cli/verify.ts --offline --report "$verification_dir/offline.json"
pnpm --dir apps/pi-ollama-cloud pack --pack-destination "$verification_dir/package"
```

`check` runs lint and type checks without changing files. Unit tests and `--offline` verification make no requests to the real service. `--offline` verification also packs and unpacks the real pnpm archive, prepares only the production dependencies already installed, and compares registration, tools, cancellation, reload, and request payloads between the source and the archive. The last command writes the archive to `$verification_dir/package` so you can inspect it. Confirm exit code 0 and that every check in the report passed. Tests, the CLI, Inquirer, and verification records are not shipped, and there is no compile or bundle step.

### Compare a refactor with its baseline

Asynchronous execution, shared requests, and resource cleanup use Effect `4.0.6`. Existing Promise APIs, provider/command/tool names, settings, and storage formats are unchanged. Pure policy and synchronous updates inside file locks remain synchronous.

Set `BEFORE_PACKAGE` and `AFTER_PACKAGE` to absolute paths of the baseline and candidate packages, each with its production dependencies installed. From the monorepo root, run the same fixture against both installations to compare registration, commands, tools, cancellation, reload, and final request payloads. This makes no live API requests.

```bash
verification_dir="$(mktemp -d)"
pnpm --filter @buyong/pi-ollama-cloud exec tsx scripts/cli/parity-offline.ts \
  --before "${BEFORE_PACKAGE:?Set the baseline package path}" \
  --after "${AFTER_PACKAGE:?Set the candidate package path}" \
  --report "$verification_dir/parity.json"
```

### Run 50 live model requests

**This check consumes real quota.** Supply a test `OLLAMA_API_KEY` privately in the execution environment; personal credential files are not used. The command below checks the source. To check an archive, point `--package-dir` at its extracted directory with production dependencies installed.

```bash
verification_dir="$(mktemp -d)"
pnpm --filter @buyong/pi-ollama-cloud exec tsx scripts/cli/parity-live.ts \
  --live-50 --package-dir "$PWD/apps/pi-ollama-cloud" \
  --report "$verification_dir/live-50.json"
```

The fixed `glm-5.3-flash:cloud` plan includes 10 single replies, 10 context-retention requests, 10 requests alternating omitted thinking settings and low, and 20 requests for registered web-tool round trips. Model follow-ups after tool execution count toward the 50. Each request is capped at 1,024 output tokens and 120 seconds. Separate limits allow at most two searches, two page fetches, four balance reads, and one model-detail request. Counts are persisted before dispatch, including failures. Retries, redirects, and requests outside the budget are blocked.

Expect exit code 0 and report fields `status: "pass"`, `counts.chat: 50`, and `blocked: 0`. The runner stops on failure and rejects an existing report path. A new report starts a new budget, so track cumulative usage before rerunning. Reports omit keys, authorization headers, and complete responses. Running once before and once after a refactor makes 100 model requests.

Live comparisons do not require identical generated wording or thinking blocks. Omitting a thinking setting does not necessarily disable reasoning under the model's policy; check the transmitted value in the report's `payload.reasoning`. The checks cover request options, stream termination, context retention, tool calls, and cache reuse. Offline tests cover failure, concurrency, and multi-account boundaries.

### Interactive check CLI

Run in an interactive terminal at the monorepo root. This command is for a source checkout, not an npm installation.

```bash
pnpm --filter @buyong/pi-ollama-cloud cli
```

Choose from the `@inquirer/prompts` menu; the menu labels are in Korean:

- **모델 목록 조회** (list models): Queries Ollama's `GET https://ollama.com/v1/models` and shows the model IDs and count. It never substitutes a fixed list and works without an API key.
- **모델을 선택해 1+1 채팅** (chat 1+1 with a selected model): Pick a model from the API list; the CLI sends `1+1` once through the same model setup code as the extension and Pi's model runtime, and shows the text reply.
- **모델 ID를 직접 입력해 1+1 채팅** (chat 1+1 with a typed model ID): Accepts a valid ID that the list does not show, such as `glm-5.3-flash:cloud`. The CLI checks it with `/api/show`, then registers and sends the ID exactly as typed; unsupported models are reported before the call. Names in the API list do not always match the accepted aliases.
- **모델 메타데이터·출처 조회 (공개 API)** (model metadata and sources): Shows capabilities and thinking values from the public API, and whether each value comes from bundled data or a default.
- **기능별 검증 (오프라인)** / **전체 기능·배포물 검증 (오프라인)** (check by feature / check everything and the archive): Runs simulated checks of authentication, models, cache, renderers, cancellation, and the generation pipeline. Diagnostics run in a process separate from the menu.
- **종료** (exit): Ends the menu. `Ctrl+C` also stops and exits.

Chats use real API quota. Like the existing generation and verification scripts, the CLI uses the `ollama-cloud` API key stored in Pi's `auth.json` first, then `OLLAMA_API_KEY`. Keys are never printed to the screen or written to files. Stored literal, `$ENV`, `${ENV}`, and `!command` values are resolved with Pi's official resolver. Pi 1.3.0 runs `!command` synchronously for up to 10 seconds, so cancellation can be delayed that long.

A chat registers the selected model's configuration in Pi's model runtime temporarily, and just before sending it checks that the model ID in the request body matches your input. The key is passed only in runtime memory; no session file or personal setting is saved. Requests are limited to 120 seconds, and output to the smaller of the model limit and 4096 tokens. Errors are shown and the menu returns; temporary directories are cleaned up. A successful chat confirms inference through the model setup path. The extension's registration, commands, tools, and events are checked separately by the source and archive checks and by loading it in Pi as shown below.

For help, run `pnpm --filter @buyong/pi-ollama-cloud cli --help`. The CLI and `@inquirer/prompts` are development tools and are not part of the runtime package.

### Load in Pi directly

Pi finds the entry point through `pi.extensions: ["./src/index.ts"]` in `package.json`; no root `index.ts` is needed. If you loaded it with a file path such as `-e .../index.ts`, change it to the package directory or `src/index.ts`.

To load it apart from your personal settings, run from the app directory:

```bash
cd apps/pi-ollama-cloud
node --version
pnpm exec pi --version
package_dir="$(pwd -P)"
pi_cli="$package_dir/node_modules/.bin/pi"
verification_dir="$(mktemp -d)"
mkdir -p "$verification_dir/agent" "$verification_dir/work"
(
  cd "$verification_dir/work" || exit 1
  PI_CODING_AGENT_DIR="$verification_dir/agent" PI_OFFLINE=1 \
    "$pi_cli" --no-extensions --no-skills --no-prompt-templates --no-themes \
    --no-context-files --no-mcp -e "$package_dir"
)
```

In Pi, run `/ollama` (open the settings screen, then close it with Esc), `/ollama webtools off`, `/ollama webtools on`, and `/reload`, and confirm that the tool state changes without errors. The two `webtools` commands save values to `ollama-cloud.json` in the isolated agent directory. This check covers startup and command behavior only; it does not show that model or API calls succeed. The isolated directory is not a security boundary that blocks the code's file or network access.

Live-service checks need an API key and use quota. CI's `Smoke pi-ollama-cloud` checks model replies, thinking off, and web tools with the packed extension. To check the web tools for real on your machine, run `pnpm run smoke:web-tools` in the app directory. It makes one web search, one page fetch, and one balance query for purchased-credit protection, checks the tool result size limit and cache reuse, and does not retry failures.

Bundled data updates, release approval, and tagging are described in the [maintenance guide](https://github.com/buYoung/pi-packages/blob/main/apps/pi-ollama-cloud/docs/maintaining.md) (Korean).

## License

[MIT License](LICENSE). The original author's attribution is kept.
