import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    type ApprovalPolicy,
    canonicalJson,
    type DecisionKind,
    digest,
    type GuardAction,
    GuardError,
    immutable,
    type Json,
    type PermissionProfile,
    type PolicyDecision,
    type ReviewAssessment,
    type ReviewContext,
    type ReviewResult,
    ruleDigest,
} from "./contracts.js";
import { DEFAULT_SETTINGS, type GuardSettings } from "./policy/index.js";
import {
    type ReviewApprovalCache,
    reviewCacheContext,
} from "./review/cache.js";
import { safeEvidence } from "./review/context.js";
import {
    INVESTIGATION_TOOLS,
    type ReviewInvestigation,
} from "./review/investigation.js";
import { findReviewModel, reviewReasoning } from "./review/models.js";
import { reviewPolicy } from "./review/policy.js";
import { isReadOnlyReview } from "./review/read-only.js";
import {
    isRequestStructure,
    redactReviewData,
    reviewRedactor,
} from "./review/redaction.js";
import { type Clock, deadlineSignal, withSignal } from "./signals.js";

export interface ReviewRequest {
    readonly systemPrompt: string;
    readonly data: string;
}
export interface ReviewReply {
    readonly decision: DecisionKind;
    readonly reason: string;
    readonly result?: ReviewResult;
    readonly isLegacy?: boolean;
    readonly isCached?: boolean;
}
export interface ReviewProvider {
    /** Stable identities opt custom providers into reuse across processes. */
    readonly cacheIdentity?: string;
    complete(
        request: ReviewRequest,
        options: { signal: AbortSignal; timeoutMs: number },
    ): Promise<unknown>;
}
export interface ReviewExecutionContext {
    readonly environmentId: "local";
    readonly platform: string;
    readonly architecture: string;
    readonly osIsolation: false;
    readonly permissionProfile: PermissionProfile;
    readonly approvalPolicy: ApprovalPolicy;
    readonly approvalsReviewer: "auto_review" | "user";
}
type ProviderContext = Parameters<
    ExtensionContext["modelRegistry"]["streamSimple"]
>[1];
export class PiReviewProvider implements ReviewProvider {
    private readonly investigatedRequests = new WeakSet<ReviewRequest>();
    constructor(
        private readonly context: Pick<
            ExtensionContext,
            "model" | "modelRegistry" | "thinkingLevel"
        >,
        private readonly settings: GuardSettings = DEFAULT_SETTINGS,
        private readonly investigation?: ReviewInvestigation,
    ) {}
    private get model() {
        const override = this.settings.reviewModel;
        const model = override
            ? findReviewModel(
                  this.context.modelRegistry,
                  override.provider,
                  override.id,
              )
            : this.context.model;
        if (!model)
            throw new GuardError(
                "REVIEW_PROVIDER",
                override
                    ? "Configured review model is unavailable"
                    : "No current Pi model is available for review",
            );
        return model;
    }
    get cacheIdentity(): string {
        const model = this.model;
        return digest(
            JSON.parse(
                JSON.stringify({
                    model,
                    reasoning:
                        reviewReasoning(
                            model,
                            this.settings.reviewModel
                                ? undefined
                                : this.context.thinkingLevel,
                        ) ?? null,
                }),
            ),
        );
    }
    canCache(request: ReviewRequest): boolean {
        return !this.investigatedRequests.has(request);
    }
    async complete(
        request: ReviewRequest,
        options: { signal: AbortSignal; timeoutMs: number },
    ): Promise<unknown> {
        const model = this.model;
        const maxTokens = Math.min(
            this.settings.reviewMaxOutputTokens,
            model.maxTokens ?? this.settings.reviewMaxOutputTokens,
        );
        const reasoning = reviewReasoning(
            model,
            this.settings.reviewModel ? undefined : this.context.thinkingLevel,
        );
        const context: ProviderContext = {
            systemPrompt: request.systemPrompt,
            messages: [
                { role: "user", content: request.data, timestamp: Date.now() },
            ],
            tools: this.investigation
                ? ([
                      ...INVESTIGATION_TOOLS,
                  ] as unknown as ProviderContext["tools"])
                : [],
        };
        const startedAt = Date.now();
        for (let round = 0; round < this.settings.reviewMaxRounds; round++) {
            options.signal.throwIfAborted();
            if (
                model.contextWindow &&
                canonicalJson(context).length >
                    Math.max(0, model.contextWindow - maxTokens) * 3
            )
                throw new GuardError(
                    "REVIEW_CONTEXT_OVERFLOW",
                    "Exact review request exceeds model context capacity",
                );
            const response = await withSignal(
                this.context.modelRegistry
                    .streamSimple(model, context, {
                        signal: options.signal,
                        timeoutMs:
                            round === 0
                                ? options.timeoutMs
                                : Math.max(
                                      1,
                                      options.timeoutMs -
                                          (Date.now() - startedAt),
                                  ),
                        maxTokens,
                        // Codex sends no temperature; the Codex backend rejects it.
                        reasoning,
                    })
                    .result(),
                options.signal,
            );
            options.signal.throwIfAborted();
            if (
                response.stopReason === "error" ||
                response.stopReason === "aborted" ||
                response.stopReason === "length"
            )
                throw new GuardError(
                    "REVIEW_PROVIDER",
                    "Review model did not complete its response",
                );
            const calls = response.content.filter(
                (item) => item.type === "toolCall",
            );
            if (!calls.length)
                return response.content
                    .filter((item) => item.type === "text")
                    .map((item) => item.text)
                    .join("");
            if (
                !this.investigation ||
                calls.length > 4 ||
                round + 1 === this.settings.reviewMaxRounds
            )
                throw new GuardError(
                    "REVIEW_INVESTIGATION",
                    "Unsupported investigation or review round limit exceeded",
                );
            this.investigatedRequests.add(request);
            // Keep visible tool calls, never returned private reasoning, in the bounded follow-up.
            context.messages.push({
                ...response,
                content: response.content.filter(
                    (item) => item.type !== "thinking",
                ),
            });
            for (const call of calls) {
                let text: string;
                try {
                    text = await withSignal(
                        this.investigation.execute(
                            call.name,
                            call.arguments,
                            options.signal,
                        ),
                        options.signal,
                    );
                } catch (cause) {
                    throw new GuardError(
                        "REVIEW_INVESTIGATION",
                        "Read-only investigation failed",
                        { cause },
                    );
                }
                context.messages.push({
                    role: "toolResult",
                    toolCallId: call.id,
                    toolName: call.name,
                    content: [{ type: "text", text }],
                    isError: false,
                    timestamp: Date.now(),
                });
            }
        }
        throw new GuardError(
            "REVIEW_INVESTIGATION",
            "Review round limit exceeded",
        );
    }
}
export function parseAssessment(value: unknown): ReviewAssessment {
    if (typeof value !== "string" || value.length > 16000)
        throw new GuardError("REVIEW_PARSE", "Invalid review output");
    let data: Record<string, unknown>;
    try {
        data = JSON.parse(value);
    } catch {
        const first = value.indexOf("{"),
            last = value.lastIndexOf("}");
        if (first < 0 || last < first)
            throw new GuardError("REVIEW_PARSE", "Invalid review JSON");
        try {
            data = JSON.parse(value.slice(first, last + 1));
        } catch {
            throw new GuardError("REVIEW_PARSE", "Invalid review JSON");
        }
    }
    if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        Object.keys(data).some(
            (key) =>
                ![
                    "risk_level",
                    "user_authorization",
                    "outcome",
                    "rationale",
                ].includes(key),
        ) ||
        typeof data.outcome !== "string" ||
        !["allow", "deny"].includes(data.outcome)
    )
        throw new GuardError("REVIEW_PARSE", "Invalid review schema");
    const risk =
        data.risk_level === undefined
            ? data.outcome === "allow"
                ? "low"
                : "high"
            : data.risk_level;
    const authorization =
        data.user_authorization === undefined
            ? "unknown"
            : data.user_authorization;
    if (
        typeof risk !== "string" ||
        !["low", "medium", "high", "critical"].includes(risk) ||
        typeof authorization !== "string" ||
        !["unknown", "low", "medium", "high"].includes(authorization) ||
        (data.rationale !== undefined &&
            (typeof data.rationale !== "string" ||
                data.rationale.length > 4000))
    )
        throw new GuardError("REVIEW_PARSE", "Invalid risk assessment");
    const rationale =
        typeof data.rationale === "string" && data.rationale.trim()
            ? data.rationale
            : data.outcome === "allow"
              ? "Auto-review returned a low-risk allow decision."
              : "Auto-review denied the action without a rationale.";
    const cannotAllow =
        risk === "critical" ||
        (risk === "high" && !["medium", "high"].includes(authorization));
    return immutable({
        risk_level: risk,
        user_authorization: authorization,
        outcome: cannotAllow ? "deny" : data.outcome,
        rationale:
            cannotAllow && data.outcome === "allow"
                ? "Assessment contradicts the mandatory risk threshold"
                : rationale,
    } as ReviewAssessment);
}
export function parseReview(value: unknown): ReviewReply {
    if (typeof value !== "string" || value.length > 4096)
        throw new Error("Invalid review output");
    const data = JSON.parse(value) as Record<string, unknown>;
    if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        Object.keys(data).some(
            (key) => !["decision", "reason"].includes(key),
        ) ||
        typeof data.decision !== "string" ||
        !["allow", "ask", "deny"].includes(data.decision) ||
        typeof data.reason !== "string" ||
        data.reason.length > 1000
    )
        throw new Error("Invalid review schema");
    return immutable({
        decision: data.decision as DecisionKind,
        reason: data.reason,
        isLegacy: true,
    });
}
export async function reviewAction(options: {
    action: GuardAction;
    policyDecision: PolicyDecision;
    provider: ReviewProvider;
    trustedAuthorization: string;
    hasUI: boolean;
    signal?: AbortSignal;
    timeoutMs: number;
    clock?: Clock;
    context?: ReviewContext;
    settings?: GuardSettings;
    executionContext?: ReviewExecutionContext;
    cache?: ReviewApprovalCache;
}): Promise<ReviewReply> {
    const { action, policyDecision } = options;
    if (
        policyDecision.actionDigest !== action.digest ||
        policyDecision.isHardDeny ||
        policyDecision.kind === "deny"
    )
        return {
            decision: "deny",
            reason: "Deterministic policy denied the action",
        };
    if (policyDecision.kind === "allow")
        return { decision: "allow", reason: policyDecision.reason };
    const deadline = deadlineSignal(
        options.signal,
        options.timeoutMs,
        options.clock,
    );
    const policy = reviewPolicy(options.settings?.reviewPolicy);
    const redactor = reviewRedactor(options.settings?.redaction);
    const context = options.context ?? {
        sessionId: action.sessionId,
        contextId: "legacy",
        turnId: "legacy",
        items: [
            {
                id: "legacy-user",
                source: "user",
                trust: "authorization",
                content: safeEvidence(options.trustedAuthorization, redactor),
            },
        ],
    };
    const binding = {
        actionDigest: action.digest,
        contextDigest: options.context?.digest ?? digest(context),
        policyDigest: policy.digest,
    };
    try {
        deadline.signal.throwIfAborted();
        if (context.sessionId !== action.sessionId)
            throw new GuardError(
                "REVIEW_CONTEXT",
                "Review context belongs to another session",
            );
        if (options.context) {
            const { digest: contextDigest, ...fields } = options.context;
            if (contextDigest !== digest(fields))
                throw new GuardError(
                    "REVIEW_CONTEXT",
                    "Review context digest does not match its actual contents",
                );
        }
        if (
            options.executionContext &&
            digest(options.executionContext.permissionProfile) !==
                action.permissionDigest
        )
            throw new GuardError(
                "REVIEW_CONTEXT",
                "Review permission context differs from the bound action",
            );
        // The reviewer reads a masked copy; binding, grants and execution keep the exact action.
        const masked = redactReviewData(
            redactor,
            {
                context,
                untrustedAction: action,
                requestedPermissionDelta: policyDecision.delta,
                policyReason: policyDecision.reason,
                ...(options.executionContext
                    ? { executionContext: options.executionContext }
                    : {}),
                approvalRequest: {
                    category: policyDecision.approvalCategory ?? "sandbox",
                    requiresFreshReview:
                        policyDecision.requiresFreshReview ?? false,
                    requiresUserInput:
                        policyDecision.requiresUserInput ?? false,
                },
            } as unknown as Json,
            isRequestStructure,
        );
        const redactedActionFields = masked.maskedLocations
            .filter(({ path }) => path[0] === "untrustedAction")
            .map(({ path, ruleId }) => ({ path: path.slice(1), ruleId }));
        const request = {
            systemPrompt: policy.text,
            data: canonicalJson({
                ...(masked.value as Record<string, Json>),
                ...(redactedActionFields.length
                    ? { redactedActionFields }
                    : {}),
            }),
        };
        if (
            request.data.length >
            (options.settings?.reviewContextChars ??
                DEFAULT_SETTINGS.reviewContextChars)
        )
            throw new GuardError(
                "REVIEW_CONTEXT_OVERFLOW",
                "Exact request exceeds review context capacity",
            );
        let cacheKey: string | undefined;
        if (options.cache && isReadOnlyReview(action, policyDecision)) {
            const { actionDigest: ignoredActionDigest, ...decisionFields } =
                policyDecision;
            cacheKey = options.cache.key(
                options.provider.cacheIdentity ?? options.provider,
                {
                    action: ruleDigest(action),
                    context: reviewCacheContext(context),
                    policyDecision: decisionFields,
                    policyDigest: policy.digest,
                    trustedAuthorization: options.trustedAuthorization,
                    executionContext: options.executionContext ?? null,
                    settings: options.settings ?? DEFAULT_SETTINGS,
                },
            );
            const assessment = options.cache.get(cacheKey);
            if (assessment)
                return {
                    decision: "allow",
                    reason: assessment.rationale,
                    isCached: true,
                    result: { ...binding, status: "approved", assessment },
                };
        }
        const value = await withSignal(
            options.provider.complete(request, {
                signal: deadline.signal,
                timeoutMs: options.timeoutMs,
            }),
            deadline.signal,
        );
        deadline.signal.throwIfAborted();
        // Existing explicitly supplied providers keep their narrow legacy interface.
        if (
            !(options.provider instanceof PiReviewProvider) &&
            typeof value === "string" &&
            /"decision"\s*:/.test(value)
        ) {
            let legacy: ReviewReply;
            try {
                legacy = parseReview(value);
            } catch {
                throw new GuardError(
                    "REVIEW_PARSE",
                    "Invalid legacy review schema",
                );
            }
            if (legacy.decision === "deny")
                return {
                    ...legacy,
                    result: {
                        ...binding,
                        status: "denied",
                        assessment: {
                            risk_level: "high",
                            user_authorization: "unknown",
                            outcome: "deny",
                            rationale: legacy.reason,
                        },
                    },
                };
            if (
                legacy.decision === "allow" &&
                Object.values(policyDecision.delta).some(
                    (paths) => paths.length,
                )
            )
                return {
                    ...legacy,
                    decision: options.hasUI ? "ask" : "deny",
                    reason: "Legacy assessment cannot automatically increase permission",
                };
            if (legacy.decision === "ask" && !options.hasUI)
                return {
                    ...legacy,
                    decision: "deny",
                    reason: "User approval is unavailable in this mode",
                };
            return legacy;
        }
        const assessment = parseAssessment(value);
        const result: ReviewResult = {
            ...binding,
            status: assessment.outcome === "allow" ? "approved" : "denied",
            assessment,
        };
        if (
            cacheKey &&
            assessment.outcome === "allow" &&
            (!(options.provider instanceof PiReviewProvider) ||
                options.provider.canCache(request))
        ) {
            const rationale = safeEvidence(assessment.rationale, redactor);
            if (typeof rationale === "string")
                options.cache?.remember(
                    cacheKey,
                    { ...assessment, rationale },
                    options.settings?.reviewCacheTtlHours ??
                        DEFAULT_SETTINGS.reviewCacheTtlHours,
                );
        }
        return {
            decision: assessment.outcome,
            reason: assessment.rationale,
            result,
        };
    } catch (error) {
        const failure = options.signal?.aborted
            ? "cancelled"
            : deadline.signal.aborted
              ? "timeout"
              : error instanceof GuardError && error.code === "REVIEW_PARSE"
                ? "invalid-output"
                : error instanceof GuardError &&
                    error.code.startsWith("REVIEW_CONTEXT")
                  ? "context"
                  : error instanceof GuardError &&
                      error.code === "REVIEW_INVESTIGATION"
                    ? "investigation"
                    : "provider";
        const status =
            failure === "cancelled"
                ? "aborted"
                : failure === "timeout"
                  ? "timed-out"
                  : "failed";
        const reason =
            failure === "cancelled"
                ? "Call cancelled"
                : failure === "timeout"
                  ? "Auto-review timed out; this alone is not evidence that the action is unsafe"
                  : `Auto-review failed (${failure}); the action was not executed`;
        return {
            decision: "deny",
            reason,
            result: { ...binding, status, failure, reason },
        };
    } finally {
        deadline.dispose();
    }
}
