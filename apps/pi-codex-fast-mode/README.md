# @buyong/pi-codex-fast-mode

**English** | [한국어](README.ko.md)

A Pi extension that requests an OpenAI service tier while keeping the same conversation model and endpoint. Choose Standard, Fast, or Ultrafast per model, with a global speed for models without an override. **Session speed takes precedence over model settings, then global speed.** The extension adds `service_tier` only when its local compatibility checks pass; initial Standard without an explicit preference leaves the payload unchanged.

The selected tier applies to requests. Response tiers can differ; the Codex backend has returned `default` for Fast and Ultrafast requests. A `default` response alone does not disable the selection or cause a failure. Check processing speed and billing separately. See the OpenAI [Fast](https://developers.openai.com/api/docs/guides/fast-mode) and [Ultrafast](https://developers.openai.com/api/docs/guides/ultrafast-mode) guides.

## Requirements

Use Node.js 22.19 or later and Pi 1.0.0 or later with configured model access. This repository builds against Pi 1.4.0. For Fast, select an available model that [supports Fast](#supported-models-and-payloads); Ultrafast has additional API, authentication, and endpoint requirements. Model support checks do not supply account access or establish backend availability.

## Quick start

If you already use `@buyong/pi-codex`, it includes this extension; do not install or enable it separately. Otherwise, install a published release:

```sh
pi install npm:@buyong/pi-codex-fast-mode
pi list
pi
```

`pi list` shows `npm:@buyong/pi-codex-fast-mode` and its installed path under `User packages:`.

In Pi:

1. With `/model`, select a model that [supports Fast](#supported-models-and-payloads).
2. Run `/codex-fast`. The view opens on the session row, so press **↓** to reach your current model's row, select Fast under `Speed` with **→** or **Tab**, press Enter to save, and press Esc to close the view.
3. Run `/codex-fast status` to confirm that requests for the desired tier are enabled on the selected model.
4. Send a short prompt to make a model request, for example:

```text
Reply with READY only. Do not use tools.
```

Run `/codex-fast status` again. `OpenAI requested service tier` identifies the selected request tier, `Request enabled` means the extension's local checks passed, and `Last payload injection` shows `priority` after a matching request. This record shows the field the extension added to the request; it does not confirm the tier the server actually used. While the choice is enabled, Pi's footer also shows the model and tier, such as `gpt-6.1-sol fast`. To disable acceleration for this model, save Standard as its model-specific speed.

## Select a tier

`/codex-fast` shows **Session speed (not saved)** first, then the available models selected in `/scoped-models` that can request Fast or Ultrafast (models with speed controls), followed by **Global speed**. Without a configured scope, it uses all available models, matching Pi's behavior. Models are sorted by Astra, Sol, then Luna family, descending numeric version within each family, then model key; other models follow in model-key order. The current model has no special sort priority. Models outside the scope are not added, even if currently selected. Under each model, `Speed` offers one choice among **Standard, Fast, and Ultrafast**. Models without an override show `global` beside their name and inherit the global speed.

After changing `/scoped-models`, reopen `/codex-fast` to see the updated list. Speed settings for models hidden from the list are preserved.

- **↑/↓**: select session, model, or global speed. Long model lists scroll with the selection.
- **←/→ or Tab/Shift+Tab**: select a speed. Brackets mark the session selection or saved model/global value; `›…‹` marks keyboard focus.
- **Enter**: apply the session row without saving, or save a model/global speed. The view stays open.
- **R**: clear session speed on the session row, or restore global inheritance on a model row.
- **Esc**: close. Choices not applied with Enter are discarded.

Unavailable model speeds are dimmed, marked `×`, and skipped during selection. The session row offers all three speeds, retaining the choice even when the current model cannot use it. Narrow terminals show the saved speed and pending choice in a compact form.

| Command | Behavior |
| --- | --- |
| `/codex-fast session standard` / `fast` / `ultrafast` | Override speed for this session only; never write settings |
| `/codex-fast session clear` | Clear session speed and return to model/global settings |
| `/codex-fast speed standard` / `fast` / `ultrafast` | Select global speed; preserve model overrides |
| `/codex-fast model <provider/id> standard` / `fast` / `ultrafast` | Set that model's speed. The command fails and keeps the previous setting when the model is not found, cannot request the chosen tier, or has no speed controls (this also applies to `standard`) |
| `/codex-fast model <provider/id> inherit` | Restore global-speed inheritance for that model |
| `/codex-fast on` | Select global Fast |
| `/codex-fast off` | Select global Standard; preserve model overrides |
| `/codex-fast fast on` / `/codex-fast fast off` | `on` selects global Fast. `off` selects global Standard only when global speed is Fast; otherwise nothing changes |
| `/codex-fast ultrafast on` / `/codex-fast ultrafast off` | `on` selects global Ultrafast; models that cannot request it get no tier. `off` selects global Standard only when global speed is Ultrafast; otherwise nothing changes |
| `/codex-fast status` | Show the desired tier, session override (or not set), activation, model, settings path, persistence, and last injection without changing the preference |

Commands with arguments also work without a UI. Replace `<provider/id>` with an actual model ID such as `openai-codex/gpt-6.1-sol`. Speed changes wait for the current agent run to become idle. `status` does not save settings or make a model request.

In RPC mode, `/codex-fast` first asks whether to change session, model, or global speed, then opens a speed picker. The session picker includes a clear option, and model pickers include global inheritance.

Starting Pi with `--fast` uses global Fast instead of the saved global speed, without saving it. Model settings still take precedence.

Session speed overrides model settings and global speed (including `--fast`). It stays in memory only, regardless of `persistState`, and survives model switches with compatibility recalculated for each model. It is cleared on process exit, `/new`, `/resume`, `/fork`, or `/reload`; session startup returns to saved settings and any startup flag. Use `/codex-fast session clear` to return without changing sessions. While set, the footer includes `· session` (and `unsupported` when acceleration cannot be requested), and `status` explains that saved speeds are overridden. Global/model commands and TUI saves still save normally, but their result messages note that session speed takes precedence.

Without session speed, switching models recalculates the model-specific or inherited global speed. An unsupported accelerated preference is retained without adding a tier. Model-specific commands check the target model's compatibility before changing its setting.

## Settings and persistence

| Location | Path |
| --- | --- |
| Global | `<agentDir>/codex-fast-mode/settings.json` |
| Project | `<cwd>/.pi/codex-fast-mode/settings.json` |

`agentDir` honors `PI_CODING_AGENT_DIR` and normally is `~/.pi/agent`. The project layer overrides the global layer. Saving a global or model speed, from the `/codex-fast` view or a command, writes to the project file if it exists, otherwise to the global file. Session speed never writes either file.

```json
{
  "serviceTier": "standard",
  "modelServiceTiers": {
    "openai-codex/gpt-6.1-sol": "ultrafast",
    "openai-codex/gpt-6-astra": "fast"
  },
  "persistState": true,
  "notifyOnModelSwitch": true
}
```

| Setting | Default | Behavior |
| --- | --- | --- |
| `serviceTier` | `"standard"` | Global speed for models without an override: `standard`, `fast`, or `ultrafast`. Explicitly saving Standard differs from having no preference. |
| `modelServiceTiers` | `{}` | Speeds keyed by exact `provider/id`: `standard`, `fast`, or `ultrafast` take precedence over global speed; `null` restores global inheritance. |
| `persistState` | `true` | `false` keeps global/model speed changes in memory only; session speed is never saved either way |
| `notifyOnModelSwitch` | `true` | Notifies when a model switch changes activation |
| `supportedModels` | Unset | When set to exact `provider/id` strings, this list decides Fast support instead of the catalog and built-in list. `[]` disables Fast support; it does not change Ultrafast checks. |
| `desiredActive`, `active`, `fast.enabled` | Unset | Legacy booleans: `true` means global Fast and `false` means global Standard. Within each layer, precedence is `serviceTier`, then `desiredActive`, `active`, and `fast.enabled`. |

Each file's global speed is resolved on its own first, so legacy booleans in the project file can override `serviceTier` in the global file. Model settings merge by ID, with project values taking precedence for the same model. A global-file model override also takes precedence over a project's global speed. A project `null` entry masks the global-file model override and restores global-speed inheritance.

Global changes write `serviceTier` together with the legacy booleans: `desiredActive` is `true` for Fast or Ultrafast, and `active` records whether the tier is active for the current model. Within a file, `serviceTier` still takes precedence. Model changes update only the target ID while preserving unrelated fields. Restoring inheritance removes that model's entry from the global file, or writes `null` for it in the project file. Concurrent saves to the same file are serialized across extension instances and Pi processes, preserving other models and unrelated fields. If a save cannot acquire the lock within two seconds, it reports an error and restores the previous choice; retry after the other save finishes. Other failed saves also restore the previous choice. Model switches recalculate speed and activation without writing settings.

After manual edits, run `/reload`. Invalid or unreadable settings report `Could not load Fast settings: …`; the extension then starts with defaults and keeps later changes in memory only, without writing either settings file.

## Supported models and payloads

Like the Codex CLI, the extension uses the OpenAI Codex model catalog to decide which models can request Fast and Ultrafast. When the catalog adds a model, you can select it without updating the extension.

- At session start, the extension reads the catalog with a login configured in Pi. With an `openai-codex` login, it first reads `https://chatgpt.com/backend-api/codex/models`. Without that login, or if the lookup fails, it reads `/models` at the `openai` provider's address (by default `https://api.openai.com/v1/models`) with that provider's API key or ChatGPT OAuth.
- A model whose catalog `service_tiers` include `priority` can request Fast; one that includes `ultrafast` can request Ultrafast. The catalog applies to the `openai` and `openai-codex` providers by model ID.
- After a successful lookup, the extension saves only each model's speed tiers to `<agentDir>/codex-fast-mode/service-tiers.json`. It uses this file when neither lookup works: you have no login, use `--offline` or `PI_OFFLINE`, or the lookups fail or take longer than five seconds in total.
- While the catalog loads, the first request and `/codex-fast` commands wait for it for up to five seconds.
- Models the catalog does not list, and sessions where the lookups fail with no saved file, use the built-in list below.

| Provider | Built-in Fast model IDs | Built-in Ultrafast model IDs |
| --- | --- | --- |
| `openai` | `gpt-5.4`, `gpt-5.5`, `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna` | `gpt-6-astra`, `gpt-6.1-sol` |
| `openai-codex` | All of the above plus `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | `gpt-6-astra`, `gpt-6.1-sol` |

Neither the catalog nor the built-in list promises that your provider/account offers every model or service tier.

Ultrafast can be requested for models the catalog or built-in list allows, through these routes:

| Provider and API | Authentication | Default endpoint |
| --- | --- | --- |
| `openai` and `openai-responses` | API-key or ChatGPT OAuth authentication configured in Pi | `https://api.openai.com/v1` |
| `openai-codex` and `openai-codex-responses` | Configured OAuth authentication | `https://chatgpt.com/backend-api`, optionally ending in `/codex` or `/codex/responses`. |

Use the default HTTPS port or 443, without URL credentials, query, or fragment. A trailing `/` is accepted. Activation on the Codex route means the extension can prepare the request. The Codex response tier alone does not establish account support or the processing tier actually used.

| Selection | Injected `service_tier` |
| --- | --- |
| Initial Standard with no explicit preference | No field added |
| Explicit session or saved global/model Standard | `"default"` on models with speed controls (models that can request Fast or Ultrafast) |
| Fast | `"priority"` on Fast-supported models |
| Ultrafast | `"ultrafast"` when its checks pass |
| Accelerated preference on an unsupported model | No field added; preference retained |

The extension adds `service_tier` only to a request payload that is an object whose `payload.model` matches the current model ID. Auxiliary requests for a different model are not changed. Unsupported cases are left unchanged; the extension does not change endpoints, select another model, or verify the backend's actual tier.

The [Sol service-tier PoC](https://github.com/buYoung/pi-codex-auto-review/blob/master/docs/testing/ultrafast-sol.ko.md) (in Korean) checks the final HTTP body produced by Pi and a completed response, recording request tiers, raw response tiers, and tokens per second (TPS) separately. A response-tier difference alone does not fail the run; success does not guarantee the processing tier or billing.

## When the selected tier is not active

| Symptom | What to check |
| --- | --- |
| Preference retained but not active | Check whether the catalog or built-in list supports that tier for the selected `provider/id`, and whether you set a `supportedModels` override. The catalog is read with an `openai-codex` or `openai` login. Saving a choice does not mean the current model supports it. |
| Saved changes do not change the current model's speed | Check `status` for a session override; use `session clear` to remove it. Otherwise model settings take precedence over global speed: press `R` on that model or use `model <provider/id> inherit`. |
| A model's Ultrafast setting is rejected | The model or its route does not meet the Ultrafast requirements in [Supported models and payloads](#supported-models-and-payloads): Ultrafast support in the catalog or built-in list, configured authentication, provider and API, and endpoint. The previous tier remains selected; the command does not fall back to Fast. Global Ultrafast is not rejected; models that cannot request it get no tier. |
| No injection after a prompt | Check the selected model and whether its provider payload has a matching `model` field. Other-model requests and incompatible payloads are left unchanged. |
| Settings load/save error | Follow the reported settings path. After a load error the extension uses defaults and keeps changes in memory only; a failed save restores the previous tier. |

## Migrating from 0.1.0 commands

Version 0.1.1 and later register only `/codex-fast`. The 0.1.0 commands `/openai-tier` and `/openai-settings` were removed, not kept as aliases, so update scripts that call them. Use `/codex-fast status` for diagnostics, `model` commands for model overrides, and `speed` commands for global speed. `on`/`off` and the named-mode shortcuts still change global speed. Settings saved by 0.1.0, including legacy booleans and storage paths, still load.

## Build and load from source

Run from the [pi-packages](https://github.com/buYoung/pi-packages) repository root:

```sh
pnpm install
pnpm --filter @buyong/pi-codex-fast-mode build
pnpm --filter @buyong/pi-codex-fast-mode exec pi -ne -e ./dist/index.js
```

This loads the extension for one invocation without registering a permanent package source. Rebuild after source changes.

To check a source build without a model request:

1. From `apps/pi-codex-fast-mode`, run `pnpm run typecheck`, `pnpm run lint`, and `pnpm run build`. All three should exit successfully.
2. Inside Pi, run `/codex-fast session fast`, then `/codex-fast status`. The status shows the session override; no settings file changes.
3. Run `/codex-fast session clear` or `/reload`, then `status` again. It shows `Session speed: not set`.

The [repository release process](https://github.com/buYoung/pi-packages#shared-ci-and-per-package-releases) describes release preparation.

## License

[Apache-2.0](LICENSE). The npm archive includes `LICENSE`.
