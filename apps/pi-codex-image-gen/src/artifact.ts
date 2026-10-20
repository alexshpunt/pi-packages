import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** `GENERATED_IMAGE_ARTIFACTS_DIR` in Codex `artifact.rs`. */
export const GENERATED_IMAGES_DIR = "generated_images";
/** `MAX_IMAGE_GENERATION_OUTPUT_HINT_BYTES` in Codex `artifact.rs`. */
export const MAX_OUTPUT_HINT_BYTES = 1024;

const STRICT_BASE64 =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Keeps `[A-Za-z0-9_-]`, replaces every other code point with `_`, never empty. */
export function sanitizeArtifactName(value: string): string {
    const sanitized = value.replace(/[^A-Za-z0-9_-]/gu, "_");
    return sanitized === "" ? "generated_image" : sanitized;
}

/** `image_generation_artifact_path` in Codex `artifact.rs`. */
export function imageGenerationArtifactPath(
    saveRoot: string,
    sessionId: string,
    callId: string,
): string {
    return join(
        saveRoot,
        GENERATED_IMAGES_DIR,
        sanitizeArtifactName(sessionId),
        `${sanitizeArtifactName(callId)}.png`,
    );
}

/** Decodes standard base64 with required padding, as Codex's `BASE64_STANDARD` does. */
function decodeStrictBase64(value: string): Buffer {
    const trimmed = value.trim();
    if (!STRICT_BASE64.test(trimmed)) {
        throw new Error("invalid base64 image data");
    }
    return Buffer.from(trimmed, "base64");
}

/**
 * Saves the generated image under the save root, creating parents and overwriting an existing
 * file. Returns the path, or `undefined` when saving failed (the call still succeeds).
 */
export async function saveGeneratedImage(
    saveRoot: string,
    sessionId: string,
    callId: string,
    base64Png: string,
): Promise<string | undefined> {
    const path = imageGenerationArtifactPath(saveRoot, sessionId, callId);
    try {
        const bytes = decodeStrictBase64(base64Png);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
        return path;
    } catch {
        return undefined;
    }
}

/** `image_generation_output_hint` in Codex `artifact.rs`; omitted when over the byte limit. */
export function imageGenerationOutputHint(
    outputDir: string,
    outputPath: string,
): string | undefined {
    const hint =
        `Generated images are saved to ${outputDir} as ${outputPath} by default.\n` +
        "If you need to use a generated image at another path, copy it and leave the original in place unless the user explicitly asks you to delete it.\n" +
        "The generated image is already displayed to the user. There is no need to render it in the final response as a Markdown image or file link.";
    return Buffer.byteLength(hint, "utf8") <= MAX_OUTPUT_HINT_BYTES
        ? hint
        : undefined;
}
