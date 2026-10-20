import { randomUUID } from "node:crypto";
import type { Redactor } from "@buyong/redact";
import type {
    BeforeAgentStartEvent,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    canonicalJson,
    digest,
    type GuardAction,
    GuardError,
    immutable,
    type Json,
    type ReviewContext,
    type ReviewContextItem,
    type ReviewResult,
} from "../contracts.js";
import {
    isContentStructure,
    redactReviewData,
    reviewRedactor,
} from "./redaction.js";

export const AUTHORIZATION_ENTRY = "pi-codex-auto-review.authorization.v1";
export const REVIEW_CONTEXT_ENTRY = "pi-codex-auto-review.context.v1";
/** Mask reviewer-bound evidence; content envelope identifiers stay unchanged. */
export function safeEvidence(
    value: Json,
    redactor: Redactor = reviewRedactor(),
): Json {
    return redactReviewData(redactor, value, isContentStructure).value;
}
function visibleMessage(
    message: unknown,
    redactor: Redactor,
): Json | undefined {
    if (!message || typeof message !== "object") return;
    const raw = message as {
        role?: string;
        content?: unknown;
        toolCallId?: string;
        toolName?: string;
        isError?: boolean;
    };
    const role = raw.role;
    if (!role || !["assistant", "toolResult", "user"].includes(role)) return;
    const content =
        typeof raw.content === "string"
            ? raw.content
            : Array.isArray(raw.content)
              ? raw.content.flatMap<Json>((item) => {
                    if (item.type === "text")
                        return [{ type: "text", text: String(item.text) }];
                    if (item.type === "toolCall")
                        return [
                            {
                                type: "toolCall",
                                id: String(item.id),
                                name: String(item.name),
                                arguments: JSON.parse(
                                    canonicalJson(item.arguments),
                                ),
                            },
                        ];
                    return []; // Private reasoning, signatures and binary payloads never enter review.
                })
              : [];
    return safeEvidence(
        {
            role,
            content,
            ...(raw.toolCallId ? { toolCallId: raw.toolCallId } : {}),
            ...(raw.toolName ? { tool: raw.toolName } : {}),
            ...(typeof raw.isError === "boolean"
                ? { isError: raw.isError }
                : {}),
        },
        redactor,
    );
}

/** Retains genuine authorization separately from summaries and extension-generated messages. */
export class ReviewContextStore {
    private items = new Map<string, ReviewContextItem>();
    private sessionId = "";
    private contextId = randomUUID();
    private turnId = randomUUID();
    private authorizationVersion = 0;
    private instructionOptions?: BeforeAgentStartEvent["systemPromptOptions"];
    private nativeResultIds = new Set<string>();
    constructor(
        private readonly persist?: (item: ReviewContextItem) => void,
        /** Read at each addition, so settings changes apply to later evidence only. */
        private readonly redactor: () => Redactor = reviewRedactor,
    ) {}
    get identity(): string {
        return this.contextId;
    }
    get turnIdentity(): string {
        return this.turnId;
    }
    get scopeVersion(): number {
        return this.authorizationVersion;
    }
    reset(
        sessionId: string,
        manager?: ExtensionContext["sessionManager"],
    ): void {
        this.sessionId = sessionId;
        this.contextId = randomUUID();
        this.turnId = randomUUID();
        this.items.clear();
        this.authorizationVersion++;
        this.instructionOptions = undefined;
        this.nativeResultIds.clear();
        for (const entry of manager?.getBranch?.() ?? []) {
            if (
                entry.type === "custom" &&
                entry.customType === AUTHORIZATION_ENTRY
            ) {
                const data = entry.data as { text?: unknown; source?: unknown };
                if (
                    typeof data?.text === "string" &&
                    ["interactive", "rpc"].includes(String(data.source))
                )
                    this.authorize(data.text, entry.id);
            } else if (
                entry.type === "custom" &&
                entry.customType === REVIEW_CONTEXT_ENTRY
            ) {
                const item = entry.data as ReviewContextItem;
                const isReview =
                    item?.source === "assistant" &&
                    item.content &&
                    typeof item.content === "object" &&
                    !Array.isArray(item.content) &&
                    item.content.role === "previous-review";
                if (
                    item &&
                    typeof item.id === "string" &&
                    (["tool-call", "tool-result", "user-confirmation"].includes(
                        item.source,
                    ) ||
                        isReview) &&
                    item.trust ===
                        (item.source === "user-confirmation"
                            ? "authorization"
                            : "evidence") &&
                    item.content !== undefined
                ) {
                    this.add(
                        item.source,
                        item.trust,
                        item.content,
                        item.id,
                        false,
                        item.isTruncated,
                    );
                    if (
                        item.source === "tool-result" &&
                        item.content &&
                        typeof item.content === "object" &&
                        !Array.isArray(item.content) &&
                        typeof item.content.toolCallId === "string"
                    )
                        this.nativeResultIds.add(item.content.toolCallId);
                }
            } else if (entry.type === "message")
                this.message(entry.message, entry.id);
            else if (
                entry.type === "compaction" ||
                entry.type === "branch_summary"
            )
                this.summary(entry.summary, entry.id);
        }
    }
    startTurn(): void {
        this.turnId = randomUUID();
        this.nativeResultIds.clear();
    }
    authorize(text: string, id: string = randomUUID()): void {
        this.add("user", "authorization", text, id);
    }
    confirm(content: Json, id: string = randomUUID()): void {
        this.add("user-confirmation", "authorization", content, id, true);
    }
    recordUserAnswer(content: Json): void {
        this.confirm(content);
        this.authorizationVersion++;
    }
    instructions(event: BeforeAgentStartEvent): void {
        // Pi shares this mutable options object across all before_agent_start handlers.
        // Refresh again at admission, after later extensions have finished changing it.
        this.instructionOptions = event.systemPromptOptions;
        this.refreshInstructions();
    }
    refreshInstructions(): void {
        const options = this.instructionOptions;
        if (!options) return;
        const contextFiles =
            options.forceSystemPrompt !== undefined ? [] : options.contextFiles;
        // The structured runtime source establishes provenance, never a filename found in tool output.
        const current = new Set(
            contextFiles.map((file) => `agents:${file.path}`),
        );
        for (const [id, item] of this.items)
            if (item.source === "agents" && !current.has(id)) {
                this.items.delete(id);
                this.authorizationVersion++;
            }
        for (const file of contextFiles)
            this.add(
                "agents",
                "authorization",
                { path: file.path, content: file.content },
                `agents:${file.path}`,
            );
        for (const name of [
            "customPrompt",
            "appendSystemPrompt",
            "forceSystemPrompt",
        ] as const) {
            const content =
                options.forceSystemPrompt !== undefined &&
                name !== "forceSystemPrompt"
                    ? undefined
                    : options[name];
            if (content)
                this.add(
                    "developer",
                    "authorization",
                    content,
                    `runtime:${name}`,
                );
            else if (this.items.delete(`runtime:${name}`))
                this.authorizationVersion++;
        }
    }
    finalizeInstructions(): void {
        this.refreshInstructions();
        this.instructionOptions = undefined;
    }
    message(message: unknown, id: string = randomUUID()): void {
        const raw = message as { role?: string; toolCallId?: string };
        // tool_execution_end carries the final result plus nested/structured metadata.
        if (
            raw?.role === "toolResult" &&
            raw.toolCallId &&
            this.nativeResultIds.delete(raw.toolCallId)
        )
            return;
        const content = visibleMessage(message, this.redactor());
        if (content !== undefined)
            this.add(
                (message as { role: string }).role === "toolResult"
                    ? "tool-result"
                    : "assistant",
                "evidence",
                content,
                id,
            );
    }
    mainPrompt(text: string): void {
        this.add(
            "assistant",
            "evidence",
            { role: "main-agent-system-prompt", text },
            "runtime:main-prompt",
        );
    }
    summary(text: string, id: string): void {
        this.add("assistant", "evidence", { role: "summary", text }, id);
    }
    assessment(action: GuardAction, result: ReviewResult): void {
        this.add(
            "assistant",
            "evidence",
            {
                role: "previous-review",
                callIdentity: this.callIdentity(action.toolCallId),
                toolCallId: action.toolCallId,
                actionDigest: action.digest,
                result: JSON.parse(canonicalJson(result)),
            },
            `review:${this.callIdentity(action.toolCallId)}`,
            true,
        );
    }
    callIdentity(toolCallId: string): string {
        return `${this.turnId}:${toolCallId}`;
    }
    toolCall(content: Json, id: string): void {
        this.add("tool-call", "evidence", content, `call:${id}`);
    }
    preparedAction(action: GuardAction): void {
        const callIdentity = this.callIdentity(action.toolCallId),
            previous = this.items.get(`call:${callIdentity}`)?.content;
        const metadata =
            previous && typeof previous === "object" && !Array.isArray(previous)
                ? Object.fromEntries(
                      Object.entries(previous).filter(([key]) =>
                          ["parentToolCallId", "parentCallIdentity"].includes(
                              key,
                          ),
                      ),
                  )
                : {};
        this.add(
            "tool-call",
            "evidence",
            {
                ...metadata,
                stage: "prepared",
                callIdentity,
                toolCallId: action.toolCallId,
                actionDigest: action.digest,
                tool: action.tool,
                args: action.args as Json,
                cwd: action.cwd,
                source: action.source,
            },
            `call:${callIdentity}`,
            true,
        );
    }
    toolResult(content: Json, id: string): void {
        this.add("tool-result", "evidence", content, `result:${id}`, true);
        if (
            content &&
            typeof content === "object" &&
            !Array.isArray(content) &&
            typeof content.toolCallId === "string"
        )
            this.nativeResultIds.add(content.toolCallId);
    }
    private add(
        source: ReviewContextItem["source"],
        trust: ReviewContextItem["trust"],
        content: Json,
        id: string,
        shouldPersist = false,
        isTruncated = false,
    ): void {
        let safe = safeEvidence(content, this.redactor());
        const text = canonicalJson(safe),
            maxChars =
                source === "tool-call" || source === "tool-result"
                    ? 4000
                    : 20000;
        if (trust === "evidence" && text.length > maxChars) {
            const metadata =
                safe && typeof safe === "object" && !Array.isArray(safe)
                    ? Object.fromEntries(
                          Object.entries(safe).filter(([key]) =>
                              [
                                  "role",
                                  "tool",
                                  "toolCallId",
                                  "parentToolCallId",
                                  "callIdentity",
                                  "parentCallIdentity",
                                  "isError",
                                  "stage",
                              ].includes(key),
                          ),
                      )
                    : {};
            const half = Math.floor((maxChars - 300) / 2);
            safe = {
                ...metadata,
                excerpt: `${text.slice(0, half)}\n<truncated reason="review-entry-budget" />\n${text.slice(-half)}`,
                originalChars: text.length,
            };
            isTruncated = true;
        }
        if (
            trust === "authorization" &&
            source !== "user-confirmation" &&
            canonicalJson(this.items.get(id)?.content ?? null) !==
                canonicalJson(safe)
        )
            this.authorizationVersion++;
        const item = immutable({
            id,
            source,
            trust,
            content: safe,
            ...(isTruncated ? { isTruncated: true } : {}),
        });
        this.items.set(id, item);
        if (shouldPersist) this.persist?.(item);
    }
    snapshot(maxChars: number, exactActionChars = 0): ReviewContext {
        const authorization = [...this.items.values()].filter(
            (item) => item.trust === "authorization",
        );
        const evidence = [...this.items.values()].filter(
            (item) => item.trust === "evidence",
        );
        const fields = {
            sessionId: this.sessionId,
            contextId: this.contextId,
            turnId: this.turnId,
        };
        let remaining =
            maxChars -
            exactActionChars -
            canonicalJson({ ...fields, items: authorization }).length -
            512;
        if (remaining < 0)
            throw new GuardError(
                "REVIEW_CONTEXT_OVERFLOW",
                "Required authorization and exact action exceed review context capacity",
            );
        const retained: ReviewContextItem[] = [];
        for (const item of evidence.reverse()) {
            const text = canonicalJson(item);
            if (text.length <= remaining) {
                retained.unshift(item);
                remaining -= text.length;
            }
        }
        const retainedIds = new Set(
            [...authorization, ...retained].map((item) => item.id),
        );
        const ordered = [...this.items.values()].filter((item) =>
            retainedIds.has(item.id),
        );
        if (retained.length !== evidence.length)
            ordered.unshift({
                id: "omission",
                source: "assistant",
                trust: "evidence",
                content: '<truncated reason="review-context-budget" />',
                isTruncated: true,
            });
        const data = { ...fields, items: ordered };
        return immutable({ ...data, digest: digest(data) });
    }
}
