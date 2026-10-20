import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
    convertToPng,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ReferenceImage } from "./backend.js";

/** Formats whose source bytes Codex sends unchanged (`can_preserve_source_bytes`). */
const PASS_THROUGH_MIME = {
    png: "image/png",
    jpeg: "image/jpeg",
    webp: "image/webp",
} as const;

type SniffedFormat = keyof typeof PASS_THROUGH_MIME | "other";

const MIME_EXTENSIONS: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
};

/** Error carrying a Codex model-facing message (returned as the tool error, not thrown to Pi). */
export class ReferenceImageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ReferenceImageError";
    }
}

function asciiAt(bytes: Uint8Array, start: number, end: number): string {
    return String.fromCharCode(...bytes.subarray(start, end));
}

/** Content-based detection of the pass-through formats, as `image::guess_format` does. */
export function sniffImageFormat(bytes: Uint8Array): SniffedFormat {
    if (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        asciiAt(bytes, 1, 4) === "PNG" &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
    ) {
        return "png";
    }
    if (
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
    ) {
        return "jpeg";
    }
    if (
        bytes.length >= 12 &&
        asciiAt(bytes, 0, 4) === "RIFF" &&
        asciiAt(bytes, 8, 12) === "WEBP"
    ) {
        return "webp";
    }
    return "other";
}

/**
 * Decodes the image to prove it is usable, then returns the original bytes for png/jpeg/webp
 * and a PNG re-encoding for every other decodable format (`load_for_prompt_bytes` in Codex,
 * `PromptImageMode::Original`).
 */
async function prepareBytes(
    bytes: Uint8Array,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const format = sniffImageFormat(bytes);
    const decoded = await convertToPng(
        Buffer.from(bytes).toString("base64"),
        "application/octet-stream",
    );
    if (decoded === null) {
        throw new Error(
            format === "other"
                ? "The image format could not be determined"
                : "image decoding failed",
        );
    }
    if (format !== "other") {
        return { bytes, mimeType: PASS_THROUGH_MIME[format] };
    }
    return {
        bytes: new Uint8Array(Buffer.from(decoded.data, "base64")),
        mimeType: "image/png",
    };
}

function fileNameFor(stem: string, mimeType: string): string {
    return `${stem}.${MIME_EXTENSIONS[mimeType] ?? "bin"}`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** `image_url` in Codex `tool.rs` for each path, in argument order. */
export async function loadReferenceImages(
    paths: readonly string[],
): Promise<ReferenceImage[]> {
    const images: ReferenceImage[] = [];
    for (const path of paths) {
        let bytes: Uint8Array;
        try {
            bytes = new Uint8Array(await readFile(path));
        } catch (error) {
            throw new ReferenceImageError(
                `unable to read referenced image at \`${path}\`: ${errorMessage(error)}`,
            );
        }
        let prepared: { bytes: Uint8Array; mimeType: string };
        try {
            prepared = await prepareBytes(bytes);
        } catch (error) {
            throw new ReferenceImageError(
                `unable to process referenced image at \`${path}\`: ${errorMessage(error)}`,
            );
        }
        const stem = basename(path, extname(path)) || "image";
        images.push({
            bytes: prepared.bytes,
            mimeType: prepared.mimeType,
            fileName: fileNameFor(stem, prepared.mimeType),
        });
    }
    return images;
}

interface ImageBlock {
    type: "image";
    data: string;
    mimeType: string;
}

function isImageBlock(block: unknown): block is ImageBlock {
    return (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "image" &&
        typeof (block as { data?: unknown }).data === "string" &&
        typeof (block as { mimeType?: unknown }).mimeType === "string"
    );
}

const IMAGE_BEARING_ROLES = new Set(["user", "custom", "toolResult"]);

/**
 * `recent_images` in Codex `tool.rs` over the model-visible context: newest message first,
 * blocks within a message from last to first, exactly `count` images, returned in
 * chronological order. History images are sent as recorded, without re-encoding, as Codex
 * forwards their data URLs unchanged.
 */
export function collectRecentImages(
    ctx: Pick<ExtensionContext, "sessionManager">,
    count: number,
): ReferenceImage[] {
    const messages = ctx.sessionManager.buildSessionProjection().messages;
    const blocks: ImageBlock[] = [];
    collect: for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index] as {
            role?: unknown;
            content?: unknown;
        };
        if (
            typeof message.role !== "string" ||
            !IMAGE_BEARING_ROLES.has(message.role) ||
            !Array.isArray(message.content)
        ) {
            continue;
        }
        for (
            let position = message.content.length - 1;
            position >= 0;
            position--
        ) {
            const block: unknown = message.content[position];
            if (!isImageBlock(block)) {
                continue;
            }
            blocks.push(block);
            if (blocks.length === count) {
                break collect;
            }
        }
    }
    if (blocks.length !== count) {
        throw new ReferenceImageError(
            `requested the last ${count} conversation images, but only ${blocks.length} were available`,
        );
    }
    blocks.reverse();
    return blocks.map((block, index) => ({
        bytes: new Uint8Array(Buffer.from(block.data, "base64")),
        mimeType: block.mimeType,
        fileName: fileNameFor(`image-${index + 1}`, block.mimeType),
    }));
}
