import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { Redactor } from "@buyong/redact";
import {
    canonicalJson,
    createProfile,
    EMPTY_DELTA,
    GuardError,
    type Json,
    type PermissionProfile,
} from "../contracts.js";
import {
    canonicalPath,
    isProtectedWithin,
    isRemoteWindowsPath,
} from "../policy/paths.js";
import type { ToolExecutor } from "../tools/executor.js";
import { safeEvidence } from "./context.js";
import { reviewRedactor } from "./redaction.js";

const MAX_INSPECTION_BYTES = 1024 * 1024;

async function readInspectionFile(
    path: string,
    signal: AbortSignal,
): Promise<string> {
    signal.throwIfAborted();
    // Windows defines neither flag; FIFOs do not exist there, and the identity check below
    // replaces O_NOFOLLOW.
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const file = await open(
        path,
        constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0),
    );
    try {
        const metadata = await file.stat({ bigint: true });
        if (!noFollow) {
            const link = await lstat(path, { bigint: true });
            if (
                link.isSymbolicLink() ||
                link.dev !== metadata.dev ||
                link.ino !== metadata.ino
            )
                throw new GuardError(
                    "REVIEW_INVESTIGATION",
                    "Inspection file changed during review",
                );
        }
        if (!metadata.isFile())
            throw new GuardError(
                "REVIEW_INVESTIGATION",
                "Inspection requires a regular text file",
            );
        if (metadata.size > BigInt(MAX_INSPECTION_BYTES))
            throw new GuardError(
                "REVIEW_INVESTIGATION",
                "Inspection file exceeds the 1 MiB read limit",
            );
        const buffer = Buffer.alloc(MAX_INSPECTION_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
            signal.throwIfAborted();
            const { bytesRead } = await file.read(
                buffer,
                length,
                buffer.length - length,
                length,
            );
            if (!bytesRead) break;
            length += bytesRead;
        }
        signal.throwIfAborted();
        if (length > MAX_INSPECTION_BYTES)
            throw new GuardError(
                "REVIEW_INVESTIGATION",
                "Inspection file exceeds the 1 MiB read limit",
            );
        return buffer.subarray(0, length).toString("utf8");
    } finally {
        await file.close();
    }
}

export const INVESTIGATION_TOOLS = [
    {
        name: "inspect_file",
        description:
            "Inspect regular text files up to 1 MiB without modifying them; use only when it changes the review decision.",
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
        // Inspection runs before approval; opening a remote share would contact its host.
        if (isRemoteWindowsPath(path))
            throw new GuardError(
                "REVIEW_INVESTIGATION",
                "Remote paths cannot be inspected",
            );
        const denies = await Promise.all(
            this.profile.denyRead.map((value) =>
                canonicalPath(value, this.cwd),
            ),
        );
        if (denies.some((root) => isProtectedWithin(path, root)))
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
        let visible: Json;
        if (name === "inspect_file") {
            const original = await readInspectionFile(path, signal);
            const masked = this.redactor.redactText(original, {
                filePath: path,
            });
            const lines = masked.split("\n");
            visible = [
                {
                    type: "text",
                    text:
                        lines.slice(0, 120).join("\n") +
                        (lines.length > 120
                            ? '\n<truncated reason="inspection-line-limit" />'
                            : ""),
                },
            ];
        } else {
            const result = await this.executor.execute(
                {
                    kind: "tool",
                    tool: "ls",
                    args: { path, limit: 100 },
                    cwd: this.cwd,
                    toolCallId: `review-${randomUUID()}`,
                },
                profile,
                EMPTY_DELTA,
                { signal, timeoutSeconds: 15 },
            );
            signal.throwIfAborted();
            const raw = result as {
                content?: { type: string; text?: string }[];
            };
            visible =
                raw.content
                    ?.filter((item) => item.type === "text")
                    .map((item) => ({ type: "text", text: item.text ?? "" })) ??
                [];
        }
        signal.throwIfAborted();
        // File contents are masked before either line or character excerpting.
        const text = canonicalJson(safeEvidence(visible, this.redactor));
        return text.length <= 12000
            ? text
            : `${text.slice(0, 12000)}\n<truncated reason="inspection-output-limit" />`;
    }
}
