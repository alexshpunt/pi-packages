# @buyong/pi-codex-image-gen

This fork is not published separately. The npm installation instructions below install the upstream release, not this fork.

Create new images or edit reference images from a Pi conversation. The package provides the Codex-compatible `image_gen` tool and `imagegen` skill. It uses Pi's `openai-codex` ChatGPT subscription credentials for image requests without switching your conversation provider or model.

## Requirements

- Node.js 22.19 or later and Pi 1.0.0 or later.
- A usable ChatGPT Plus/Pro subscription login through Pi's `openai-codex` provider. Account eligibility and actual image-model availability depend on the backend response.
- For edits, readable local reference images or images still present in the model-visible conversation.

An OpenAI API key alone does not provide the subscription credentials this extension uses. Prompts and reference images are sent to the image backend; use only data you are authorized to send.

## Privacy and network behavior

Image requests send the prompt and reference images to the configured `openai-codex` backend. The default is `https://chatgpt.com/backend-api/codex`; Pi's resolved authentication or provider configuration can override it. A configured backend receives the bearer token, account ID, and any configured authentication headers as well as the request data. Trust the configured endpoint before using the tool. Redirect responses are rejected rather than followed.

PNG, JPEG, and WebP references are sent as their original bytes and may contain metadata such as EXIF. Other formats are converted to PNG. Reference files are read in full, without a package-specific size limit. Backend errors can include request data reflected by the server; known credentials are redacted, but prompts and image data are not automatically removed.

Network failures and HTTP 5xx responses can trigger up to four retries after the initial request. If a server completes a request before the response is lost, retrying can generate multiple images and incur additional charges. Cancellation does not guarantee remote work stopped. Generated images remain on disk until manually removed, and may also be stored in Pi session history. File permissions depend on the process umask; protect the agent directory accordingly.

## Quick start: create an image

If you already use `@buyong/pi-codex`, it includes this extension; do not install or enable it separately. Otherwise, install a published release, then start Pi:

```sh
pi install npm:@buyong/pi-codex-image-gen
pi list
pi
```

`pi list` shows `npm:@buyong/pi-codex-image-gen` and its installed path under `User packages:`.

Inside Pi, sign in:

```text
/login openai-codex
```

The extension checks login before each user prompt. Without usable subscription login it hides the tool and skill. After login, the extension restores the tool and skill it hid before the next prompt. A tool you turned off yourself stays off, and the skill stays hidden while the tool is off. Keep your conversation model selected.

Optionally run `/codex-imagen` to check or change the image model before generating. With no saved choice, it uses `gpt-image-2.5`. Then ask:

```text
Use image_gen to create a watercolor illustration of a small cafe on a rainy street.
```

A successful result contains a PNG image. In the interactive terminal, Pi shows a summary with the image size and draws the image below it only if your terminal supports inline images; see [view generated images](#view-generated-images). Saving a local copy is separate and best-effort; see [output and storage](#output-and-storage). If the tool returns an error instead of a result, the request failed or returned no image data—inspect the tool error rather than assuming that a file was created.

For several independent images, the bundled skill asks the model to request them in one response, and Pi runs those calls in parallel. The model may still request them one at a time, and each image is a separate request to the subscription backend.

## Edit a local or conversation image

Choose the source before requesting an edit:

- **Local file:** supply an absolute path, or a path starting with `~/`, to an image Pi can read.
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

The model sets these arguments from your request: `referenced_image_paths` for local files, `num_last_images_to_include` for conversation images, and neither for a new image. One call cannot use both reference arguments. Unknown fields, invalid types/counts, and conflicting reference choices are rejected before a request is sent.

Local references must be regular files; directories, pipes, and devices are rejected. PNG/JPEG/WebP references retain their source bytes after decode validation. Other formats are converted to PNG if Pi can decode them. Cancellation is passed to file reads and checked before and after each conversion; a conversion already running cannot be interrupted. Recent conversation images are sent in chronological order as recorded. If fewer images than requested remain in context, the call reports an error rather than selecting unrelated files.

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

The choice is saved and applies to subsequent generation/editing requests, including after restarting Pi. Every request rereads the file, so manual edits apply without `/reload`. A missing file or missing `model` uses the default. Invalid or unreadable settings return an error; the extension does not silently select another model. `/codex-imagen` keeps unrelated settings keys when it saves.

These model names are sent to the subscription backend. Their presence in the selector is not proof that the account/backend supports them.

## Output and storage

The tool returns the first image from the backend response as PNG image content and attempts to save it at:

```text
<agentDir>/generated_images/<sessionId>/<toolCallId>.png
```

Characters that are not safe in filenames are replaced in the session and tool-call IDs. If saving fails, the tool still returns the image. Keep a copy of the saved file if you need to edit the result after it leaves conversation context.

Saved images are not automatically deleted. With the default agent directory, they remain under `~/.pi/agent/generated_images/`; `PI_CODING_AGENT_DIR` changes that root. To check disk usage on macOS/Linux:

```sh
du -sh "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/generated_images"
```

To clean up, open that directory in your file manager and manually delete unneeded PNG files or session subdirectories after copying any images you want to keep. This does not remove image data already recorded in Pi's session history.

An error is returned when authentication cannot be resolved, a reference cannot be loaded, settings are invalid, the backend fails, or image data is missing, empty, or invalid base64. Successful response bodies are limited to 128 MiB (including base64 and JSON); larger responses are stopped and reported as errors without retrying. HTTP error bodies over 16 KiB are omitted while preserving the status code. Backend error text is limited to 4 KiB after secret redaction, with a notice when shortened. The caller's cancellation signal is passed to image requests and response reads; cancellation does not establish whether a remote service already performed work.

For SDK and tool consumers: `details.savedPath` holds the path when saving succeeds. The text hint to the model, which names the path, is left out when it would exceed 1,024 bytes, which happens only with a very long path.

## View generated images

In the interactive terminal, each `image_gen` call shows the request (operation, background, and the prompt on one line until you expand the row). After a successful call, Pi shows a summary with the image size, the saved path, and how to view the image, in place of the text hint that the model receives. Pi draws the image below the summary when your terminal supports inline images (Kitty graphics or iTerm2 protocol).

- **Zoom an image:** click the image. It grows to the widest size that fits the terminal height; click it again to return to Pi's image width (`terminal.imageWidthCells`). Each image zooms separately. This works in Pi's default `fullscreen` mode, where Pi receives mouse clicks; in `regular` mode the terminal keeps the clicks and images do not zoom.
- **Open the saved file:** click the path. The path is an OSC 8 link: in `fullscreen` mode Pi opens it with the platform default app, and in `regular` mode your terminal opens it (some terminals need Cmd or Ctrl). If Pi does not detect OSC 8 link support in your terminal, clicking the path in `fullscreen` mode makes the extension open the file with `open` (macOS), `xdg-open` (Linux), or `rundll32 url.dll,FileProtocolHandler` (Windows). The extension does not open it over SSH (`SSH_CONNECTION`, `SSH_CLIENT`, or `SSH_TTY` is set), where the app would open on the remote machine, or on Linux and other Unix systems without `DISPLAY` or `WAYLAND_DISPLAY`.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Tool hidden or missing subscription credentials | Run `/login openai-codex` again. Keep your conversation model selected. If you turned the tool off yourself (with `--tools`, `--exclude-tools`, `--no-tools`, or Pi's `defaultTools` setting), the extension does not turn it back on; start Pi with `image_gen` enabled. |
| Invalid image-model setting | Set `model` to `gpt-image-2.5` or `gpt-image-2` in `<agentDir>/codex-image-gen/settings.json` (the path in the error); the next request rereads it. |
| Local reference cannot be read/decoded | Check that the path is absolute (or starts with `~/`), the file is readable, and it is a valid PNG, JPEG, or WebP image or another format Pi can decode. |
| Requested recent images are unavailable | Attach them again or use their saved local paths; images outside the current model-visible context are not recovered automatically. |
| Backend rejects the model or account | Check your account access and the returned error. The extension does not substitute another model or use an API key as a subscription fallback. |
| Only a text placeholder appears instead of the image | Pi turns off inline images in tmux and does not detect Windows Terminal, VS Code, Alacritty, or JetBrains terminals as image-capable. Open the saved path. If your terminal supports Kitty or iTerm2 images, set `terminal.images` to `"kitty"` or `"iterm2"` in Pi's `settings.json` (`~/.pi/agent/settings.json` by default). |
| Clicking the image does not zoom | Use Pi's default `fullscreen` mode: remove `"tuiMode": "regular"` from Pi's `settings.json`, or start Pi with `--tui-mode fullscreen`. In `regular` mode Pi does not receive mouse clicks. If the terminal is too short for a larger image, the image keeps its size. |
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

`--skill ./skills` loads the bundled `imagegen` skill for this run. `-ne` disables automatic extension discovery. Rebuild after source changes. Source runs still need Pi's subscription login; building does not generate an image or verify live account access.

Image-click zoom stays inactive in this source run. Loaded from the package directory, the extension imports the development copies of Pi's packages in `node_modules` instead of the running Pi, so its click handler attaches to the wrong class. To try zoom from source, load a packed copy without `node_modules`:

```sh
cd apps/pi-codex-image-gen
mkdir -p /tmp/pi-codex-image-gen-try
npm pack --ignore-scripts --pack-destination /tmp/pi-codex-image-gen-try
tar xzf /tmp/pi-codex-image-gen-try/*.tgz -C /tmp/pi-codex-image-gen-try
pi -ne -e /tmp/pi-codex-image-gen-try/package/dist/index.js --skill /tmp/pi-codex-image-gen-try/package/skills
```

See the [repository release process](https://github.com/buYoung/pi-packages#shared-ci-and-per-package-releases) for package preparation.

## License

Code: [Apache-2.0](LICENSE), included as `LICENSE` in the archive. The adapted Codex skill also includes its [license](skills/imagegen/LICENSE.txt) and [attribution notice](skills/imagegen/NOTICE).
