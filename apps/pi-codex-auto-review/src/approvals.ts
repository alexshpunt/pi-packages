import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditLog } from "./audit.js";
import {
    type ApprovalPolicy,
    approvalEligible,
    canonicalJson,
    digest,
    EMPTY_DELTA,
    type ExecutionAuthority,
    type Grant,
    type GuardAction,
    GuardError,
    immutable,
    type PermissionDelta,
    type PolicyDecision,
    type ReviewContext,
    type ReviewResult,
    ruleDigest,
} from "./contracts.js";
import {
    isPackageCacheEligible,
    type PackageApproval,
    type PackageApprovalScope,
    type PackageApprovalStore,
} from "./package-approvals.js";
import type { GuardSettings } from "./policy/index.js";
import { ReviewApprovalCache } from "./review/cache.js";
import { ReviewLifecycle } from "./review/lifecycle.js";
import {
    type ReviewExecutionContext,
    type ReviewProvider,
    reviewAction,
} from "./reviewer.js";
import { type Clock, deadlineSignal, withSignal } from "./signals.js";

export type ApprovalChoice = "deny" | "once" | "session" | "persistent";
export interface ApprovalUI {
    select(
        action: GuardAction,
        delta: PermissionDelta,
        options: { signal: AbortSignal; timeoutMs: number },
    ): Promise<ApprovalChoice | undefined>;
}
export interface GrantPersistence {
    load(): Promise<Grant[]>;
    save(grants: readonly Grant[]): Promise<void>;
}
export class FileGrantPersistence implements GrantPersistence {
    constructor(readonly path: string) {}
    async load(): Promise<Grant[]> {
        try {
            const data: unknown = JSON.parse(await readFile(this.path, "utf8"));
            if (
                !Array.isArray(data) ||
                data.some(
                    (value) =>
                        value?.scope !== "persistent" ||
                        typeof value.ruleDigest !== "string" ||
                        typeof value.policyRevision !== "string" ||
                        typeof value.permissionDigest !== "string" ||
                        !value.delta ||
                        !["readPaths", "writePaths", "domains"].every(
                            (key) =>
                                Array.isArray(value.delta[key]) &&
                                value.delta[key].every(
                                    (x: unknown) => typeof x === "string",
                                ),
                        ),
                )
            )
                throw new Error("Invalid persistent rules");
            return immutable(data as Grant[]);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw new GuardError(
                "INVALID_GRANTS",
                "Persistent rules could not be loaded",
                { cause: error },
            );
        }
    }
    async save(grants: readonly Grant[]): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temp = `${this.path}.${randomUUID()}.tmp`;
        try {
            await writeFile(temp, `${canonicalJson(grants)}\n`, {
                mode: 0o600,
                flag: "wx",
            });
            await rename(temp, this.path);
        } finally {
            await rm(temp, { force: true });
        }
    }
}
export interface Admission {
    readonly isAllowed: boolean;
    readonly delta: PermissionDelta;
    readonly reason: string;
    readonly grant?: Grant;
    readonly review?: ReviewResult;
    readonly authority?: ExecutionAuthority;
    readonly denialId?: string;
}
export class ApprovalManager {
    readonly lifecycle = new ReviewLifecycle();
    private readonly reviewCache: ReviewApprovalCache;
    private grants: Grant[] = [];
    private tail: Promise<unknown> = Promise.resolve();
    private epoch = new AbortController();
    private sessionId?: string;
    constructor(
        readonly options: {
            reviewTimeoutMs: number;
            approvalTimeoutMs: number;
            audit: AuditLog;
            persistence?: GrantPersistence;
            clock?: Clock;
            approvalPolicy?: ApprovalPolicy;
            approvalsReviewer?: "auto_review" | "user";
            packageApprovals?: PackageApprovalStore;
            reviewCache?: ReviewApprovalCache;
        },
    ) {
        this.reviewCache = options.reviewCache ?? new ReviewApprovalCache();
    }
    async initialize(): Promise<void> {
        this.grants = (await this.options.persistence?.load()) ?? [];
        await this.options.packageApprovals?.load();
        this.reviewCache.initialize();
    }
    /** Caching is an optimization: a failed save never changes the admission result. */
    private async rememberPackage(
        action: GuardAction,
        approval: PackageApproval | undefined,
        scope: PackageApprovalScope,
    ): Promise<void> {
        if (!approval || !this.options.packageApprovals) return;
        try {
            await this.options.packageApprovals.remember(
                approval,
                scope,
                action.sessionId,
            );
            await this.options.audit.record(action, "package-approval", scope);
        } catch {
            await this.options.audit.record(
                action,
                "package-approval",
                "save-failed",
            );
        }
    }
    reset(sessionId?: string): void {
        this.epoch.abort(new GuardError("SESSION_CHANGED", "Session changed"));
        this.epoch = new AbortController();
        this.sessionId = sessionId;
        this.grants = this.grants.filter(
            (grant) => grant.scope === "persistent",
        );
        this.lifecycle.reset();
    }
    invalidate(): void {
        this.reset(this.sessionId);
        this.grants = [];
    }
    async admit(
        action: GuardAction,
        policy: PolicyDecision,
        context: {
            provider: ReviewProvider;
            ui?: ApprovalUI;
            trustedAuthorization: string;
            signal?: AbortSignal;
            reviewContext?: ReviewContext;
            settings?: GuardSettings;
            executionContext?: ReviewExecutionContext;
            packageApproval?: PackageApproval;
            onReviewStart?: () => void;
            onReviewResult?: (result?: ReviewResult) => void;
            onInterrupt?: () => void;
        },
    ): Promise<Admission> {
        this.sessionId ??= action.sessionId;
        const signal = AbortSignal.any([
            this.epoch.signal,
            ...(action.source === "user-bash" ? [] : [this.lifecycle.signal]),
            ...(context.signal ? [context.signal] : []),
        ]);
        const deny = (reason: string): Admission => ({
            isAllowed: false,
            delta: EMPTY_DELTA,
            reason,
        });
        if (signal.aborted || action.sessionId !== this.sessionId)
            return deny("Cancelled or stale session");
        if (
            policy.actionDigest !== action.digest ||
            policy.kind === "deny" ||
            policy.isHardDeny
        ) {
            await this.options.audit.record(action, "policy", "deny");
            return deny(policy.reason);
        }
        if (policy.authority && policy.authority.actionDigest !== action.digest)
            return deny("Authority belongs to another action");
        if (policy.kind === "allow") {
            await this.options.audit.record(action, "policy", "allow");
            return {
                isAllowed: true,
                delta: policy.delta,
                authority: policy.authority,
                reason: policy.reason,
            };
        }
        if (
            !approvalEligible(
                this.options.approvalPolicy ?? "on-request",
                policy.approvalCategory ?? "sandbox",
            )
        )
            return deny("Approval policy disables this request category");
        const obsolete = this.grants.filter(
            (grant) =>
                grant.permissionDigest !== action.permissionDigest ||
                grant.policyRevision !== action.policyRevision,
        );
        if (obsolete.length) {
            this.grants = this.grants.filter(
                (grant) => !obsolete.includes(grant),
            );
            await this.options.audit.record(
                action,
                "grant",
                "invalidated-policy-or-profile",
            );
        }
        const contextId = context.reviewContext?.contextId ?? "legacy";
        const retry = this.lifecycle.consumeRetry(action, contextId);
        let reviewContext = context.reviewContext;
        if (retry && reviewContext) {
            const { digest: previousDigest, ...previous } = reviewContext;
            const fields = {
                ...previous,
                items: [
                    ...reviewContext.items,
                    {
                        id: retry.id,
                        source: "user-confirmation" as const,
                        trust: "authorization" as const,
                        content: {
                            type: "exact-action-retry-approval",
                            actionIdentity: retry.actionIdentity,
                            denialId: retry.denialId,
                            scope: "one retry; fresh policy review required",
                        },
                    },
                ],
            };
            reviewContext = immutable({ ...fields, digest: digest(fields) });
            await this.options.audit.record(action, "retry", "consumed");
        }
        const cached =
            retry ||
            policy.requiresFreshReview ||
            policy.requiresUserInput ||
            policy.authority?.kind === "reviewed-command"
                ? undefined
                : this.grants.find(
                      (grant) =>
                          grant.ruleDigest === ruleDigest(action) &&
                          grant.permissionDigest === action.permissionDigest &&
                          grant.policyRevision === action.policyRevision &&
                          (grant.scope === "persistent" ||
                              grant.sessionId === action.sessionId),
                  );
        if (cached) {
            this.lifecycle.record(action, contextId);
            await this.options.audit.record(action, "grant", cached.scope);
            return {
                isAllowed: true,
                delta: cached.delta,
                grant: cached,
                reason: "Bound rule authorized the action",
            };
        }
        const packageApproval =
            !retry && isPackageCacheEligible(policy)
                ? context.packageApproval
                : undefined;
        if (
            packageApproval &&
            this.options.packageApprovals?.has(
                packageApproval,
                action.sessionId,
            )
        ) {
            this.lifecycle.record(action, contextId);
            await this.options.audit.record(
                action,
                "package-approval",
                "reused",
            );
            return {
                isAllowed: true,
                delta: policy.delta,
                authority: {
                    kind: "scoped-permissions",
                    actionDigest: action.digest,
                },
                reason: "The same approved package version authorized the action",
            };
        }
        context.onReviewStart?.();
        const review =
            this.options.approvalsReviewer === "user" ||
            policy.requiresUserInput
                ? {
                      decision: "ask",
                      reason: "User review requested",
                      result: undefined,
                  }
                : await reviewAction({
                      action,
                      policyDecision: policy,
                      provider: context.provider,
                      trustedAuthorization: context.trustedAuthorization,
                      hasUI: Boolean(context.ui),
                      signal,
                      timeoutMs: this.options.reviewTimeoutMs,
                      clock: this.options.clock,
                      context: reviewContext,
                      settings: context.settings,
                      executionContext: context.executionContext,
                      cache: retry ? undefined : this.reviewCache,
                  });
        context.onReviewResult?.(review.result);
        if (signal.aborted)
            return { ...deny("Call cancelled"), review: review.result };
        if ("isCached" in review && review.isCached)
            await this.options.audit.record(action, "review-cache", "reused");
        const recorded = this.lifecycle.record(
            action,
            contextId,
            review.result,
        );
        if (recorded.shouldInterrupt) context.onInterrupt?.();
        if (review.result)
            await this.options.audit.recordReview(action, review.result);
        if (review.decision === "deny")
            return {
                ...deny(review.reason),
                review: review.result,
                denialId: recorded.denialId,
            };
        if (review.decision === "allow") {
            if (signal.aborted)
                return deny("Turn interrupted before approval could execute");
            if (
                review.result &&
                (review.result.status !== "approved" ||
                    review.result.actionDigest !== action.digest ||
                    (reviewContext &&
                        review.result.contextDigest !== reviewContext.digest))
            )
                return deny(
                    "Review result does not match the bound action and context",
                );
            if (!review.result && policy.authority?.kind === "reviewed-command")
                return deny(
                    "Full command approval requires a structured assessment",
                );
            await this.options.audit.record(action, "review", "approved");
            if (review.result?.status === "approved")
                await this.rememberPackage(
                    action,
                    packageApproval,
                    "persistent",
                );
            return {
                isAllowed: true,
                delta: policy.delta,
                authority: policy.authority ?? {
                    kind: "scoped-permissions",
                    actionDigest: action.digest,
                },
                reason: review.reason,
                review: review.result,
            };
        }
        if (!context.ui) return deny("Approval UI unavailable");
        const ui = context.ui;
        // Queue all dialogs, including compensated persistence, until this decision settles.
        const pending = this.tail.then(async (): Promise<Admission> => {
            if (signal.aborted) return deny("Queued approval cancelled");
            const deadline = deadlineSignal(
                signal,
                this.options.approvalTimeoutMs,
                this.options.clock,
            );
            try {
                const choice = await withSignal(
                    ui.select(action, policy.delta, {
                        signal: deadline.signal,
                        timeoutMs: this.options.approvalTimeoutMs,
                    }),
                    deadline.signal,
                );
                deadline.signal.throwIfAborted();
                if (!choice || choice === "deny")
                    return deny("User denied the action");
                if (!["once", "session", "persistent"].includes(choice))
                    return deny("Invalid approval scope");
                const persistence = this.options.persistence;
                if (choice === "persistent" && !persistence)
                    return deny("Persistent rules are unavailable");
                if (
                    policy.authority?.kind === "reviewed-command" &&
                    choice !== "once"
                )
                    return deny(
                        "Full command authority can only be approved for one invocation",
                    );
                if (
                    (policy.requiresFreshReview || policy.requiresUserInput) &&
                    choice !== "once"
                )
                    return deny(
                        "This request requires a fresh one-use approval",
                    );
                const grant: Grant = immutable({
                    id: randomUUID(),
                    scope: choice,
                    actionDigest: action.digest,
                    ruleDigest: ruleDigest(action),
                    sessionId: action.sessionId,
                    policyRevision: action.policyRevision,
                    permissionDigest: action.permissionDigest,
                    delta: policy.delta,
                });
                if (choice === "persistent" && persistence) {
                    const prior = this.grants.filter(
                        (item) => item.scope === "persistent",
                    );
                    await persistence.save([...prior, grant]);
                    if (deadline.signal.aborted) {
                        await persistence.save(prior);
                        return deny(
                            "Persistent approval cancelled and reverted",
                        );
                    }
                }
                deadline.signal.throwIfAborted();
                if (choice !== "once") {
                    this.grants.push(grant);
                    await this.rememberPackage(action, packageApproval, choice);
                }
                await this.options.audit.record(action, "approval", choice);
                // Once-grants are consumed at logical admission; helpers share this returned immutable profile.
                return {
                    isAllowed: true,
                    delta: grant.delta,
                    grant,
                    authority: policy.authority,
                    reason: "User authorized the bound action",
                };
            } catch {
                await this.options.audit.record(
                    action,
                    "approval",
                    "cancelled-or-failed",
                );
                return deny("Approval cancelled or failed");
            } finally {
                deadline.dispose();
            }
        });
        this.tail = pending.then(
            () => {},
            () => {},
        );
        return pending;
    }
    async settle(): Promise<void> {
        await this.tail;
        await this.options.audit.flush();
    }
    async close(): Promise<void> {
        await this.settle();
        this.reviewCache.close();
    }
}
