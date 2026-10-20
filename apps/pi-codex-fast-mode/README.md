# @buyong/pi-codex-fast-mode

**English** | [한국어](README.ko.md)

Request an OpenAI service tier from Pi while keeping the same conversation model and endpoint. Choose Standard, Fast, or Ultrafast per model, with a global speed for models without an override. **Model settings take precedence over global speed.** The extension adds `service_tier` only when its local compatibility checks pass; initial Standard without an explicit preference leaves the payload unchanged.

The selected tier applies to requests. Response tiers can differ; the Codex backend has returned `default` for Fast and Ultrafast requests. A `default` response alone does not disable the selection or cause a failure. Check processing speed and billing separately. See the OpenAI [Fast](https://developers.openai.com/api/docs/guides/fast-mode) and [Ultrafast](https://developers.openai.com/api/docs/guides/ultrafast-mode) guides.

## Requirements

Use Node.js 22.19 or later and Pi 1.0.0 or later with configured model access. This repository builds against Pi 1.2.0. For Fast, select an available model in the [local allowlist](#supported-models-and-payloads); Ultrafast has additional API, authentication, and endpoint requirements. The list does not supply account access or establish backend availability.

## Quick start

Install a published release:

```sh
pi install npm:@buyong/pi-codex-fast-mode
pi list
pi
```

Do not also enable this extension through `@buyong/pi-codex`. In Pi:

1. Select a model in the [local Fast allowlist](#supported-models-and-payloads).
2. Run `/codex-fast`, select Fast under the model's `Speed`, and press Enter to save.
3. Run `/codex-fast status` to confirm that requests for the desired tier are enabled on the selected model.
4. Send a short prompt to make a model request, for example:

```text
Reply with READY only. Do not use tools.
```

Run `/codex-fast status` again. `OpenAI requested service tier` identifies the selected request tier; `Request enabled` means the extension's local checks passed. An enabled choice shows a footer such as `gpt-6.1-sol fast`; a matching request records `priority` as the last injection. This record shows the payload field prepared by the hook and does not verify the server's processing tier. To disable acceleration for this model, save Standard as its model-specific speed.

## Select a tier

`/codex-fast` lists available models selected in `/scoped-models` that have speed controls, followed by **Global speed**. Without a configured scope, it uses all available models, matching Pi's behavior. The current model appears first if included; the other models retain their scope order. Models outside the scope are not added, even if currently selected. Under each model, `Speed` offers one choice among **Standard, Fast, and Ultrafast**. Models without an override show `global` beside their name and inherit the global speed.

After changing `/scoped-models`, reopen `/codex-fast` to see the updated list. Speed settings for models hidden from the list are preserved.

- **↑/↓**: select a model or global speed. Long model lists scroll with the selection.
- **←/→ or Tab/Shift+Tab**: select a speed. Brackets mark the saved value; `›…‹` marks keyboard focus.
- **Enter**: apply and save the selected speed. The view stays open.
- **R**: clear the selected model's override and inherit global speed.
- **Esc**: close. Choices not saved with Enter are discarded.

Unavailable speeds are dimmed, marked `×`, and skipped during selection. Narrow terminals show the saved speed and pending choice in a compact form.

| Command | Behavior |
| --- | --- |
| `/codex-fast speed standard` / `fast` / `ultrafast` | Select global speed; preserve model overrides |
| `/codex-fast model <provider/id> standard` / `fast` / `ultrafast` | Set that model's speed; unsupported choices preserve the previous setting |
| `/codex-fast model <provider/id> inherit` | Restore global-speed inheritance for that model |
| `/codex-fast on` | Select global Fast |
| `/codex-fast off` | Select global Standard; preserve model overrides |
| `/codex-fast fast on` / `/codex-fast fast off` | Toggle global Fast; turning off an inactive mode preserves the other global speed |
| `/codex-fast ultrafast on` / `/codex-fast ultrafast off` | Toggle global Ultrafast; unsupported models receive no tier injection |
| `/codex-fast status` | Show the desired tier, activation, model, settings path, persistence, and last injection without changing the preference |

Explicit arguments also work without a UI. Replace `<provider/id>` with an actual model ID such as `openai-codex/gpt-6.1-sol`. RPC first selects a model or global speed, then opens a speed picker; models also offer a global-inheritance option. Mode changes wait for the current agent run to become idle. `status` does not save settings or make a model request. The startup `--fast` flag overrides the saved global speed; model settings still take precedence.

Switching models recalculates the model-specific or inherited global speed. An unsupported accelerated preference is retained without adding a tier. Model-specific commands check the target model's compatibility before changing its setting.

## Migrating from earlier commands

This checkout registers only `/codex-fast`; `/openai-tier` and `/openai-settings` have been removed, not kept as aliases. Use `/codex-fast status` for diagnostics, `model` commands for model overrides, and `speed` commands for global speed. Existing `on`/`off` and named-mode shortcuts remain supported and change global speed.

Update scripts that call the removed commands. Legacy booleans and storage paths remain supported; model settings take precedence over global speed. Published releases can differ from this checkout; use a release containing this change or the source build below.

## Settings and persistence

| Location | Path |
| --- | --- |
| Global | `<agentDir>/codex-fast-mode/settings.json` |
| Project | `<cwd>/.pi/codex-fast-mode/settings.json` |

`agentDir` honors `PI_CODING_AGENT_DIR` and normally is `~/.pi/agent`. The project layer overrides the global layer. Commands save to the project file if it exists, otherwise to the global file.

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
| `persistState` | `true` | `false` keeps command changes in the session only |
| `notifyOnModelSwitch` | `true` | Notifies when a model switch changes activation |
| `supportedModels` | Built-in list below | Replaces the Fast allowlist with exact `provider/id` strings. `[]` disables Fast support; it does not change Ultrafast checks. |
| `desiredActive`, `active`, `fast.enabled` | Unset | Legacy booleans. Within each layer, precedence is `serviceTier`, then `desiredActive`, `active`, and `fast.enabled`. |

Global speed is resolved per layer, so project legacy booleans can override global `serviceTier`. Model settings merge by ID, with project values taking precedence for the same model. A global-file model override also takes precedence over a project's global speed. A project `null` entry masks the global-file model override and restores global-speed inheritance.

Global changes update `serviceTier`, `desiredActive`, and `active`; model changes update only the target ID while preserving unrelated fields. Restoring inheritance in the global file removes that model's entry. Failed saves restore the previous choice. Model switches recalculate speed and activation without writing settings.

After manual edits, run `/reload`. Invalid or unreadable settings report an error and use defaults with session-only changes. A failed command save restores the previous tier.

## Supported models and payloads

This is the extension's **default local Fast allowlist**, not a promise that your provider/account offers every listed model or service tier:

| Provider | Model IDs |
| --- | --- |
| `openai` | `gpt-5.4`, `gpt-5.5`, `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna` |
| `openai-codex` | All of the above plus `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` |

Ultrafast can be requested for `gpt-6-astra` or `gpt-6.1-sol` through these routes:

| Provider and API | Authentication | Default endpoint |
| --- | --- | --- |
| `openai` and `openai-responses` | API-key or ChatGPT OAuth authentication configured in Pi | `https://api.openai.com/v1` |
| `openai-codex` and `openai-codex-responses` | Configured OAuth authentication | `https://chatgpt.com/backend-api`, optionally ending in `/codex` or `/codex/responses`. |

Use the default HTTPS port or 443, without URL credentials, query, or fragment. A trailing `/` is accepted. Activation on the Codex route means the extension can prepare the request. The Codex response tier alone does not establish account support or the processing tier actually used.

| Selection | Injected `service_tier` |
| --- | --- |
| Initial Standard with no explicit preference | No field added |
| Explicit or saved global/model Standard | `"default"` on models with speed controls |
| Fast | `"priority"` on Fast-supported models |
| Ultrafast | `"ultrafast"` when its checks pass |
| Accelerated preference on an unsupported model | No field added; preference retained |

The hook returns a payload copy only for an object whose `payload.model` matches the current model ID. Auxiliary requests for a different model are not changed. Unsupported cases are left unchanged; the extension does not change endpoints, select another model, or verify the backend's actual tier.

The [Sol service-tier PoC](https://github.com/buYoung/pi-codex-auto-review/blob/master/docs/testing/ultrafast-sol.ko.md) checks the final HTTP body produced by Pi and a completed response, recording request tiers, raw response tiers, and TPS separately. A response-tier difference alone does not fail the run; success does not guarantee the processing tier or billing.

## When the selected tier is not active

| Symptom | What to check |
| --- | --- |
| Preference retained but not active | Check the selected `provider/id` and your `supportedModels` override. A saved choice is not a compatibility result. |
| Global changes do not change the current model's speed | Model settings take precedence. Press `R` for that model or use `model <provider/id> inherit` to restore global inheritance. |
| Ultrafast selection rejected | Check every Ultrafast requirement above. The previous tier remains selected; the command does not fall back to Fast. |
| No injection after a prompt | Check the selected model and whether its provider payload has a matching `model` field. Other-model requests and incompatible payloads are left unchanged. |
| Settings load/save error | Follow the reported settings path. Load errors use defaults with session-only changes; a failed command save restores the previous tier. |

## Build and load from source

Run from the [pi-packages](https://github.com/buYoung/pi-packages) repository root:

```sh
pnpm install
pnpm --filter @buyong/pi-codex-fast-mode build
pnpm --filter @buyong/pi-codex-fast-mode exec pi -ne -e ./dist/index.js
```

This loads the extension for one invocation without registering a permanent package source. Rebuild after source changes. The [repository release process](https://github.com/buYoung/pi-packages#공통-ci와-패키지별-배포) describes release preparation.

## License

[Apache-2.0](LICENSE). The npm archive includes `LICENSE`.
