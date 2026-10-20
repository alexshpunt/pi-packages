import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const IMAGE_MODELS = ["gpt-image-2.5", "gpt-image-2"] as const;
export type ImageModel = (typeof IMAGE_MODELS)[number];
/** Default image model; users can select either supported model in settings. */
export const IMAGE_MODEL: ImageModel = "gpt-image-2.5";

export function isImageModel(value: unknown): value is ImageModel {
    return value === "gpt-image-2.5" || value === "gpt-image-2";
}
/** Maximum reference images per edit (`MAX_EDIT_IMAGES` in Codex `tool.rs`). */
export const MAX_EDIT_IMAGES = 5;

const FIELD_NAMES = [
    "prompt",
    "transparent_background",
    "referenced_image_paths",
    "num_last_images_to_include",
] as const;

/** Arguments after Codex-order validation, in the shape the declared schema accepts. */
export interface ImageGenArguments {
    prompt: string;
    transparent_background: boolean;
    referenced_image_paths?: string[];
    num_last_images_to_include?: number;
}

export type ImageBackground = "transparent" | "opaque";

interface ImageRequestBase {
    prompt: string;
    background: ImageBackground;
    model: ImageModel;
    quality: "auto";
    size: "auto";
}

/** Request Codex would build from the arguments (`ImageRequest` in Codex `tool.rs`). */
export type ImageRequestPlan =
    | (ImageRequestBase & { kind: "generate" })
    | (ImageRequestBase & { kind: "edit-paths"; paths: string[] })
    | (ImageRequestBase & { kind: "edit-history"; count: number });

export interface ParsedImageGenArguments {
    arguments: ImageGenArguments;
    plan: ImageRequestPlan;
}

/** Mirrors serde's `Unexpected` display for a JSON value. */
function describeUnexpected(value: unknown): string {
    if (value === null) {
        return "null";
    }
    if (typeof value === "boolean") {
        return `boolean \`${value}\``;
    }
    if (typeof value === "number") {
        return Number.isInteger(value)
            ? `integer \`${value}\``
            : `floating point \`${value}\``;
    }
    if (typeof value === "string") {
        return `string ${JSON.stringify(value)}`;
    }
    if (Array.isArray(value)) {
        return "sequence";
    }
    if (typeof value === "object") {
        return "map";
    }
    return typeof value;
}

function invalidType(value: unknown, expected: string): Error {
    return new Error(
        `invalid type: ${describeUnexpected(value)}, expected ${expected}`,
    );
}

/** `AbsolutePathBuf::maybe_expand_home_directory` in Codex `absolute-path/src/lib.rs`. */
function expandHomeDirectory(path: string): string {
    if (!path.startsWith("~")) {
        return path;
    }
    const rest = path.slice(1);
    if (rest === "") {
        return homedir();
    }
    if (rest.startsWith("/")) {
        return join(homedir(), rest.replace(/^\/+/, ""));
    }
    return path;
}

/** Deserializes one `AbsolutePathBuf`: `~` expansion, then absolute-path requirement. */
function parseAbsolutePath(value: unknown): string {
    if (typeof value !== "string") {
        throw invalidType(value, "path string");
    }
    const expanded = expandHomeDirectory(value);
    if (!isAbsolute(expanded)) {
        throw new Error("AbsolutePathBuf deserialized without a base path");
    }
    return resolve(expanded);
}

function parseReferencedImagePaths(value: unknown): string[] | undefined {
    if (value === null) {
        return undefined;
    }
    if (!Array.isArray(value)) {
        throw invalidType(value, "a sequence");
    }
    return value.map(parseAbsolutePath);
}

function parseNumLastImages(value: unknown): number | undefined {
    if (value === null) {
        return undefined;
    }
    if (typeof value !== "number") {
        throw invalidType(value, "usize");
    }
    if (!Number.isInteger(value)) {
        throw invalidType(value, "usize");
    }
    if (value < 0) {
        throw new Error(`invalid value: integer \`${value}\`, expected usize`);
    }
    return value;
}

/**
 * Deserializes `ImagegenArgs` the way serde does for Codex: fields in key order, unknown
 * fields rejected, `prompt` required, `transparent_background` defaulting to false.
 */
function deserializeArguments(args: unknown): ImageGenArguments {
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw invalidType(args, "struct ImagegenArgs");
    }
    let prompt: string | undefined;
    let transparentBackground = false;
    let referencedImagePaths: string[] | undefined;
    let numLastImages: number | undefined;
    for (const [key, value] of Object.entries(args)) {
        switch (key) {
            case "prompt":
                if (typeof value !== "string") {
                    throw invalidType(value, "a string");
                }
                prompt = value;
                break;
            case "transparent_background":
                if (typeof value !== "boolean") {
                    throw invalidType(value, "a boolean");
                }
                transparentBackground = value;
                break;
            case "referenced_image_paths":
                referencedImagePaths = parseReferencedImagePaths(value);
                break;
            case "num_last_images_to_include":
                numLastImages = parseNumLastImages(value);
                break;
            default:
                throw new Error(
                    `unknown field \`${key}\`, expected one of ${FIELD_NAMES.map((name) => `\`${name}\``).join(", ")}`,
                );
        }
    }
    if (prompt === undefined) {
        throw new Error("missing field `prompt`");
    }
    const result: ImageGenArguments = {
        prompt,
        transparent_background: transparentBackground,
    };
    if (referencedImagePaths !== undefined) {
        result.referenced_image_paths = referencedImagePaths;
    }
    if (numLastImages !== undefined) {
        result.num_last_images_to_include = numLastImages;
    }
    return result;
}

/** `request_for_call_args` in Codex `tool.rs`, up to the point images are loaded. */
function planRequest(
    args: ImageGenArguments,
    model: ImageModel,
): ImageRequestPlan {
    const base: ImageRequestBase = {
        prompt: args.prompt,
        background: args.transparent_background ? "transparent" : "opaque",
        model,
        quality: "auto",
        size: "auto",
    };
    const paths = args.referenced_image_paths ?? [];
    if (paths.length > MAX_EDIT_IMAGES) {
        throw new Error(
            `\`referenced_image_paths\` must contain at most ${MAX_EDIT_IMAGES} paths`,
        );
    }
    const count = args.num_last_images_to_include;
    if (paths.length === 0 && count === undefined) {
        return { ...base, kind: "generate" };
    }
    if (paths.length > 0 && count === undefined) {
        return { ...base, kind: "edit-paths", paths };
    }
    if (paths.length === 0 && count !== undefined) {
        if (count < 1 || count > MAX_EDIT_IMAGES) {
            throw new Error(
                `\`num_last_images_to_include\` must be between 1 and ${MAX_EDIT_IMAGES}`,
            );
        }
        return { ...base, kind: "edit-history", count };
    }
    throw new Error(
        "provide only one of `referenced_image_paths` or `num_last_images_to_include`",
    );
}

/**
 * Validates raw tool arguments in Codex order and returns both the normalized arguments
 * (for Pi's schema validation) and the request plan. Throws `Error` with Codex's messages.
 */
export function parseImageGenArguments(
    args: unknown,
    model: ImageModel = IMAGE_MODEL,
): ParsedImageGenArguments {
    const normalized = deserializeArguments(args);
    return { arguments: normalized, plan: planRequest(normalized, model) };
}
