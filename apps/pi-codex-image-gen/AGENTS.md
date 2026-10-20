# AGENTS.md

<!-- agents-md-generator: v1; doc-type: single_repo -->

## 1. Overview

This extension generates or edits images using subscription credentials independently of the conversation model. It exposes `image_gen`, an image-model selector, and the bundled `imagegen` skill.

## 2. Ownership Map

### Stable Ownership Boundaries

- **Authentication and exposure**: Start in `src/exposure.ts` for tool/skill visibility and `src/auth.ts` for call-time credentials. `src/index.ts` applies exposure on session start, branch navigation, and before prompts. Preserve branch-local ownership of hidden tools: login must not re-enable a manually disabled tool. Verify active-tool lists and branch exposure records with and without configured authentication.
- **Request contract**: Start in `src/arguments.ts` and `src/tool.ts` for schema preparation, generate/edit dispatch, and error/result handling. `src/reference-images.ts` resolves references; `src/backend.ts` owns transport and retries. Keep the schema, `src/description.ts`, and `skills/imagegen/SKILL.md` consistent. The verification surface is the prepared request body and the tool's image/error result, not a successful local save alone.
- **Model preference**: Start in `src/settings.ts` for saved image-model selection and `src/commands.ts` for `/codex-imagen`. Every execution reloads the preference; invalid settings must not silently choose another model. Check the settings file and the next request's `model`, independently of the conversation model.
- **Artifact output**: Start in `src/artifact.ts` for paths and persistence, and `src/result.ts` for public result details. Saving is best-effort; image delivery must survive a filesystem error. Verify PNG content, optional `details.savedPath`, and absence of image bytes from `details`.
- **Display**: Start in `src/render.ts` for call/result rendering, `src/image-zoom.ts` for image-click zoom, and `src/open-image.ts` for default-app launching. Rendering changes only the terminal view; the model-facing `content` is unchanged. Pi draws image blocks itself without mouse handling, so renderers must not draw them again, and the zoom wraps `ToolExecutionComponent.prototype.handleMouse` once, only for clicks Pi leaves unhandled. That wrapper reads host-internal row fields (`toolName`, `children`, `imageWidthCells`); recheck it when Pi changes. It only works when the extension receives Pi's own modules: loaded from this package directory, imports resolve to the devDependency copies in `node_modules` and the wrapper attaches to an unused class. Verify zoom with a packed copy that has no `node_modules` (installs omit peers), in an image-capable terminal in fullscreen mode.

## 3. Core Behaviors & Patterns

- **Visibility is not authentication success**: Exposure uses the local `openai-codex` auth status without a network request. If active without auth, the extension hides only `image_gen` and records ownership in `image_gen.exposure`. It restores an inactive tool only when the current branch record, or its branch-local in-memory fallback, says the extension hid it. An already-active authenticated tool clears an old hidden record; branch navigation discards another branch's fallback. Other tools keep their order/state. An unavailable tool removes `imagegen` only from that prompt's skill list; it never installs a missing skill.
- **Credential resolution**: `resolveOpenAiCredentials` asks Pi for `openai-codex` provider auth and requires a token containing `chatgpt_account_id`. Pi owns login/refresh. Base URL precedence is resolved auth, provider, then the default ChatGPT backend; append `/codex` if absent. Preserve auth headers, then set the account header; `tool.ts` adds `x-codex-image-turn-id`. Failure returns credential guidance, not an API-key fallback or a chat-model change. Configured status alone does not establish backend/account eligibility.
- **Validate before network work**: `prepareArguments` runs the Codex-compatible parser before generic schema validation, and execution parses again. Reject unknown fields and invalid types; preserve parser error ordering. `transparent_background` defaults to false. Null reference options mean absent, and an empty path list means no path references. Choose generate, nonempty absolute paths (maximum five, with `~` expansion), or recent history (1–5); nonempty paths and a history count conflict. Load settings and resolve references before progress/auth/network activity.
- **Reference fidelity**: Local references are decoded to prove usability. PNG/JPEG/WebP retain source bytes; other decodable formats become PNG. History uses the current session projection's `user`, `custom`, and `toolResult` image blocks, selects the latest requested count, then sends them chronologically without re-encoding. Insufficient visible history fails rather than recovering unrelated files or older hidden context.
- **Independent settings**: `gpt-image-2.5` is the default and `gpt-image-2` the other supported selection. Missing file/model uses the default; malformed or unreadable settings fail the request. Saving preserves unrelated keys via a unique `wx`/`0600` temporary file, rename, and `finally` cleanup. Commands wait for idle; picker cancellation does not save. No cached setting or model substitution hides a load/backend failure.
- **Transport and cancellation**: `ImagesClient` sends JSON to `images/generations` or `images/edits`; edit references become data URLs. There is one initial attempt plus at most four retries for transport failures and HTTP 5xx, not 429, response-decoding errors, or cancellation. Retry-After overrides jittered exponential backoff from 200ms. Keep the caller signal on fetch and backoff, and check cancellation between stages. Cancellation does not prove remote work stopped. Reflected token/account/header secrets are removed from transport and decode error text.
- **Result boundary**: Known reference/auth/settings/backend failures become `isError: true` text results; cancellation and unexpected errors propagate. No returned image data is an error. Only the first backend image is returned as PNG. Saving under `<agentDir>/generated_images/<sanitized-session>/<sanitized-call>.png` validates base64 and may overwrite that call's prior file; any save error yields no saved path but preserves the image result. A successful save adds `details.savedPath`; the textual path hint is omitted above 1024 UTF-8 bytes.

## 4. Conventions

- Use the discriminated `ImageRequestPlan` (`generate`, `edit-paths`, `edit-history`) internally, while keeping Codex's snake_case public arguments such as `referenced_image_paths`. Do not add model selection to the tool schema; it is a separate setting.
- Keep transport errors in `ImageRequestError`, reference errors in `ReferenceImageError`, and model-facing result construction in `src/result.ts`. `ImageGenDetails` contains only operation, background, and an optional path—not prompts, credentials, or base64.
- Preserve the schema/description compatibility boundary: `IMAGE_GEN_SCHEMA` exposes the intended Codex shape while `parseImageGenArguments` owns additional validation and messages.
- Source uses strict ESM TypeScript and `.js` relative import specifiers. Keep adapted skill attribution in `skills/imagegen/LICENSE.txt` and `skills/imagegen/NOTICE`; the package checker requires those alongside compiled entry points.

## 5. Working Agreements

Follow [the root working agreements](../../AGENTS.md).

After code changes, run `pnpm typecheck` from this package directory. Type checking does not verify subscription access or a live image request.
