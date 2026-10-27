# pi-devin

**English** | [한국어](README.ko.md)

An **unofficial** provider that lets you use Devin models in [Pi](https://github.com/earendil-works/pi) with your Devin account.

> This package is not made or endorsed by Cognition (the company behind Devin). It uses private Devin CLI APIs that can change without notice. You are responsible for judging and accepting any risk of violating the terms of service or having your account restricted.

## Features

- Sign in to your Devin account with Pi's `/login` (OAuth). API keys are not used.
- Pick the Devin models your account can use in `/model`, and the thinking level in `/thinking`.
- **Devin Fusion**: a lead model hands tasks to a sidekick model.
- **`/devin`**: view quota and session usage, and change display settings.

## Requirements

- Node.js 22.19.0 or later and Pi (tested with 1.3.0)
- A Devin account that may use the Devin CLI, with quota left. Without both, you cannot chat even after a successful login.

## Installation

```bash
pi install npm:@buyong/pi-devin
```

Restart Pi, or run `/reload` in a running Pi.

To install for one project only, run `pi install npm:@buyong/pi-devin -l` inside that project. Project packages load only in a trusted project.

## Checking the installation

After a user-wide install, run these in a shell from any directory. After a `-l` project install, run them inside that trusted project; `pi list` then shows the package under `Project packages:`. They need no Devin account and send no requests to Devin.

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

## Getting started

1. In Pi, run `/login` → **Sign in with an account** → **Devin**.
2. Choose browser login or manual entry. With manual entry, paste the one-time code shown on the browser login page. API keys and session tokens are not accepted.
3. Once the model list refreshes, `/model` lists entries ending in `[devin]`. Pick one.
4. If needed, pick a thinking level with `/thinking`. The available levels depend on the model. For example, SWE-2 offers medium, high and max.
5. Send a short message, such as `Please say hello briefly.` A reply confirms that the login and the model work. From this message on, requests use your account quota. Pi runs the tools the model calls.

To try [Devin Fusion](#devin-fusion), pick **Devin Fusion** (`fusion`) in `/model` and ask for a small task. The lead calls the `devin_sidekick` tool and uses the sidekick's report in its answer.

## Model list

- The list shows one entry per model family by ID, such as `claude-opus-4.8 [devin]`. The name (`Claude Opus 4.8`) appears under `Model Name` below the selected row.
- Variants for each thinking level are not listed separately; pick them with `/thinking`. Turning on "Recommended models only" changes the list (see [`/devin`: usage and display settings](#devin-usage-and-display-settings)).
- When a family comes in variants with different options, such as Fast Mode, each gets its own entry with the option added to the ID, such as `claude-opus-4.8-fast-mode`.
- The models and features you see depend on your account.
- A price of `0` means the cost is unknown, not free.

## `/devin`: usage and display settings

Running `/devin` in the TUI shows the following on one screen. Use ↑↓ to move, space or Enter to toggle, and esc to close.

- Account quota: daily and weekly remaining-percentage bars, reset times and when the data was fetched
- Usage in this session: request count and input, output and cache tokens. Sidekick conversations are not included.

There are two toggles, both off by default. Changes apply to all sessions at once.

- **Recommended models only**: `/model` shows only the models that have a variant Devin marks as Recommended, plus Devin Fusion. Devin marks single variants such as `swe-2-high`, but the list keeps the model itself (`swe-2`), so you still pick the thinking level with `/thinking`. The recommended level is not applied automatically. If your account has no recommended models, the full list is shown.
- **Usage in status line**: the TUI footer shows the remaining daily and weekly quota as bars, plus this session's input and output tokens, like `devin day ▕█████████░▏98% week ▕█████████░▏98% · ↑263 ↓49`. A bar turns to the warning color at 40% or less and to the error color at 20% or less. It appears only while a Devin model, including Devin Fusion, is selected, and disappears when you switch to another provider's model. `/devin` shows usage whichever model is selected.

Quota is not live. It is refreshed when you log in and by the account check right before each model request, including requests from subagents and the Fusion sidekick that use the same Pi agent directory, so the usage of the message you just sent shows up after the next request. `/devin` and the status line send no network requests; the status line picks up quota recorded by other Pi processes at the end of each turn. Credits, per-request costs and usage history are not shown.

If a filter change removes the model you are using from the list, you can keep using it in the current session. When you reopen the session, that model is not restored, so pick a model from the list again.

Outside the TUI, such as in RPC mode, change settings with `/devin recommended on|off` and `/devin status on|off`. Without arguments, `/devin` sends quota, usage and settings as a notification.

## Devin Fusion

Picking **Devin Fusion** (`fusion`) in `/model` turns on the `devin_sidekick` tool for the lead model. The lead uses this tool to hand tasks to the sidekick model and receive its report. Switching to another model turns the tool off.

- The default pair is SWE-2 (lead) and SWE-2 Medium (sidekick). If your account has no SWE-2 Medium, the Fusion entry is not shown.
- Change the pair with `/devin-fusion`. In the TUI, you pick the lead and sidekick together in two columns. Press tab to switch columns, type to filter and press Enter to save. ★ marks recommended models and ● the saved pair.
- You can also use arguments: `/devin-fusion <lead model ID> <sidekick model ID>` (for example, `/devin-fusion swe-2 swe-2-high`). The lead is a family ID from the `/model` list; the sidekick is a variant ID with a fixed thinking level. With the TUI picker you do not need to know the IDs. The saved pair applies to all sessions.
- The lead's thinking level follows `/thinking`.
- The sidekick runs as a separate Pi process for each lead session. It shares the working directory, active tools and Devin login with the lead.
- By default, the lead waits for the sidekick's report. The lead can instead call `devin_sidekick` with `block: false` to keep working while the sidekick runs; the report then arrives as a message and the lead runs again to handle it. If the lead later waits on that running task, it receives the report as the tool result instead. If you send a message while the lead is waiting, the wait ends and the task moves to the background.
- Cancelling the lead also stops the sidekick task it was waiting for. A call already cancelled before handoff starts no work, including with `block: false`. A broken connection to the sidekick fails the task and closes that child process rather than terminating the lead Pi.
- Long sidekick reports are cut before the lead receives them; the complete text is saved to a temporary file (see [Limits and behavior](#limits-and-behavior)).
- If you restricted tools with `pi --tools`, include `devin_sidekick` in the list for Fusion to work.
- With Fusion, the lead and the sidekick each use quota as regular requests to the models they call.

## Limits and behavior

| Item | Behavior |
| --- | --- |
| Request timeout | Follows the value set by Pi (300 seconds by default). A response that keeps arriving is not cut off; the request fails only when no data arrives for that long. |
| Prompt cache | Short cache by default. `PI_CACHE_RETENTION=long` is allowed only for models Devin marks with a 24-hour cache; for other models the request is refused before sending. |
| Images | On supported models, up to 4 MiB per image and 5 MiB in total per message. After switching to a model without image support, earlier images are replaced with a note saying they were left out. |
| Sidekick report | The lead receives at most about 131,072 tokens of each report (524,288 characters, counted like Pi's context estimate of 4 characters per token), including status, errors and notices. A longer report is cut and ends with the path of a temporary file that holds the complete report (see [Storage locations](#storage-locations)). If saving fails, the cut report includes a notice instead. |
| print and JSON modes | These modes do not fetch the model list; they use the list stored by an earlier TUI or RPC session. Run the TUI or RPC mode at least once while logged in so the list is stored; otherwise `--model devin/<model ID>` is not found. |

- If the account check before a model request cannot reach the Devin server (for example `ECONNREFUSED` or a 503), the package keeps your stored login and sends the request anyway. A model request whose connection is refused, reset or cut off mid-response is reported as `Connection error (…)`, which Pi's automatic retry recognizes; a lasting outage reports that connection error instead of `OAuth refresh failed`.
- On a 401 error, log in again. 403, 429 and timeouts are not treated as an expired login. If logging in again does not help, check your account permissions, quota and network.
- If an error occurs while a response is streaming, tool calls in that response are not run. Send the message again.

## Device information

Like the Devin CLI, requests to the Devin server include device information. On macOS, the package reads the device serial number and network MAC addresses; on other OSes, the MAC addresses and the user name. There is no setting to turn this off.

## Storage locations

| Content | Location |
| --- | --- |
| Pi login data | Managed by Pi. Default `~/.pi/agent/auth.json` |
| Package settings | `pi-devin/settings.json` (`/devin`) and `pi-devin/fusion.json` (`/devin-fusion`) in the Pi agent directory |
| Last account quota | `pi-devin/account-usage.json` in the Pi agent directory. Holds only quota values and a hash of the login session, no token or account ID. |
| Sidekick conversations | `pi-devin/sidekick/<lead session ID>.jsonl` in the Pi agent directory |
| Complete text of cut sidekick reports | `pi-devin-sidekick-report-*/report.md` in the system temporary directory, readable only by you. Written only when a report exceeds the limit; the system may delete it later. |

The Pi agent directory defaults to `~/.pi/agent` and can be changed with `PI_CODING_AGENT_DIR`.

## Update, logout and removal

```bash
pi update npm:@buyong/pi-devin   # updates only this package (plain `pi update` updates Pi itself)
pi remove npm:@buyong/pi-devin   # removes the package
```

If you installed an exact version, such as `npm:@buyong/pi-devin@0.1.0`, `pi update` keeps that version even though it prints `Updated`. To move to another version, install it explicitly with `pi install npm:@buyong/pi-devin@<version>`. To remove a project installation, run `pi remove npm:@buyong/pi-devin -l` inside that project.

To log out, run `/logout` → Devin in Pi. This deletes only the login data on this device; it does not end the session on the server.

If you log in with another account, a session used with the previous account returns an error instead of sending its conversation to the new account. Start a new Pi session.

## CLI (optional)

This repository includes a CLI (`cli.ts`) for checking login and chat without Pi. You do not need it to use the package in Pi.

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

## Development

The source and verification procedures are in the [GitHub repository](https://github.com/buYoung/pi-packages/tree/main/apps/pi-devin). With development dependencies installed, run these from `apps/pi-devin/` in a source checkout; they use local fixtures and need no Devin account:

```bash
pnpm run typecheck
pnpm run test:unit
node verification/scripts/import-closure.mjs . --expect verification/inventory.json
```

Expected: exit code 0, all tests passing, and `ok: true` with no import-closure problems. The sidekick tests cover cancellation, broken child connections, one-time delivery and report limits. See [`verification/README.md`](https://github.com/buYoung/pi-packages/blob/main/apps/pi-devin/verification/README.md) for isolated Pi and archive checks, and [`proto/README.md`](proto/README.md) for the schema sources.

## Schema source and license

The code in this package is MIT licensed ([LICENSE](LICENSE)).

The protocol schema shipped in `proto/` is based on a descriptor that the third-party repository [leookun/devin-2api](https://github.com/leookun/devin-2api) says it extracted from the Devin CLI. This package then analyzed the protocol itself and added four definitions the base descriptor lacks; they are marked `[added field]`/`[added value]` in the sources and listed in [`proto/README.md`](proto/README.md). The runtime loads `proto/` directly.

leookun/devin-2api is distributed under the MIT License, and its notice is reproduced below as that license requires. The license covers leookun's work; the copyright and distribution rights of the schema it says it extracted from the Devin CLI have not been verified.

```text
MIT License

Copyright (c) 2026 leookun

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
