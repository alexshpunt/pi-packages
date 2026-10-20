import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { ImageData } from "../core/types.ts";

import { imageMimeType, MAX_IMAGE_BYTES, MAX_IMAGES_BYTES } from "../core/inference/images.ts";
export { imageMimeType, MAX_IMAGE_BYTES, MAX_IMAGES_BYTES } from "../core/inference/images.ts";

async function readImageFile(path: string, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("An image input must be a regular file.");
    if (stat.size > MAX_IMAGE_BYTES) throw new Error(`Each image must be at most ${MAX_IMAGE_BYTES} bytes.`);
    const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_IMAGE_BYTES + 1));
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    signal?.throwIfAborted();
    // If the size changed after stat, the truncated image is not sent.
    if (offset !== stat.size) throw new Error("The image file size changed while reading. Try again.");
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}

/** Reads only the given local files; never fetches URLs or trusts file extensions. */
export async function loadImageFiles(paths: readonly string[], signal?: AbortSignal): Promise<ImageData[]> {
  const images: ImageData[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    const bytes = await readImageFile(path, signal);
    totalBytes += bytes.length;
    if (totalBytes > MAX_IMAGES_BYTES) throw new Error(`Images must total at most ${MAX_IMAGES_BYTES} bytes.`);
    images.push({ mimeType: imageMimeType(bytes), base64Data: bytes.toString("base64") });
  }
  return images;
}
