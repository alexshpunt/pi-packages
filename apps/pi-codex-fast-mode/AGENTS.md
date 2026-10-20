# AGENTS.md

<!-- agents-md-generator: v1; doc-type: single_repo -->

## 1. Overview

This extension selects request service tiers without changing the conversation model or endpoint. It keeps saved user intent separate from whether the current model can apply that intent.

## 2. Ownership Map

### Stable Ownership Boundaries

- **Preferences and persistence**: Start in `src/config.ts` for settings layering and saved-state compatibility. `FastSettingsStore` owns global/project persistence; `src/index.ts` owns command transactions and rollback. Preserve per-model inheritance and legacy flag precedence. Check the selected settings file and `/codex-fast status` after a save, reload, and model switch.
- **Eligibility and payload mutation**: Start in `src/fast-controller.ts` for supported tiers, provider checks, and `service_tier` injection. Only eligible requests matching the current model may change; unsupported preferences remain stored. The `before_provider_request` registration in `src/index.ts` is the final consumer. The local proof of concept `experiments/pi-codex-fast-mode/ultrafast-sol/poc-ultrafast-sol.mjs` at the repository root records final HTTP bodies separately from response tiers.
- **Command and UI behavior**: Start in `src/index.ts` for `/codex-fast`, `--fast`, scoped model selection, and lifecycle events; `src/fast-ui.ts` owns TUI and non-TUI presentation. All edits use the same asynchronous setters rather than writing settings from the UI. Verify saved versus focused choices, unavailable speeds, inheritance, and close-during-save behavior in the picker.

## 3. Core Behaviors & Patterns

- **Layered intent**: `resolveConfig` resolves each layer before merging global then project settings. Within a layer, `serviceTier` wins over `desiredActive`, `active`, and `fast.enabled`, in that order. Model mappings merge by exact `provider/id`; a project `null` masks a global model override and restores global-speed inheritance. Model overrides beat global speed even when `--fast` supplies the session's global Fast preference.
- **Persistence transaction**: Commands wait for idle, snapshot the controller, update intent, and persist only when `persistState` is true. Failed saves restore the snapshot and status. The store writes the existing project file, otherwise the global file; it preserves unrelated keys and uses a unique `wx`/`0600` temporary file, rename, and `finally` cleanup. Restoring inheritance deletes a global model entry but writes `null` in a project file. Load failure uses defaults with session-only changes; it does not overwrite the invalid file.
- **Eligibility alternatives**: Fast uses exact `DEFAULT_SUPPORTED_MODELS` membership, replaceable by `supportedModels` (including `[]`). Ultrafast independently requires `gpt-6-astra` or `gpt-6.1-sol`, configured authentication, HTTPS on default/443, and no URL credentials, query, or fragment. The `openai`/`openai-responses` route accepts `/v1` on `api.openai.com` or `us.api.openai.com`, plus `eu.api.openai.com` for Sol only. The `openai-codex`/`openai-codex-responses` route requires OAuth and `chatgpt.com/backend-api`, optionally `/codex` or `/codex/responses`. Optional trailing slashes are accepted. Do not substitute another model or endpoint when a check fails.
- **Injection boundary**: `injectProviderPayload` leaves non-object payloads and other-model requests untouched. Fast injects `priority`; Ultrafast injects `ultrafast`. Initial implicit Standard adds nothing, while explicitly selected global/model Standard injects `default` only on models supporting a speed control. Eligible payloads are copied, not mutated. Unsupported accelerated intent is retained without injection. `lastPayloadInjection` describes a locally prepared request, not server processing or billing.
- **Session and UI lifetime**: Session start reloads settings and clears injection diagnostics. Model selection recalculates activation without saving and optionally notifies on an effective-tier/activation change; shutdown clears the footer. The picker uses available registered models filtered by `scopedModels` when present, retains settings for hidden models, and sorts by Astra/Sol/Luna family, descending numeric version, then model key. Current-model status is a label, not a sorting override. TUI Enter saves one choice, R restores inheritance, and closing during a save waits for it to finish. Non-TUI selection uses the same setters; explicit command arguments also work without UI.

## 4. Conventions

- Use `ServiceTier` (`standard | fast | ultrafast`) for intent and `PayloadInjection` (`default | priority | ultrafast`) for wire values; do not conflate `desiredTier` with `active`.
- Keep parsing/persistence in `config.ts`, compatibility and payload logic in `FastController`, host events/commands in `index.ts`, and presentation in `fast-ui.ts`. For example, `FastSettings.setModelTier` is a callback to the host transaction, not a direct filesystem operation.
- Keep exact `provider/id` keys in model maps. `undefined` means no effective override; persisted project `null` is a deliberate inheritance tombstone, not invalid data.
- Source uses strict ESM TypeScript with `.js` relative import specifiers and type-only imports, such as `import type { ServiceTier } from "./config.js"`. User-facing command errors use UI notifications when available and stderr otherwise.

## 5. Working Agreements

Follow [the root working agreements](../../AGENTS.md).

After code changes, run `pnpm typecheck` from this package directory. This uses the package's existing strict TypeScript configuration without emitting build output.
