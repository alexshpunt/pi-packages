import {
    type AgentToolUpdateCallback,
    type ExtensionAPI,
    type ExtensionToolContext,
    getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { type ImageRequestPlan, parseImageGenArguments } from "./arguments.js";
import { saveGeneratedImage } from "./artifact.js";
import { resolveOpenAiCredentials } from "./auth.js";
import {
    ImageRequestError,
    type ImageResponse,
    ImagesClient,
    type ReferenceImage,
} from "./backend.js";
import { IMAGE_GEN_DESCRIPTION } from "./description.js";
import {
    collectRecentImages,
    loadReferenceImages,
    ReferenceImageError,
} from "./reference-images.js";
import {
    detailsForPlan,
    errorResult,
    generatedImageResult,
    type ImageGenDetails,
} from "./result.js";
import { ImageGenSettingsStore } from "./settings.js";

export const IMAGE_GEN_TOOL_NAME = "image_gen";
export const IMAGE_GEN_TOOL_LABEL = "Image generation";

type RegisteredToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];

/**
 * Schema the model sees, equal to what Codex sends for its imagegen tool: schemars output
 * reduced to the keywords Codex's tool-schema type keeps (FDD §9.2). Properties are in the
 * sorted order Codex's `BTreeMap` serializes. Limits are enforced in `prepareArguments`, not
 * here, so Pi's generic validation message is unreachable.
 */
export const IMAGE_GEN_SCHEMA = {
    type: "object",
    properties: {
        num_last_images_to_include: { type: ["integer", "null"] },
        prompt: { type: "string" },
        referenced_image_paths: {
            type: ["array", "null"],
            items: { type: "string" },
        },
        transparent_background: {
            type: "boolean",
            description:
                "Whether the output should have a transparent background. Defaults to false.",
        },
    },
    required: ["prompt"],
    additionalProperties: false,
} as const;

export type { ImageGenDetails };

const PROGRESS_TEXT = "Generating image…";
/** `X_CODEX_IMAGE_TURN_ID_HEADER` in Codex `ext/image-generation/src/backend.rs`. */
const IMAGE_TURN_ID_HEADER = "x-codex-image-turn-id";

/** Reference images for edit plans, resolved before any progress or network activity. */
async function collectReferenceImages(
    plan: ImageRequestPlan,
    ctx: ExtensionToolContext,
): Promise<ReferenceImage[]> {
    switch (plan.kind) {
        case "generate":
            return [];
        case "edit-paths":
            return loadReferenceImages(plan.paths);
        case "edit-history":
            return collectRecentImages(ctx, plan.count);
    }
}

/** `handle_call` in Codex `tool.rs`, after the request plan is known. */
async function executeImageGen(
    toolCallId: string,
    plan: ImageRequestPlan,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<ImageGenDetails> | undefined,
    ctx: ExtensionToolContext,
) {
    signal?.throwIfAborted();
    const details = detailsForPlan(plan);
    let images: ReferenceImage[];
    try {
        images = await collectReferenceImages(plan, ctx);
    } catch (error) {
        if (error instanceof ReferenceImageError) {
            return errorResult(error.message, details);
        }
        throw error;
    }
    signal?.throwIfAborted();
    onUpdate?.({ content: [{ type: "text", text: PROGRESS_TEXT }], details });
    const auth = await resolveOpenAiCredentials(ctx);
    if (!auth.ok) {
        return errorResult(auth.error, details);
    }
    signal?.throwIfAborted();
    const client = new ImagesClient({
        ...auth.credentials,
        headers: {
            ...auth.credentials.headers,
            [IMAGE_TURN_ID_HEADER]: toolCallId,
        },
    });
    let response: ImageResponse;
    try {
        response =
            plan.kind === "generate"
                ? await client.generate(plan, signal)
                : await client.edit(plan, images, signal);
    } catch (error) {
        if (error instanceof ImageRequestError) {
            return errorResult(
                `image generation failed: ${error.message}`,
                details,
            );
        }
        throw error;
    }
    const first = response.data[0];
    if (first === undefined) {
        return errorResult("image generation returned no image data", details);
    }
    signal?.throwIfAborted();
    const savedPath = await saveGeneratedImage(
        getAgentDir(),
        ctx.sessionManager.getSessionId(),
        toolCallId,
        first.b64_json,
    );
    return generatedImageResult(plan, first.b64_json, savedPath);
}

export const imageGenTool: RegisteredToolDefinition = {
    name: IMAGE_GEN_TOOL_NAME,
    label: IMAGE_GEN_TOOL_LABEL,
    description: IMAGE_GEN_DESCRIPTION,
    parameters:
        IMAGE_GEN_SCHEMA as unknown as RegisteredToolDefinition["parameters"],
    annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
    },
    prepareArguments: (args) => parseImageGenArguments(args).arguments,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
        const { plan } = parseImageGenArguments(params);
        signal?.throwIfAborted();
        try {
            plan.model = await new ImageGenSettingsStore().load();
        } catch (error) {
            signal?.throwIfAborted();
            return errorResult(
                `image generation failed: unable to load model settings: ${error instanceof Error ? error.message : String(error)}`,
                detailsForPlan(plan),
            );
        }
        return executeImageGen(toolCallId, plan, signal, onUpdate, ctx);
    },
};
