# pi-devin

An **unofficial** provider that lets you use Devin models in [Pi](https://github.com/earendil-works/pi) with your Devin account.

> This package is not made or endorsed by Cognition (the company behind Devin). It uses private Devin CLI APIs that can change without notice. You are responsible for judging and accepting any risk of violating the terms of service or having your account restricted.

## Features

- Sign in to your Devin account with Pi's `/login` (OAuth). API keys are not used.
- Pick the Devin models your account can use in `/model`, and the thinking level in `/thinking`.
- **Devin Fusion**: a lead model hands tasks to a sidekick model.
- **`/devin`**: view quota and session usage, and change display settings.

## Requirements

- Pi and Node.js 22.19.0 or later
- A Devin account that may use the Devin CLI, with quota left. Without both, you cannot chat even after a successful login.

## Installation

```bash
pi install npm:@buyong/pi-devin
```

Restart Pi, or run `/reload` in a running Pi.

## Checking the installation

Run these in a shell from any directory. They need no Devin account and send no requests to Devin.

```bash
node --version   # 22.19.0 or later
pi --version     # tested with 1.3.0
pi list          # "User packages:" includes npm:@buyong/pi-devin and its installed path
```

Then start `pi` and type the following inside Pi:

| Pi input | Expected result |
| --- | --- |
| (startup) | No `[Extension issues]` entry that mentions pi-devin |
| `/devin` | The usage and settings screen opens. Before you log in, it shows `Account quota · not received yet`. It sends no network requests. Press esc to close it. |
| `/devin-fusion` | Before you log in: the warning `No Devin models are available for Fusion.` After you log in: the two-column lead and sidekick picker. |
| `/reload`, then `/devin` again | The same screen, with no extension error |

The following steps need a Devin account and use its quota:

1. Log in as described in [Getting started](#getting-started). `/model` then lists entries ending in `[devin]`.
2. Pick a Devin model and send a short message, such as `Please say hello briefly.` A reply arrives.
3. Optional: pick **Devin Fusion** (`fusion`) in `/model` and ask for a small task. The lead calls the `devin_sidekick` tool and uses the sidekick's report in its answer.

The source and archive checks for developers are in `verification/README.md` in the [GitHub repository](https://github.com/buYoung/pi-packages/tree/main/apps/pi-devin). They are not included in the npm package.

## Getting started

1. In Pi, run `/login` → **Sign in with an account** → **Devin**.
2. Choose browser login or manual entry. With manual entry, paste the one-time code shown on the browser login page. API keys and session tokens are not accepted.
3. Once the model list refreshes, pick a Devin model in `/model`.
4. If needed, pick a thinking level with `/thinking`. The available levels depend on the model. For example, SWE-2 offers medium, high and max.
5. Send a message. From this point on, you use your account quota. Pi runs the tools.

## Model list

- The list shows one entry per model family by ID, such as `claude-opus-4.8 [devin]`. The name (`Claude Opus 4.8`) appears under `Model Name` below the selected row.
- Variants for each thinking level are not listed separately; pick them with `/thinking`. Turning on "Recommended models only" changes the list (see [below](#devin-usage-and-display-settings)).
- When a family comes in variants with different options, such as Fast Mode, each gets its own entry with the option added to the ID, such as `claude-opus-4.8-fast-mode`.
- The models and features you see depend on your account.
- A price of `0` means the cost is unknown, not free.

## `/devin`: usage and display settings

Running `/devin` in the TUI shows the following on one screen. Use ↑↓ to move, space or Enter to toggle, and esc to close.

- Account quota: daily and weekly remaining-percentage bars, reset times and when the data was fetched
- Usage in this session: request count and input, output and cache tokens. Sidekick conversations are not included.
- Run budget: a bar of the model requests used so far by the current (or last) user message, out of the per-message limit (see [Limits and behavior](#limits-and-behavior))

There are two toggles, both off by default. Changes apply to all sessions at once.

- **Recommended models only**: `/model` shows only the models Devin marks as Recommended, plus Devin Fusion. Recommended models are variants with a fixed thinking level, such as `swe-2-high`, rather than families, so you cannot pick another level with `/thinking`. If your account has no recommended models, the full list is shown.
- **Usage in status line**: the TUI footer shows the remaining daily and weekly quota as bars, plus this session's input and output tokens, like `devin day ▕█████████░▏98% week ▕█████████░▏98% · ↑263 ↓49`. A bar turns to the warning color at 40% or less and to the error color at 20% or less.

Quota is not live. It is refreshed when you log in and when Pi checks the login right before sending a model request, so the usage of the message you just sent shows up after the next request. `/devin` and the status line send no network requests. Credits, per-request costs and usage history are not shown.

If a filter change removes the model you are using from the list, you can keep using it in the current session. When you reopen the session, that model is not restored, so pick a model from the list again.

Outside the TUI, such as in RPC mode, change settings with `/devin recommended on|off` and `/devin status on|off`. Without arguments, `/devin` sends quota, usage and settings as a notification.

## Devin Fusion

Picking **Devin Fusion** (`fusion`) in `/model` turns on the `devin_sidekick` tool for the lead model. The lead uses this tool to hand tasks to the sidekick model and receive its report. Switching to another model turns the tool off.

- The default pair is SWE-2 (lead) and SWE-2 Medium (sidekick). If your account has no SWE-2 Medium, the Fusion entry is not shown.
- Change the pair with `/devin-fusion`. In the TUI, you pick the lead and sidekick together in two columns. Press tab to switch columns, type to filter and press Enter to save. ★ marks recommended models and ● the saved pair.
- You can also use arguments: `/devin-fusion <lead model ID> <sidekick model ID>` (for example, `/devin-fusion swe-2 swe-2-high`). The lead is a family ID from the `/model` list; the sidekick is a variant ID with a fixed thinking level. With the TUI picker you do not need to know the IDs. The saved pair applies to all sessions.
- The lead's thinking level follows `/thinking`.
- The sidekick runs as a separate Pi process for each lead session. It shares the working directory, active tools and Devin login with the lead.
- By default, the lead waits for the sidekick's report. If the lead model calls the `devin_sidekick` tool with `block: false`, it continues without waiting, and runs again when the report arrives. Cancelling the lead also stops the sidekick task it was waiting for.
- The lead receives at most about 131,072 tokens of each sidekick report, counted like Pi's own context estimate (4 characters per token). A longer report is cut at that point, and the cut report ends with the path of a temporary file that holds the complete text (see [Storage locations](#storage-locations)).
- If you restricted tools with `pi --tools`, include `devin_sidekick` in the list for Fusion to work.
- With Fusion, the lead and the sidekick each use quota as regular requests to the models they call.

## Limits and behavior

| Item | Behavior |
| --- | --- |
| Model request budget | Processing one user message calls models up to 8 times by default, including tool follow-ups, retries and auto-compaction. Each sidekick task gets the same limit separately. Change it with `PI_DEVIN_MAX_MODEL_CALLS` (1–100). |
| Request timeout | Follows the value set by Pi (300 seconds by default). |
| Prompt cache | Short cache by default. `PI_CACHE_RETENTION=long` is allowed only for models Devin marks with a 24-hour cache; for other models the request is refused before sending. |
| Images | On supported models, up to 4 MiB per image and 5 MiB in total per message. |
| Sidekick report | The lead receives at most about 131,072 tokens (524,288 characters) of each report. The complete text of a longer report is saved in a temporary file. |
| print and JSON modes | These modes do not fetch the model list; they use the list stored by an earlier TUI or RPC session. After logging in, run the TUI or RPC mode once, or `--model devin/<model ID>` is not found. |

- On a 401 error, log in again. 403, 429 and timeouts are not treated as an expired login. If logging in again does not help, check your account permissions, quota and network.
- If an error occurs while a response is streaming, tool calls in that response are not run. Send the message again.

## Device information

Like the Devin CLI, requests to the Devin server include device information. On macOS, the package reads the device serial number and network MAC addresses; on other OSes, the MAC addresses and the user name. There is no setting to turn this off.

## Storage locations

| Content | Location |
| --- | --- |
| Pi login data | Managed by Pi. Default `~/.pi/agent/auth.json` |
| Package settings | `pi-devin/settings.json` (`/devin`) and `pi-devin/fusion.json` (`/devin-fusion`) in the Pi agent directory |
| Sidekick conversations | `pi-devin/sidekick/<lead session ID>.jsonl` in the Pi agent directory |
| Complete text of cut sidekick reports | `pi-devin-sidekick-report-*/report.md` in the system temporary directory, readable only by you. Written only when a report exceeds the limit; the system may delete it later. |

The Pi agent directory defaults to `~/.pi/agent` and can be changed with `PI_CODING_AGENT_DIR`.

## Update, logout and removal

```bash
pi update npm:@buyong/pi-devin   # updates only this package (plain `pi update` updates Pi itself)
pi remove npm:@buyong/pi-devin   # removes the package
```

To log out, run `/logout` → Devin in Pi. This deletes only the login data on this device; it does not end the session on the server.

If you installed an exact version, such as `npm:@buyong/pi-devin@0.1.0`, `pi update` keeps that version even though it prints `Updated`. To move to another version, install it explicitly with `pi install npm:@buyong/pi-devin@<version>`.

To use the package in one project only, run `pi install npm:@buyong/pi-devin -l` and `pi remove npm:@buyong/pi-devin -l` inside that project. Project packages load only in a trusted project.

If you log in with another account, a session used with the previous account returns an error instead of sending its conversation to the new account. Start a new Pi session.

## CLI (optional)

You do not need it to use Pi. This repository includes a CLI (`cli.ts`) for checking login and chat without Pi.

The CLI is not included in the npm package. Run it from a source checkout.

```bash
git clone https://github.com/buYoung/pi-packages.git
cd pi-packages
pnpm --filter @buyong/pi-devin install --frozen-lockfile --ignore-scripts
cli=apps/pi-devin/cli.ts
node "$cli" --help
node "$cli" login            # browser login; opening the browser automatically works only on macOS
node "$cli" status
node "$cli" models
node "$cli" chat --model swe-2-medium --prompt "Please say hello briefly." \
  --allow-model-calls --no-title --no-analytics
```

- `chat` calls a model only with `--allow-model-calls`. By default, like the Devin CLI, it also sends a title generation request and analytics events. `--no-title` and `--no-analytics` turn these off.
- If a browser cannot be opened, enter the code yourself with `login --force-manual-token-flow --no-browser`.
- CLI login data is stored separately from Pi in `~/.local/share/devin-protocol-poc/`. Change the location with `DEVIN_POC_STATE_DIR`.

## Tested environments

| Item | Tested with |
| --- | --- |
| Pi | 1.3.0 |
| Node.js | 22.19.0, 24.14.0 |
| OS | macOS arm64. Linux arm64 passed automated tests only (real Pi screens and a real account were not checked) |
| Real account | With SWE-2 models: login, model list, chat, thinking level changes, tool calls, Fusion, the recommended model filter, and quota and usage in the `/devin` notification in RPC mode (2026-10-20) |

The TUI-only screens (the `/devin` screen, the status line and the Fusion picker) were not checked with a real account. Other Pi versions and Windows were not checked either.

## Schema source and license

The code in this package is MIT licensed ([LICENSE](LICENSE)).

The protocol schema shipped in `proto/` is based on a descriptor that the third-party repository [leookun/devin-2api](https://github.com/leookun/devin-2api) says it extracted from the Devin CLI. This package then analyzed the protocol itself and added four definitions the base descriptor lacks; they are marked `[added field]`/`[added value]` in the sources and listed in `proto/README.md`. The runtime loads `proto/` directly. The original copyright and distribution rights of the base schema have not been verified.

## Development

The source and verification procedures are in the [GitHub repository](https://github.com/buYoung/pi-packages/tree/main/apps/pi-devin). See `verification/README.md` for verification and `proto/README.md` for the schema sources.
