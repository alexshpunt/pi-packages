# AGENTS.md

<!-- agents-md-generator: v1; doc-type: single_repo -->

## 1. Overview

This extension generates and edits images through subscription authentication independently of the conversation model. It supplies `image_gen`, a separate image-model setting, and the imagegen skill.

## 2. Ownership Map

### Stable Ownership Boundaries

- **Visibility and authentication.** `src/exposure.ts` decides tool/skill exposure; `src/auth.ts` resolves execution credentials. `src/index.ts` applies exposure at session startup, branch changes, and prompt preparation. Check active tools and the branch's `image_gen.exposure` record: authentication alone must not revive a manually disabled tool.
- **Request preparation.** `src/arguments.ts` selects generation or editing; `src/tool.ts` carries that plan through reference loading and execution. `reference-images.ts` owns image inputs and `backend.ts` owns transport. Keep the schema, `description.ts`, and `skills/imagegen/SKILL.md` aligned with the final request and error results.
- **Image-model selection.** Change `src/settings.ts` and `/codex-imagen` in `src/commands.ts` together. Each execution rereads settings. Verify the next request's model independently of the conversation model; malformed configuration must not silently choose another model.
- **Artifacts.** `src/artifact.ts` saves files and `src/result.ts` builds public results. Inspect image content and optional `details.savedPath`. Storage failure must not suppress an otherwise usable image, and `details` must not contain image bytes.

## 3. Core Behaviors & Patterns

- Exposure checks only local `openai-codex` authentication configuration, without network access. Hiding an active unauthenticated tool records extension ownership. Restore it only when the current branch's record or memory fallback says the extension hid it. An already active authenticated tool clears an obsolete hidden record; switching branches discards the other branch's fallback. Preserve unrelated tools and their order. When the tool is unavailable, remove only imagegen from that prompt; do not install a missing skill.
- Execution obtains Pi-managed provider authentication and requires `chatgpt_account_id`; Pi owns login and refresh. Resolve the base URL from authentication, then provider configuration, then the ChatGPT backend default, appending `/codex` when needed. Preserve auth headers and add the account header plus a per-call `x-codex-image-turn-id`. Fail with authentication guidance rather than switching to API-key authentication or a conversation model. Locally configured auth does not prove service access.
- `prepareArguments` runs the dedicated parser before generic schema validation, and execution parses again. Unknown fields and incorrect types fail in the established order. Transparency defaults to false. Null reference options count as omitted; an empty path array does not select path editing.
- The plan is exactly one of new generation, editing up to five absolute paths with `~` expansion, or editing the latest one to five visible history images. Nonempty paths and a history count cannot be combined. Load model settings and references before progress notifications, authentication, or network work.
- Local images are decoded to establish usability. PNG/JPEG/WebP retain their original bytes; other readable formats are converted to PNG. History references come only from `user`, `custom`, and `toolResult` images in the current session projection. Select the latest N, send them chronologically, and do not re-encode them. Insufficient visible history fails rather than searching hidden history or unrelated files.
- Supported models are the default `gpt-image-2.5` and `gpt-image-2`. Only a missing file or model key uses the default. Malformed or unreadable settings fail the request. Saves preserve unrelated keys and atomically rename a unique `wx`, `0600` temporary file, then clean up. Commands wait for idle and do not save canceled selections. There is no settings cache or fallback model to conceal an error.
- `ImagesClient` sends JSON to `images/generations` or `images/edits`; edits contain data-URL references. After the initial request, only transport failures and HTTP 5xx receive up to four retries. Do not retry 429, decoding errors, or cancellation. Prefer Retry-After; otherwise use jittered exponential backoff from 200ms. Forward the caller's signal to fetch and waits and check between stages. Local cancellation does not guarantee remote generation has stopped.
- Remove reflected tokens, account identifiers, and sensitive header values from transport/decoding errors. Known request, reference, authentication, settings, and backend failures become `isError: true` text results; cancellation and unexpected errors propagate.
- No returned image is an error; multiple images yield the first as PNG content. Artifact saving validates base64 and writes `<agentDir>/generated_images/<sanitized-session>/<sanitized-call>.png`, potentially replacing the same call's file. On save failure, return the image without a saved path. A successful save adds `details.savedPath`; omit the textual path notice when it would exceed 1024 UTF-8 bytes.

## 4. Conventions

- Preserve public snake_case arguments such as `referenced_image_paths`. Internally use the `ImageRequestPlan` variants `generate`, `edit-paths`, and `edit-history`. Model selection belongs to settings, not the tool schema.
- Keep parsing errors, reference errors, transport, artifact storage, and result assembly separate. `ImageGenDetails` contains operation, background, and optional path, not prompts, credentials, or base64.
- `IMAGE_GEN_SCHEMA` defines the public shape; `parseImageGenArguments()` adds constraints and ordered diagnostics. Update both when changing arguments.
- Use strict ESM TypeScript and `.js` relative imports. Keep the compiled entry and the skill's `LICENSE.txt`/`NOTICE` in the package checked by the shared archive validator.

## 5. Working Agreements

Apply the [root working agreements](../../AGENTS.md). After code changes, run `pnpm typecheck` from this package directory. Type safety does not establish subscription eligibility or successful live image generation.
