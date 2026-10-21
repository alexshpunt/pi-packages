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

For several independent images, the bundled skill asks the model to request them in one response, and Pi runs those calls in parallel. The model may still request them one at a time, and each image is a separate request to the subscription backend.

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

Local references must be regular files; directories, pipes, and devices are rejected. PNG/JPEG/WebP references retain their source bytes after decode validation. Other formats are converted to PNG if Pi can decode them. Cancellation is passed to file reads and checked before and after each conversion; a conversion already running cannot be interrupted. Recent conversation images are sent in chronological order as recorded. If fewer requested images remain in context, the call reports an error rather than selecting unrelated files.

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

Saved images are not automatically deleted. With the default agent directory, they remain under `~/.pi/agent/generated_images/`; `PI_CODING_AGENT_DIR` changes that root. To check disk usage on macOS/Linux:

```sh
du -sh "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/generated_images"
```

To clean up, open that directory in your file manager and manually delete unneeded PNG files or session subdirectories after copying any images you want to keep. This does not remove image data already recorded in Pi's session history.

An error is returned when authentication cannot be resolved, a reference cannot be loaded, settings are invalid, the backend fails, or image data is missing, empty, or invalid base64. Successful response bodies are limited to 128 MiB (including base64 and JSON); larger responses are stopped and reported as errors without retrying. HTTP error bodies over 16 KiB are omitted while preserving the status code. Backend error text is limited to 4 KiB after secret redaction, with a notice when shortened. The caller's cancellation signal is passed to image requests and response reads; cancellation does not establish whether a remote service already performed work.

## View generated images

In the interactive terminal, each `image_gen` call shows the request (operation, background, and the prompt on one line until you expand the row). After a successful call it shows the image size, the saved path, and how to view it. The model still receives the path hint, but it is not shown on screen. Pi draws the image below the summary when your terminal supports inline images (Kitty graphics or iTerm2 protocol).

- **Zoom an image:** click the image. It grows to the widest size that fits the terminal height; click it again to return to Pi's image width (`terminal.imageWidthCells`). Each image zooms separately. This works in Pi's default `fullscreen` mode, where Pi receives mouse clicks; in `regular` mode the terminal keeps the clicks and images do not zoom.
- **Open the saved file:** click the path. The path is an OSC 8 link: in `fullscreen` mode Pi opens it with the platform default app, and in `regular` mode your terminal opens it (some terminals need Cmd or Ctrl). If your terminal is not detected as link-capable, the extension opens the file itself with `open` (macOS), `xdg-open` (Linux), or `rundll32 url.dll,FileProtocolHandler` (Windows). It does not do so over SSH (`SSH_CONNECTION`, `SSH_CLIENT`, or `SSH_TTY` is set), where the app would open on the remote machine, or on Linux and other Unix systems without `DISPLAY` or `WAYLAND_DISPLAY`.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Tool hidden or missing subscription credentials | Run `/login openai-codex` again. Keep your conversation model selected. If you disabled the tool manually, re-enable it yourself. |
| Invalid image-model setting | Set `model` to `gpt-image-2.5` or `gpt-image-2` in the named settings file; the next request rereads it. |
| Local reference cannot be read/decoded | Check the absolute path, file permissions, and supported image decoding. |
| Requested recent images are unavailable | Attach them again or use their saved local paths; images outside the current model-visible context are not recovered automatically. |
| Backend rejects the model or account | Check your account access and the returned error. The extension does not substitute another model or use an API key as a subscription fallback. |
| Only a text placeholder appears instead of the image | Pi turns off inline images in tmux and does not detect Windows Terminal, VS Code, Alacritty, or JetBrains terminals as image-capable. Open the saved path, or set Pi's `terminal.images` if your terminal supports Kitty or iTerm2 images. |
| Clicking the image does not zoom | Use Pi's default `fullscreen` mode (`tuiMode`); in `regular` mode Pi does not receive mouse clicks. If the terminal is too short for a larger image, the image keeps its size. |
| Clicking the path opens nothing | Read the status line below the path, if one appears. Over SSH or without a graphical session the extension does not start an app. On Linux, install `xdg-open` (xdg-utils). |

## Build and load from source

Run from the [pi-packages](https://github.com/buYoung/pi-packages) repository root:

```sh
pnpm install
pnpm --filter @buyong/pi-codex-image-gen typecheck
pnpm --filter @buyong/pi-codex-image-gen lint
pnpm --filter @buyong/pi-codex-image-gen build
pnpm --filter @buyong/pi-codex-image-gen exec pi -ne -e ./dist/index.js --skill ./skills
```

The explicit skill path loads the bundled guidance for this temporary invocation. `-ne` disables automatic extension discovery. Rebuild after source changes. Source runs still need Pi's subscription login; building does not generate an image or verify live account access.

Image-click zoom stays inactive in this source run. Loaded from the package directory, the extension imports the development copies of Pi's packages in `node_modules` instead of the running Pi, so its click handler attaches to the wrong class. To try zoom from source, load a packed copy without `node_modules`:

```sh
cd apps/pi-codex-image-gen
mkdir -p /tmp/pi-codex-image-gen-try
npm pack --ignore-scripts --pack-destination /tmp/pi-codex-image-gen-try
tar xzf /tmp/pi-codex-image-gen-try/*.tgz -C /tmp/pi-codex-image-gen-try
pi -ne -e /tmp/pi-codex-image-gen-try/package/dist/index.js --skill /tmp/pi-codex-image-gen-try/package/skills
```

See the [repository release process](https://github.com/buYoung/pi-packages#공통-ci와-패키지별-배포) for package preparation.

## License

Code: [Apache-2.0](LICENSE), included as `LICENSE` in the archive. The adapted Codex skill also includes its [license](skills/imagegen/LICENSE.txt) and [attribution notice](skills/imagegen/NOTICE).
