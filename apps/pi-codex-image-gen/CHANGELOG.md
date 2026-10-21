# Changelog

## [Unreleased]

## [0.3.1] - 2026-10-21

### Improved

- The README explains how a successful result appears in terminals with and without inline images, and that local reference paths may start with `~/`.

## [0.3.0] - 2026-10-21

### New

- `image_gen` calls now show a short summary with the operation, image size, and saved path instead of the model-facing path hint. Click the path to open the image in your default app.
- Click a generated image to zoom it to fit the terminal height, and click it again to restore its size. Each image zooms separately in Pi's default fullscreen mode.

### Improved

- The bundled `imagegen` skill now tells the model that independent images can be generated in parallel by requesting them in one response.
- Large backend responses are bounded, and oversized errors no longer flood the conversation.
- Local reference loading respects cancellation and rejects directories, pipes, and device paths.
- Empty or invalid image data now returns an error; large valid images no longer silently fail to save. Saving a local copy remains best-effort.
- Documented where generated images remain and how to clean them up manually.

## [0.2.4] - 2026-10-20

### Improved

- Source code, issues, and release notes moved to the [pi-packages](https://github.com/buYoung/pi-packages) repository.
