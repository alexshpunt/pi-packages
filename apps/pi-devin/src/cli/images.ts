import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { Effect } from "effect";
import { toDevinError, type DevinError } from "../core/errors.ts";
import { imageMimeType, MAX_IMAGE_BYTES, MAX_IMAGES_BYTES } from "../core/inference/images.ts";
import type { ImageData } from "../core/types.ts";
import { failWith } from "../core/validation.ts";

export { imageMimeType, MAX_IMAGE_BYTES, MAX_IMAGES_BYTES } from "../core/inference/images.ts";

/**
 * Opened with O_NONBLOCK through `node:fs` so a FIFO or device path cannot block the CLI before the regular-file check.
 * Effect's FileSystem only takes string flags, so it cannot express that.
 */
const openImage = (path: string) => Effect.acquireRelease(
  Effect.tryPromise({ try: () => open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)), catch: toDevinError }),
  (file: FileHandle) => Effect.promise(() => file.close().catch(() => {})),
);

function readImageFile(path: string): Effect.Effect<Buffer, DevinError> {
  return Effect.scoped(Effect.gen(function* () {
    const file = yield* openImage(path);
    const stat = yield* Effect.tryPromise({ try: () => file.stat(), catch: toDevinError });
    if (!stat.isFile()) return yield* failWith("An image input must be a regular file.");
    if (stat.size > MAX_IMAGE_BYTES) return yield* failWith(`Each image must be at most ${MAX_IMAGE_BYTES} bytes.`);
    const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_IMAGE_BYTES + 1));
    let offset = 0;
    while (offset < bytes.length) {
      const result = yield* Effect.tryPromise({ try: () => file.read(bytes, offset, bytes.length - offset, offset), catch: toDevinError });
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    // If the size changed after stat, the truncated image is not sent.
    if (offset !== stat.size) return yield* failWith("The image file size changed while reading. Try again.");
    return bytes.subarray(0, offset);
  }));
}

/** Reads only the given local files; never fetches URLs or trusts file extensions. */
export function loadImageFiles(paths: readonly string[]): Effect.Effect<ImageData[], DevinError> {
  return Effect.gen(function* () {
    const images: ImageData[] = [];
    let totalBytes = 0;
    for (const path of paths) {
      const bytes = yield* readImageFile(path);
      totalBytes += bytes.length;
      if (totalBytes > MAX_IMAGES_BYTES) return yield* failWith(`Images must total at most ${MAX_IMAGES_BYTES} bytes.`);
      images.push({ mimeType: yield* imageMimeType(bytes), base64Data: bytes.toString("base64") });
    }
    return images;
  });
}
