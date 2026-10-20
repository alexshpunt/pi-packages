# Changelog

## [Unreleased]

### New

- `image_gen` calls now show a short summary with the operation, image size, and saved path instead of the model-facing path hint. Click the path to open the image in your default app.
- Click a generated image to zoom it to fit the terminal height, and click it again to restore its size. Each image zooms separately in Pi's default fullscreen mode.

### Improved

- The bundled `imagegen` skill now tells the model that independent images can be generated in parallel by requesting them in one response.

## [0.2.4] - 2026-10-20

### Improved

- Source code, issues, and release notes moved to the [pi-packages](https://github.com/buYoung/pi-packages) repository.
