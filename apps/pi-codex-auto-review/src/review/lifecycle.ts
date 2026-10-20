import { randomUUID } from "node:crypto";
import { redact } from "../audit.js";
import {
    type GuardAction,
    GuardError,
    immutable,
    type RecentDenial,
    type RetryAuthorization,
    type ReviewResult,
    retryIdentity,
} from "../contracts.js";

export class ReviewLifecycle {
    private consecutive = 0;
    private window: boolean[] = [];
    private history: RecentDenial[] = [];
    private retries = new Map<string, RetryAuthorization>();
    private turn = new AbortController();
    get signal(): AbortSignal {
        return this.turn.signal;
    }
    get recentDenials(): readonly RecentDenial[] {
        return [...this.history];
    }
    startTurn(): void {
        this.turn.abort(new GuardError("TURN_CHANGED", "Review turn changed"));
        this.turn = new AbortController();
        this.consecutive = 0;
        this.window = [];
    }
    reset(): void {
        this.startTurn();
        this.history = [];
        this.retries.clear();
    }
    invalidateRetries(): void {
        this.retries.clear();
    }
    record(
        action: GuardAction,
        contextId: string,
        result?: ReviewResult,
    ): { denialId?: string; shouldInterrupt: boolean } {
        const isDenied = result?.status === "denied";
        const isModelAction = action.source !== "user-bash";
        if (isModelAction) {
            this.consecutive = isDenied ? this.consecutive + 1 : 0;
            this.window.push(isDenied);
            if (this.window.length > 50) this.window.shift();
        }
        let denialId: string | undefined;
        if (isDenied) {
            denialId = randomUUID();
            this.history.push(
                immutable({
                    id: denialId,
                    action,
                    contextId,
                    assessment: {
                        ...result.assessment,
                        rationale: redact(result.assessment.rationale).slice(
                            0,
                            1000,
                        ),
                    },
                }),
            );
            this.history = this.history.slice(-10);
        }
        const shouldInterrupt =
            isModelAction &&
            !this.turn.signal.aborted &&
            (this.consecutive >= 3 || this.window.filter(Boolean).length >= 10);
        if (shouldInterrupt)
            this.turn.abort(
                new GuardError(
                    "REVIEW_CIRCUIT_OPEN",
                    "Automatic review denial limit reached for this turn",
                ),
            );
        return { denialId, shouldInterrupt };
    }
    authorizeRetry(
        id: string,
        current: {
            sessionId: string;
            contextId: string;
            cwd: string;
            policyRevision: string;
            permissionDigest: string;
        },
    ): RecentDenial {
        const denial = this.history.find((item) => item.id === id);
        if (
            !denial ||
            denial.contextId !== current.contextId ||
            denial.action.sessionId !== current.sessionId ||
            denial.action.cwd !== current.cwd ||
            denial.action.policyRevision !== current.policyRevision ||
            denial.action.permissionDigest !== current.permissionDigest
        )
            throw new GuardError(
                "STALE_RETRY",
                "The denied action no longer belongs to the current context",
            );
        // Like Codex's denied-action approval, authorize a fresh assessment, never an
        // execution override. New facts may correct an earlier critical classification.
        const identity = retryIdentity(denial.action, current.contextId);
        this.retries.set(
            identity,
            immutable({
                id: randomUUID(),
                denialId: denial.id,
                actionIdentity: identity,
                sessionId: current.sessionId,
                contextId: current.contextId,
            }),
        );
        if (this.retries.size > 10) {
            const oldestKey = this.retries.keys().next().value;
            if (oldestKey !== undefined) this.retries.delete(oldestKey);
        }
        this.history = this.history.filter((item) => item.id !== id);
        return denial;
    }
    consumeRetry(
        action: GuardAction,
        contextId: string,
    ): RetryAuthorization | undefined {
        const identity = retryIdentity(action, contextId),
            marker = this.retries.get(identity);
        this.retries.delete(identity); // Synchronous consumption prevents concurrent reuse.
        return marker;
    }
}

export function reviewFeedback(result: ReviewResult): {
    code: string;
    message: string;
} {
    if (result.status === "denied")
        return {
            code: "AUTO_REVIEW_DENIED",
            message: `${redact(result.assessment.rationale).slice(0, 1000)}\nDo not pursue the same outcome through workarounds, indirect execution, or policy circumvention. Continue only with a materially safer alternative; otherwise stop and ask the user.`,
        };
    if (result.status === "timed-out")
        return {
            code: "AUTO_REVIEW_TIMEOUT",
            message:
                "Automatic review timed out. The action was not executed. A timeout alone is not evidence that the action is unsafe. Resolve the timeout or ask the user; do not bypass review.",
        };
    if (result.status === "aborted")
        return {
            code: "AUTO_REVIEW_ABORTED",
            message:
                "Automatic review was cancelled. The action was not executed.",
        };
    return {
        code: "AUTO_REVIEW_FAILED",
        message:
            "Automatic review could not be completed. The action was not executed; this is not a determination that it is unsafe. Resolve the review error or ask the user. Do not bypass review.",
    };
}
