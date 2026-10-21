# AGENTS.md

<!-- agents-md-generator: v1; doc-type: single_repo -->

## 1. Overview

This extension selects a request's service tier without changing its conversation model or endpoint. A saved preference and the tier currently eligible for injection are separate states.

## 2. Ownership Map

### Stable Ownership Boundaries

- **Configuration.** `src/config.ts` owns layered resolution and `FastSettingsStore`; `src/index.ts` owns changes and rollback after failed persistence. Check saved files and `/codex-fast status` across reloads, inheritance changes, and model switches.
- **Final payload.** `src/fast-controller.ts` owns eligibility and `service_tier`; `before_provider_request` in `src/index.ts` is the final integration point. The repository-root experiment `experiments/pi-codex-fast-mode/ultrafast-sol/poc-ultrafast-sol.mjs` distinguishes the sent tier from the tier reported by the service.
- **User selection.** `src/index.ts` wires `/codex-fast`, `--fast`, and model choices. `src/fast-ui.ts` renders TUI/non-TUI selection through the same asynchronous setter. Check stored versus focused values, inheritance reset, unsupported preferences, and closing during a save.

## 3. Core Behaviors & Patterns

- Resolve each configuration layer before merging global then project values. Within a layer, precedence is `serviceTier`, `desiredActive`, `active`, then `fast.enabled`. Merge model overrides by exact `provider/id`. A project `null` masks the global override and inherits the common tier. Model overrides also take precedence over the session-wide `--fast` choice.
- A command waits for idle, snapshots the controller, and applies the selection. Persist only when `persistState` allows it. Failure restores both the snapshot and displayed state. Save to an existing project configuration; otherwise use the global file. Preserve unrelated keys and replace through a unique `wx`, `0600` temporary file, cleaning it afterward.
- Returning to inheritance deletes a global model entry but writes `null` in a project file. A load error selects defaults and session-only changes, preventing an invalid file from being overwritten.
- Fast accepts exact entries from `DEFAULT_SUPPORTED_MODELS`. `supportedModels` replaces that entire list, including when empty. Ultrafast uses a separate eligibility policy: `gpt-6-astra` or `gpt-6.1-sol`, configured authentication, HTTPS on the default/443 port, and no URL credentials, query, or fragment.
- For `openai` with `openai-responses`, Ultrafast allows `/v1` at `api.openai.com` and `us.api.openai.com`; `eu.api.openai.com` is Sol-only. For `openai-codex` with `openai-codex-responses`, require OAuth and `chatgpt.com/backend-api`, optionally extended by `/codex` or `/codex/responses`. A trailing slash is allowed. Ineligibility does not trigger an endpoint or model substitution.
- `injectProviderPayload()` ignores nonobjects and payloads whose model differs from the current model. It returns a copy with `priority` for active Fast or `ultrafast` for active Ultrafast. Initial implicit Standard adds nothing. Explicit common/model Standard adds `default` only for a model that supports tier control. An unsupported acceleration preference remains saved but is not injected. `lastPayloadInjection` records preparation, not server execution or billing.
- Session startup reloads settings and clears injection history. A model switch recalculates eligibility without saving and reports effective-tier/activation changes according to settings. Shutdown clears the footer. Model selection respects `scopedModels` without deleting hidden models' preferences. Sorting uses the Astra/Sol/Luna families, descending numeric versions, then model keys; the current selection has no special sort priority.
- Enter saves a TUI choice; R restores inheritance. Closing while saving waits for completion. Non-TUI selection calls the same setter. Environments without UI use explicit command arguments. UI components must not write configuration independently.

## 4. Conventions

- User-facing `ServiceTier` values are `standard | fast | ultrafast`; transport values are `default | priority | ultrafast`. Keep desired selection distinct from activation.
- Distinguish an absent effective override from the project's intentional `null` inheritance marker.
- Keep parsing/storage in `config.ts`, eligibility and payload logic in `FastController`, Pi integration in `index.ts`, and presentation in `fast-ui.ts`. `FastSettings.setModelTier` is a host-owned persistence callback.
- Use strict ESM TypeScript, `.js` relative imports, and type-only imports. Command failures notify available UI or write to stderr when UI is absent.

## 5. Working Agreements

Apply the [root working agreements](../../AGENTS.md). After code changes, run `pnpm typecheck` from this package directory. Report payload verification separately from actual service-tier acceptance.
