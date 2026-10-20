# @buyong/pi-codex-image-gen

**English** | [한국어](README.ko.md)

Create new images or edit reference images from a Pi conversation. The package provides the Codex-compatible `image_gen` tool and `imagegen` skill. It uses Pi's `openai-codex` ChatGPT subscription credentials for image requests without switching your conversation provider or model.

## Requirements

- Node.js 22.19 or later and Pi 1.0.0 or later.
- A usable ChatGPT Plus/Pro subscription login through Pi's `openai-codex` provider. Account eligibility and actual image-model availability depend on the backend response.
- For edits, readable local reference images or images still present in the model-visible conversation.

An OpenAI API key alone does not provide the subscription credentials this extension uses. Prompts and reference images are sent to the image backend; use only data you are authorized to send.

## Quick start: create an image

Install a published release, then start Pi:

```sh
pi install npm:@buyong/pi-codex-image-gen
pi list
pi
```

Do not also enable this extension through `@buyong/pi-codex`. Inside Pi, sign in:

```text
/login openai-codex
```

The extension checks login before each user prompt. Without usable subscription login it hides the tool and skill. After login, an extension-hidden tool is restored before the next prompt; a tool you disabled yourself stays disabled. Keep your conversation model selected.

Optionally run `/codex-imagen` to check or change the image model before generating. With no saved choice, it uses `gpt-image-2.5`. Then ask:

```text
Use image_gen to create a watercolor illustration of a small cafe on a rainy street.
```

A successful result contains a PNG image. Saving a local copy is separate and best-effort; see [output and storage](#output-and-storage). No image means the request failed or returned no image data—inspect the tool error rather than assuming that a file was created.

## Edit a local or conversation image

Choose the source before requesting an edit:

- **Local file:** supply an absolute path to an image Pi can read.
- **Conversation image:** attach it, or keep it in the current model-visible context. Images removed by context changes are not automatically recovered.

For a local file:

```text
Use image_gen to edit /absolute/path/to/product.png. Remove the background and keep the product unchanged with a transparent background.
```

Replace the example path with your file. Ask explicitly for transparency when needed. Up to five reference images can be used in one edit.

| Tool argument | Behavior |
| --- | --- |
| `prompt` | Required description of the new image or edits |
| `transparent_background` | Boolean; defaults to `false` |
| `referenced_image_paths` | Up to five absolute local paths; `~/` expands to the home directory |
| `num_last_images_to_include` | Use the latest 1–5 images from the current model-visible conversation |

The model chooses the reference arguments from your request. Use `referenced_image_paths` for local files or `num_last_images_to_include` for conversation images, not both. Omit both for a new image. Unknown fields, invalid types/counts, and conflicting reference choices are rejected before a request is sent.

Local PNG/JPEG/WebP references retain their source bytes after decode validation. Other formats are converted to PNG if Pi can decode them. Recent conversation images are sent in chronological order as recorded. If fewer requested images remain in context, the call reports an error rather than selecting unrelated files.

## Select an image model

Run `/codex-imagen` to select **`gpt-image-2.5`** (default) or **`gpt-image-2`**. This setting selects the image backend model, not the conversation model. Cancelling keeps the current choice. Without a UI, run one of these explicit alternatives:

```text
/codex-imagen gpt-image-2.5
/codex-imagen gpt-image-2
```

Settings live at `<agentDir>/codex-image-gen/settings.json`. `agentDir` honors `PI_CODING_AGENT_DIR` and normally is `~/.pi/agent`.

```json
{
  "model": "gpt-image-2.5"
}
```

The choice is saved and applies to subsequent generation/editing requests, including after restarting Pi. Every request rereads the file, so manual edits apply without `/reload`. A missing file or missing `model` uses the default. Invalid or unreadable settings return an error; the extension does not silently select another model. Commands preserve unrelated settings keys when saving.

These model names are sent to the subscription backend. Their presence in the selector is not proof that the account/backend supports them.

## Output and storage

The tool returns the first image from the backend response as PNG image content and attempts to save it at:

```text
<agentDir>/generated_images/<sessionId>/<toolCallId>.png
```

Session/tool-call names are sanitized for filenames. A save failure does not discard the returned image. For SDK/tool consumers, `details.savedPath` identifies a successful save; the text hint can be omitted for an unusually long path. Keep a local copy if you need to edit the result after it leaves conversation context.

An error is returned when authentication cannot be resolved, a reference cannot be loaded, settings are invalid, the backend fails, or no image data is returned. The caller's cancellation signal is passed to image requests; cancellation does not establish whether a remote service already performed work.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Tool hidden or missing subscription credentials | Run `/login openai-codex` again. Keep your conversation model selected. If you disabled the tool manually, re-enable it yourself. |
| Invalid image-model setting | Set `model` to `gpt-image-2.5` or `gpt-image-2` in the named settings file; the next request rereads it. |
| Local reference cannot be read/decoded | Check the absolute path, file permissions, and supported image decoding. |
| Requested recent images are unavailable | Attach them again or use their saved local paths; images outside the current model-visible context are not recovered automatically. |
| Backend rejects the model or account | Check your account access and the returned error. The extension does not substitute another model or use an API key as a subscription fallback. |

## Build and load from source

Run from the [pi-packages](https://github.com/buYoung/pi-packages) repository root:

```sh
pnpm install
pnpm --filter @buyong/pi-codex-image-gen build
pnpm --filter @buyong/pi-codex-image-gen exec pi -ne -e ./dist/index.js --skill ./skills
```

The explicit skill path loads the bundled guidance for this temporary invocation. `-ne` disables automatic extension discovery. Rebuild after source changes. Source runs still need Pi's subscription login; building does not generate an image or verify live account access.

See the [repository release process](https://github.com/buYoung/pi-packages#공통-ci와-패키지별-배포) for package preparation.

## License

Code: [Apache-2.0](LICENSE), included as `LICENSE` in the archive. The adapted Codex skill also includes its [license](skills/imagegen/LICENSE.txt) and [attribution notice](skills/imagegen/NOTICE).
