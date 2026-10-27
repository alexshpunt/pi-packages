# pi-refuseless

**English** | [한국어](README.ko.md)

Adds [Refuseless](https://docs.refuseless.com/introduction) to [Pi](https://github.com/earendil-works/pi) as a model provider. You enter your Refuseless API key in Pi's `/login`, and `/model` lists the models Refuseless offers for that key.

## Requirements

- Node.js 22.19.0 or later and Pi (tested with Pi 1.4.0).
- A Refuseless API key from the Refuseless console. Keys start with `abl_`. Requests use your Refuseless credits.

## Installation

This package is not on npm yet. Install it from a checkout of this repository:

```bash
pi install /path/to/pi-packages/apps/pi-refuseless
```

Then restart Pi, or run `/reload` in a running Pi. Pi loads a local package from its directory instead of copying it, so keep the checkout in place.

To try the package for one session without installing it, start Pi with `pi -e /path/to/pi-packages/apps/pi-refuseless`.

## Log in and choose a model

In Pi:

1. Run `/login`, choose **Sign in with an API key**, then **Refuseless**.
2. Paste your API key and press Enter. Pi shows `Saved API key for Refuseless. Credentials saved to <path>`, stores the key in its `auth.json` (`~/.pi/agent/auth.json` by default), and fetches the model list with the key.
   If no model was selected before, Pi also shows `Saved API key for Refuseless, but no default model is configured for provider "refuseless". Use /model to select a model.` Continue with the next step.
3. Run `/model` and choose a Refuseless model. Press Enter to use it in this session only, or Ctrl+S to also make it the default model for new sessions.

Pi keeps the key across restarts. If no key is saved, Pi uses the `REFUSELESS_API_KEY` environment variable. Pressing Escape at the key prompt, or Enter without a key, saves nothing and keeps any key you saved before.

If Refuseless rejects the key, Pi still saves it, shows `Saved API key for Refuseless, but its model catalog could not be refreshed; using cached models.`, and keeps the models it had before (none on a first login). Run `/login` again with the right key.

### Check which model a session is on

`/model` + Enter changes only the current session. A new session (a new Pi start, `/new`, or another terminal) begins on Pi's default model, which may belong to another provider, and Pi shows no warning. Check the model before you rely on it:

- In `/model`, the current model has a `✓` and every line shows its provider, as in `✓ glm-5.3-abliterated [refuseless]`. The default model is marked `· default`.
- The status line at the bottom shows the current model and thinking level, as in `glm-5.3-abliterated • low`. When more than one provider is set up, it also shows the provider, as in `(refuseless) glm-5.3-abliterated • low`.

To start new sessions on a Refuseless model, select it in `/model` with Ctrl+S; Pi shows `Default model: refuseless/<model id>`. To start a single Pi run on it without changing the default model, use `pi --model refuseless/<model id>`.

## Models

The package has no fixed model list. Pi fetches the list from Refuseless with your key after `/login`, when `/model` opens and when interactive Pi starts, and shows every model Refuseless returns. Pi saves the last list and uses it when it cannot fetch, for example in `pi -p` and `pi --list-models`. To refresh the saved list, open `/model` once in interactive Pi.

For each model, Pi uses:

- **Context**: the context length Refuseless reports, or 128,000 tokens if it reports none.
- **Thinking levels**: the levels Refuseless reports for the model (see below).
- **Max output**: 131,072 tokens, or the context length if that is smaller.
- **Input**: text only.
- **Cost**: not shown. See [refuseless.com/pricing](https://refuseless.com/pricing) and the Refuseless console.

### Thinking levels

Refuseless accepts four thinking levels: `off`, `low`, `high` and `max`. Each model supports some of them and has a default level. Pi offers only the levels a model supports. For example, the GLM models support `low`, `high` and `max`, so Pi does not offer `off` for them. A model that supports only `off` has no thinking levels in Pi. [`cli models`](#try-it-by-hand) shows each model's levels and default level.

Which level a model starts at:

- **Picked in a session with no thinking level yet**: the model's default level. This covers a new session that started without a model, where Pi sets the thinking level to `off`, and a switch from a model without thinking levels.
- **Picked after a model with thinking levels**: Pi keeps the level you had. If the new model does not support it, Pi moves it to the next supported level, for example `off` to `low` and `xhigh` to `max`.
- **A new session that starts on a Refuseless model**: Pi's own setting applies: `--thinking`, then the default thinking level in `/settings`, then `medium`. Refuseless has no `medium`, so Pi moves it to `high`.

A per-model or default thinking level in `/settings`, or a level in `--models`, takes the place of the level in the first two cases. One exception: in a session with no thinking level yet, a setting of `off` (or of the lowest level, on a model without `off`) still gives the model's default level.

Press Shift+Tab to change the thinking level of the current model.

Pi sends each level to Refuseless as follows:

| Pi level | Level sent to Refuseless |
| --- | --- |
| off | `off` |
| minimal, low | `low` |
| medium, high | `high` |
| xhigh, max | `max` |

## Errors

When Refuseless rejects a request, Pi stops the reply and shows the Refuseless error, for example:

- `401 invalid_key`: the key is wrong. Run `/login` again.
- `402 insufficient_credits`: top up your credits. This can also end a reply partway.
- `429 model_busy` or `model_warming`: try again a little later.

## If models.json also defines refuseless

The Pi setup in the Refuseless [SDKs](https://docs.refuseless.com/sdks.md) guide adds a `refuseless` provider to `~/.pi/agent/models.json`. Its model entries replace this package's models that have the same IDs, including their thinking levels. Remove that `refuseless` entry when you use this package.

## Logout, update and removal

- Run `/logout` and choose **Refuseless** to remove the saved Refuseless key. Pi shows `Removed stored API key for Refuseless. Environment variables and models.json config are unchanged.` `REFUSELESS_API_KEY` and other providers' keys stay.
- After you update the checkout, run `/reload` or restart Pi.
- Run `pi remove /path/to/pi-packages/apps/pi-refuseless` to uninstall the package. This keeps the checkout and the saved key; to remove the key, run `/logout` first.

## Development and verification

Run these from the repository root after `pnpm install`:

```bash
pnpm --filter @buyong/pi-refuseless typecheck
pnpm --filter @buyong/pi-refuseless test:unit
pnpm --filter @buyong/pi-refuseless cli verify
```

- `typecheck` and `test:unit` exit with 0. The tests send requests only to a local mock of the Refuseless API, so they need no key and spend no credits.
- `cli verify` also needs Pi installed, with `pi` on your PATH. It runs the tests, checks the package, and has your installed `pi` fetch the model list from the mock and answer one `pi -p` request. It ends with `All … checks passed.` and exit code 0, and prints the directory that holds its reports.

These commands do not change `~/.pi/agent`; each uses its own agent directory.

### Try it by hand

To try Pi with the package against the local mock, without a Refuseless key:

```bash
pnpm --filter @buyong/pi-refuseless cli pi --mock
```

In Pi, run `/login`, choose **Sign in with an API key** and **Refuseless**, and enter any key that starts with `abl_`. Then run `/model`, choose a Refuseless model, and send a message. The mock lists six models from a saved copy of the real Refuseless list, with their thinking levels and default levels, and replies with `Mock Refuseless reply from <model>`. A message that contains `tool`, `credits` or `busy` makes the mock call the `bash` tool, end the reply with `insufficient_credits`, or return `429`.

When you exit Pi, the command prints `Run again in this directory:` and a command. Run that command to check that the key and the model list survive a restart.

To try the real service with your key (chat requests spend credits):

```bash
pnpm --filter @buyong/pi-refuseless cli pi
```

Log in with your key in Pi. Try a model if you like, or exit right away if you only want to see the model list. To see the models Refuseless returns for that key, run `cli models` with the directory after `--dir` in the command printed when Pi exits:

```bash
pnpm --filter @buyong/pi-refuseless cli models --dir <directory>
```

`cli models` shows each model as Pi registers it, with its thinking levels and default level, and then each model entry exactly as Refuseless returned it. It sends no chat request. Without `--dir`, it uses `REFUSELESS_API_KEY`; with `--mock`, it shows the mock's list.

To check a whole conversation with real models (chat requests spend credits):

```bash
REFUSELESS_API_KEY=<your key> pnpm --filter @buyong/pi-refuseless cli live --model glm-5.3-abliterated --model deepseek-v4.1-flash-abliterated
```

`cli live` runs your installed `pi`, with this package, once for each model you name, all at the same time, and talks to each model for 10 turns. The turns check short answers, a code word recalled later, two `bash` tool calls, and the thinking levels `high`, `low` and `off`. It prints `pass` or `FAIL` for each turn and each model, and at the end the path of a JSON report.

`--turns N` stops after N turns. `--dir <directory>` uses the key saved by `cli pi` instead of `REFUSELESS_API_KEY`. `cli live` does not save the key to disk.

`cli mock` runs the mock on its own and prints each request it receives. `cli --help` lists every command and option.

## Tested environments

- Pi 1.4.0 (installed CLI) and Pi 1.3.0 (automated tests only), with Node.js 24.14.0 on macOS.
- The automated tests run against the local mock, which serves the model list Refuseless returned on 2026-10-27.
- On 2026-10-27, `cli live` passed all 10 turns with `glm-5.3-abliterated`, `glm-5.3-flash-abliterated` and `deepseek-v4.1-flash-abliterated` on the real service. The other models in the list have not been tried on the real service.
- `deepseek-v4.1-flash-abliterated` returned no thinking text at any level, including `high`. A direct request to the Refuseless API gave the same result, so Pi shows no thinking for this model.

[verification/acceptance.md](verification/acceptance.md) records the checks and their results.

## License

MIT
