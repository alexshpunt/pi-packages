import { dirname } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ImageRequestPlan } from "./arguments.js";
import { imageGenerationOutputHint } from "./artifact.js";

/** Small, base64-free details attached to every result (FDD §11.4). */
export interface ImageGenDetails {
    operation: "generate" | "edit";
    background: "transparent" | "opaque";
    savedPath?: string;
}

export function detailsForPlan(plan: ImageRequestPlan): ImageGenDetails {
    return {
        operation: plan.kind === "generate" ? "generate" : "edit",
        background: plan.background,
    };
}

export function errorResult(
    message: string,
    details: ImageGenDetails,
): AgentToolResult<ImageGenDetails> {
    return {
        content: [{ type: "text", text: message }],
        details,
        isError: true,
    };
}

/** `GeneratedImageOutput::to_response_item` in Codex `tool.rs`: the PNG, then the hint. */
export function generatedImageResult(
    plan: ImageRequestPlan,
    base64Png: string,
    savedPath: string | undefined,
): AgentToolResult<ImageGenDetails> {
    const details = detailsForPlan(plan);
    const content: AgentToolResult<ImageGenDetails>["content"] = [
        { type: "image", data: base64Png, mimeType: "image/png" },
    ];
    if (savedPath !== undefined) {
        details.savedPath = savedPath;
        const hint = imageGenerationOutputHint(dirname(savedPath), savedPath);
        if (hint !== undefined) {
            content.push({ type: "text", text: hint });
        }
    }
    return { content, details };
}
