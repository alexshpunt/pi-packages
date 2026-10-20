import { randomUUID } from "node:crypto";
import type { Redactor } from "@buyong/redact";
import {
    canonicalJson,
    createProfile,
    EMPTY_DELTA,
    GuardError,
    type Json,
    type PermissionProfile,
} from "../contracts.js";
import { canonicalPath, isWithin } from "../policy/paths.js";
import type { ToolExecutor } from "../tools/executor.js";
import { safeEvidence } from "./context.js";
import { reviewRedactor } from "./redaction.js";

export const INVESTIGATION_TOOLS = [
    {
        name: "inspect_file",
        description:
            "Read local text without modifying it; use only when it changes the review decision.",
        parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
        },
    },
    {
        name: "inspect_directory",
        description: "List local directory metadata without modifying it.",
        parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
        },
    },
] as const;
export interface ReviewInvestigation {
    execute(name: string, args: unknown, signal: AbortSignal): Promise<string>;
}
export class LocalInvestigation implements ReviewInvestigation {
    constructor(
        private readonly executor: ToolExecutor,
        private readonly profile: PermissionProfile,
        private readonly cwd: string,
        private readonly redactor: Redactor = reviewRedactor(),
    ) {}
    async execute(
        name: string,
        args: unknown,
        signal: AbortSignal,
    ): Promise<string> {
        signal.throwIfAborted();
        if (
            !["inspect_file", "inspect_directory"].includes(name) ||
            !args ||
            typeof args !== "object" ||
            Array.isArray(args) ||
            Object.keys(args).length !== 1 ||
            typeof (args as { path?: unknown }).path !== "string"
        )
            throw new GuardError(
                "REVIEW_INVESTIGATION",
                "Only bounded read-only inspection is supported",
            );
        const path = await canonicalPath(
            (args as { path: string }).path,
            this.cwd,
        );
        const denies = await Promise.all(
            this.profile.denyRead.map((value) =>
                canonicalPath(value, this.cwd),
            ),
        );
        if (denies.some((root) => isWithin(path, root)))
            throw new GuardError(
                "REVIEW_INVESTIGATION",
                "Protected paths cannot be inspected",
            );
        const profile = createProfile({
            ...this.profile,
            mode: "read-only",
            readRoots: ["/"],
            writeRoots: [],
            denyWrite: ["/"],
            allowedDomains: [],
            deniedDomains: [],
        });
        const tool = name === "inspect_file" ? "read" : "ls";
        const result = await this.executor.execute(
            {
                kind: "tool",
                tool,
                args: { path, limit: tool === "read" ? 120 : 100 },
                cwd: this.cwd,
                toolCallId: `review-${randomUUID()}`,
            },
            profile,
            EMPTY_DELTA,
            { signal, timeoutSeconds: 15 },
        );
        signal.throwIfAborted();
        const raw = result as { content?: { type: string; text?: string }[] };
        const visible: Json =
            raw.content
                ?.filter((item) => item.type === "text")
                .map((item) => ({ type: "text", text: item.text ?? "" })) ?? [];
        // Mask the full output before the excerpt so a cut cannot split a detection.
        const text = canonicalJson(safeEvidence(visible, this.redactor));
        return text.length <= 12000
            ? text
            : `${text.slice(0, 12000)}\n<truncated reason="inspection-output-limit" />`;
    }
}
