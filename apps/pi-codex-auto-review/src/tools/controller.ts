import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { Redactor } from "@buyong/redact";
import {
    type BashOperations,
    type BashToolOptions,
    createBashToolDefinition,
    createLocalBashOperations,
    type ExtensionContext,
    type ReadToolOptions,
    type ToolCallEvent,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Admission, ApprovalManager, ApprovalUI } from "../approvals.js";
import { type AuditLog, redact } from "../audit.js";
import {
    type ActionSource,
    canonicalJson,
    createAction,
    decision,
    digest,
    type ExecutionOptions,
    type GuardAction,
    GuardError,
    type Json,
    type PermissionProfile,
    type PolicyDecision,
    type ReviewContextItem,
    TOOL_NAMES,
    type WorkerJob,
} from "../contracts.js";
import {
    isPackageCacheEligible,
    type PackageApproval,
    skillPackageApproval,
} from "../package-approvals.js";
import {
    canonicalPath,
    type GuardSettings,
    PolicyEngine,
    resolveToolPath,
} from "../policy/index.js";
import { ReviewContextStore, safeEvidence } from "../review/context.js";
import { LocalInvestigation } from "../review/investigation.js";
import { reviewFeedback } from "../review/lifecycle.js";
import { reviewRedactor } from "../review/redaction.js";
import { observeToolUserInput } from "../review/user-input.js";
import {
    PiReviewProvider,
    type ReviewExecutionContext,
    type ReviewProvider,
} from "../reviewer.js";
import { redactedEnvironmentNames, reviewEnvironment } from "./environment.js";
import type { ToolExecutor } from "./executor.js";
import {
    type ExternalToolIdentity,
    externalInvocations,
    externalPolicy,
} from "./external.js";
import { withApprovalMutationQueue } from "./mutation-queue.js";

type ToolSchema = ToolDefinition["parameters"];

export class GuardController {
    private currentPolicy: PolicyEngine;
    get policy(): PolicyEngine {
        return this.currentPolicy;
    }
    readonly approvals: ApprovalManager;
    private sources = new Map<string, ActionSource>();
    private ownedOperations = new WeakSet<BashOperations>();
    private stopped = new AbortController();
    private sessionId = "not-started";
    private isReady = false;
    readonly reviewContext: ReviewContextStore;
    private activeReviews = new Set<string>();
    private settingsUpdates: Promise<void> = Promise.resolve();
    private retryArguments = new Map<string, Readonly<Record<string, Json>>>();
    private externalTools = new Map<
        string,
        { token: string; isEnabled: boolean }
    >();
    /** Codex Full Access: applies until Pi exits or another approval mode is chosen; never saved. */
    private isFullAccessEnabled = false;
    constructor(
        readonly options: {
            profile: PermissionProfile;
            settings: GuardSettings;
            executor: ToolExecutor;
            approvals: ApprovalManager;
            audit: AuditLog;
            provider?: ReviewProvider;
            shellPath?: string;
            persistContext?: (item: ReviewContextItem) => void;
        },
    ) {
        this.reviewContext = new ReviewContextStore(
            options.persistContext,
            () => this.reviewRedactor,
        );
        this.currentPolicy = new PolicyEngine(
            options.settings,
            options.profile,
        );
        this.approvals = options.approvals;
    }
    /** Masks reviewer-bound evidence with the current redaction settings. */
    get reviewRedactor(): Redactor {
        return reviewRedactor(this.options.settings.redaction);
    }
    async initialize(cwd: string): Promise<void> {
        await this.policy.initialize(cwd);
        await this.approvals.initialize();
        this.isReady = true;
    }
    async updateSettings(
        select: (current: GuardSettings) => GuardSettings,
        cwd: string,
        persist: (settings: GuardSettings) => Promise<void>,
    ): Promise<void> {
        const task = this.settingsUpdates.then(async () => {
            this.assertReady();
            const settings = select(this.options.settings);
            if (
                canonicalJson(settings) === canonicalJson(this.options.settings)
            )
                return;
            const policy = new PolicyEngine(settings, this.options.profile);
            await policy.initialize(cwd);
            this.assertReady();
            await persist(settings);
            this.stopped.abort(
                new GuardError("SETTINGS_CHANGED", "Approval settings changed"),
            );
            this.stopped = new AbortController();
            this.approvals.invalidate();
            this.activeReviews.clear();
            this.retryArguments.clear();
            this.options.settings = settings;
            Object.assign(this.approvals.options, {
                approvalsReviewer: settings.approvalsReviewer,
                approvalPolicy: settings.approvalPolicy,
                reviewTimeoutMs: settings.reviewTimeoutMs,
                approvalTimeoutMs: settings.approvalTimeoutMs,
            });
            this.currentPolicy = policy;
        });
        this.settingsUpdates = task.catch(() => {});
        await task;
    }
    get isFullAccess(): boolean {
        return this.isFullAccessEnabled;
    }
    setFullAccess(isEnabled: boolean): void {
        this.assertReady();
        this.isFullAccessEnabled = isEnabled;
    }
    /** Full Access skips approval and every path, command and network restriction, as in Codex. */
    private async evaluate(
        action: GuardAction,
        signal: AbortSignal,
    ): Promise<PolicyDecision> {
        return this.isFullAccessEnabled
            ? decision(action, "allow", "Full Access permits this action")
            : this.policy.evaluate(action, signal);
    }
    assertReady(): void {
        if (!this.isReady || this.stopped.signal.aborted)
            throw new GuardError(
                "GUARD_NOT_READY",
                "Guard is not ready for execution",
            );
    }
    isBoundToSession(sessionId: string): boolean {
        return this.sessionId === sessionId && !this.stopped.signal.aborted;
    }
    reset(
        sessionId: string,
        manager?: ExtensionContext["sessionManager"],
    ): void {
        this.stopped.abort(
            new GuardError("SESSION_CHANGED", "Session changed"),
        );
        this.stopped = new AbortController();
        this.sessionId = sessionId;
        this.reviewContext.reset(sessionId, manager);
        this.approvals.reset(sessionId);
        this.sources.clear();
        this.activeReviews.clear();
        this.retryArguments.clear();
    }
    startTurn(context?: ExtensionContext): void {
        this.reviewContext.startTurn();
        this.reviewContext.finalizeInstructions();
        if (context?.getSystemPrompt)
            this.reviewContext.mainPrompt(context.getSystemPrompt());
        this.approvals.lifecycle.startTurn();
        this.activeReviews.clear();
    }
    async authorizeRetry(id: string, context: ExtensionContext) {
        this.assertReady();
        const denial = this.approvals.lifecycle.authorizeRetry(id, {
            sessionId: context.sessionManager.getSessionId(),
            contextId: this.reviewContext.identity,
            cwd: await canonicalPath(context.cwd, context.cwd),
            policyRevision: this.policy.revision,
            permissionDigest: digest(this.policy.profile),
        });
        const args = this.retryArguments.get(id) ?? denial.action.args;
        this.retryArguments.delete(id);
        return { denial, args };
    }
    async retryUserBash(
        action: GuardAction,
        context: ExtensionContext,
    ): Promise<void> {
        const next = createAction(
            { ...action, toolCallId: randomUUID() },
            this.policy.profile,
        );
        const command = String(next.args.command),
            shellPath = String(next.args.shellPath ?? "/bin/bash");
        await this.admitAndExecute(
            next,
            { kind: "shell", command, shellPath, cwd: next.cwd },
            context,
            {
                timeoutSeconds:
                    typeof next.args.timeout === "number"
                        ? next.args.timeout
                        : undefined,
                env: next.args.environment as NodeJS.ProcessEnv,
            },
        );
    }
    authorizeUser(text: string): void {
        this.reviewContext.authorize(text);
        this.approvals.lifecycle.invalidateRetries();
    }
    noteCall(event: ToolCallEvent): void {
        this.sources.set(
            event.toolCallId,
            event.parentToolCallId ? "nested" : "model",
        );
        const callIdentity = this.reviewContext.callIdentity(event.toolCallId);
        this.reviewContext.toolCall(
            {
                tool: event.toolName,
                toolCallId: event.toolCallId,
                callIdentity,
                args: JSON.parse(canonicalJson(event.input)),
                ...(event.parentToolCallId
                    ? {
                          parentToolCallId: event.parentToolCallId,
                          parentCallIdentity: this.reviewContext.callIdentity(
                              event.parentToolCallId,
                          ),
                      }
                    : {}),
            },
            callIdentity,
        );
    }
    completeCall(toolCallId: string): void {
        this.sources.delete(toolCallId);
    }
    async close(): Promise<void> {
        this.isReady = false;
        this.stopped.abort();
        this.approvals.reset();
        this.externalTools.clear();
        await this.options.executor.close();
        await this.settingsUpdates;
        await this.approvals.close();
    }
    private ui(
        context: ExtensionContext,
        isOnceOnly = false,
    ): ApprovalUI | undefined {
        if (
            !context.hasUI ||
            (context.mode !== "tui" && context.mode !== "rpc")
        )
            return undefined;
        const scopes = {
            "Allow once": "once",
            "Allow for this session": "session",
            "Save as an allow rule": "persistent",
            Deny: "deny",
        } as const;
        return {
            select: async (action, delta, options) => {
                const text = `Tool: ${action.tool}\nWorking directory: ${action.cwd}\nInput: ${canonicalJson(action.args)}\nRequested scope: ${canonicalJson(delta)}`;
                const selected = await context.ui.select(
                    `Approve this action?\n${text}`,
                    isOnceOnly ? ["Allow once", "Deny"] : Object.keys(scopes),
                    { signal: options.signal, timeout: options.timeoutMs },
                );
                if (selected && selected in scopes)
                    this.reviewContext.confirm({
                        actionDigest: action.digest,
                        action: JSON.parse(canonicalJson(action)),
                        requestedScope: JSON.parse(canonicalJson(delta)),
                        choice: selected,
                        scope: scopes[selected as keyof typeof scopes],
                    });
                return selected
                    ? scopes[selected as keyof typeof scopes]
                    : undefined;
            },
        };
    }
    private async requestAdmission(
        action: GuardAction,
        policyDecision: PolicyDecision,
        context: ExtensionContext,
        signal: AbortSignal,
        trustedAuthorization = "",
        packageApproval?: PackageApproval,
    ) {
        this.reviewContext.refreshInstructions();
        if (context.getSystemPrompt)
            this.reviewContext.mainPrompt(context.getSystemPrompt());
        this.reviewContext.preparedAction(action);
        const executionContext: ReviewExecutionContext = {
            environmentId: "local",
            platform: process.platform,
            architecture: process.arch,
            osIsolation: false,
            permissionProfile: this.policy.profile,
            approvalPolicy: this.options.settings.approvalPolicy,
            approvalsReviewer: this.options.settings.approvalsReviewer,
        };
        let reviewContext =
            policyDecision.kind === "ask"
                ? this.reviewContext.snapshot(
                      this.options.settings.reviewContextChars,
                      canonicalJson({
                          action,
                          delta: policyDecision.delta,
                          executionContext,
                          policyReason: policyDecision.reason,
                      }).length + 1000,
                  )
                : undefined;
        if (reviewContext && trustedAuthorization) {
            const { digest: previousDigest, ...fields } = reviewContext;
            const data = {
                ...fields,
                items: [
                    ...reviewContext.items,
                    {
                        id: "direct-user-bash",
                        source: "user" as const,
                        trust: "authorization" as const,
                        content: safeEvidence(
                            trustedAuthorization,
                            this.reviewRedactor,
                        ),
                    },
                ],
            };
            reviewContext = { ...data, digest: digest(data) };
        }
        const turnIdentity = this.reviewContext.turnIdentity;
        return this.approvals.admit(action, policyDecision, {
            provider:
                this.options.provider ??
                new PiReviewProvider(
                    context,
                    this.options.settings,
                    new LocalInvestigation(
                        this.options.executor,
                        this.policy.profile,
                        action.cwd,
                        this.reviewRedactor,
                    ),
                ),
            ui: this.ui(
                context,
                policyDecision.requiresFreshReview ||
                    policyDecision.requiresUserInput,
            ),
            trustedAuthorization,
            signal,
            reviewContext,
            settings: this.options.settings,
            executionContext,
            packageApproval,
            onReviewStart: () => {
                this.activeReviews.add(action.digest);
                if (context.hasUI)
                    context.ui.setStatus(
                        "auto-review",
                        `Auto-review running (${this.activeReviews.size})`,
                    );
            },
            onReviewResult: (result) => {
                this.activeReviews.delete(action.digest);
                if (turnIdentity !== this.reviewContext.turnIdentity) return;
                if (result) this.reviewContext.assessment(action, result);
                if (!context.hasUI) return;
                const labels = {
                    approved: "approved",
                    denied: "denied",
                    "timed-out": "timed out",
                    aborted: "cancelled",
                    failed: "failed",
                };
                context.ui.setStatus(
                    "auto-review",
                    this.activeReviews.size
                        ? `Auto-review running (${this.activeReviews.size})`
                        : result
                          ? `Auto-review: ${labels[result.status]}`
                          : undefined,
                );
                if (
                    result &&
                    result.status !== "approved" &&
                    result.status !== "aborted"
                )
                    context.ui.notify(
                        `Auto-review ${labels[result.status]}: ${redact("assessment" in result ? result.assessment.rationale : result.reason).slice(0, 1000)}`,
                        "warning",
                    );
            },
            onInterrupt: () => {
                if (context.hasUI)
                    context.ui.notify(
                        "Auto-review stopped this turn after repeated denials.",
                        "warning",
                    );
                context.abort?.();
            },
        });
    }
    private denied(
        admission: Admission,
        retryArguments?: Readonly<Record<string, Json>>,
    ): GuardError {
        if (admission.denialId && retryArguments)
            this.retryArguments.set(admission.denialId, retryArguments);
        const retained = new Set(
            this.approvals.lifecycle.recentDenials.map((item) => item.id),
        );
        for (const id of this.retryArguments.keys())
            if (!retained.has(id)) this.retryArguments.delete(id);
        if (admission.review) {
            const feedback = reviewFeedback(admission.review);
            return new GuardError(
                feedback.code,
                `[${feedback.code}] ${feedback.message}`,
            );
        }
        return new GuardError("PERMISSION_DENIED", admission.reason);
    }
    isExternalTool(name: string): boolean {
        return this.externalTools.get(name)?.isEnabled === true;
    }
    wrapExternalTool<TParameters extends ToolSchema, TDetails, TState>(
        definition: ToolDefinition<TParameters, TDetails, TState>,
        identify: () => ExternalToolIdentity,
    ): ToolDefinition<TParameters, TDetails, TState> {
        if (
            TOOL_NAMES.includes(definition.name as never) ||
            definition.name === "codemode"
        )
            throw new GuardError(
                "RESERVED_TOOL",
                "An external adapter cannot replace guarded local tools",
            );
        const token = randomUUID(),
            execute = definition.execute;
        this.externalTools.set(definition.name, {
            token,
            isEnabled: definition.exposure !== "hidden",
        });
        const schema = JSON.parse(
            JSON.stringify({
                parameters: definition.parameters,
                description: definition.description,
                annotations: definition.annotations ?? {},
                ...(definition.namespace
                    ? { namespace: definition.namespace }
                    : {}),
            }),
        ) as Json;
        return {
            ...definition,
            execute: async (
                toolCallId,
                params,
                callerSignal,
                onUpdate,
                context,
            ) => {
                this.assertReady();
                if (!this.options.settings.isEnabled)
                    return execute.call(
                        definition,
                        toolCallId,
                        params,
                        callerSignal,
                        onUpdate,
                        context,
                    );
                const lifetime = new AbortController();
                const signal = AbortSignal.any([
                    lifetime.signal,
                    this.stopped.signal,
                    this.approvals.lifecycle.signal,
                    ...(callerSignal ? [callerSignal] : []),
                ]);
                signal.throwIfAborted();
                const args = JSON.parse(canonicalJson(params ?? {})) as Record<
                    string,
                    Json
                >;
                const identity = JSON.parse(
                    JSON.stringify(identify()),
                ) as ExternalToolIdentity;
                const identityDigest = digest(identity),
                    cwd = await canonicalPath(context.cwd, context.cwd);
                const action = createAction(
                    {
                        toolCallId,
                        tool: definition.name,
                        args: {
                            arguments: args,
                            externalTool: JSON.parse(JSON.stringify(identity)),
                            schema,
                            ...(identity.connectedAccountEmail
                                ? {
                                      connected_account_email:
                                          identity.connectedAccountEmail,
                                  }
                                : {}),
                        },
                        cwd,
                        source: this.sources.get(toolCallId) ?? "model",
                        sessionId: context.sessionManager.getSessionId(),
                        policyRevision: this.policy.revision,
                    },
                    this.policy.profile,
                );
                const authorizationVersion = this.reviewContext.scopeVersion,
                    turn = this.reviewContext.turnIdentity;
                const checkCurrent = async () => {
                    this.assertReady();
                    signal.throwIfAborted();
                    if (
                        this.externalTools.get(definition.name)?.token !==
                            token ||
                        !this.isExternalTool(definition.name) ||
                        digest(JSON.parse(JSON.stringify(identify()))) !==
                            identityDigest
                    )
                        throw new GuardError(
                            "STALE_EXTERNAL_TOOL",
                            "External registration changed; a fresh action must be reviewed",
                        );
                    if (
                        this.reviewContext.scopeVersion !==
                            authorizationVersion ||
                        this.reviewContext.turnIdentity !== turn ||
                        this.sessionId !== action.sessionId ||
                        this.policy.revision !== action.policyRevision ||
                        (await canonicalPath(context.cwd, context.cwd)) !== cwd
                    )
                        throw new GuardError(
                            "STALE_APPROVAL",
                            "External execution context changed after admission",
                        );
                    signal.throwIfAborted();
                };
                const approve = async (
                    candidate: GuardAction,
                    candidateIdentity: ExternalToolIdentity,
                ) => {
                    await checkCurrent();
                    const admission = await this.requestAdmission(
                        candidate,
                        this.isFullAccessEnabled
                            ? decision(
                                  candidate,
                                  "allow",
                                  "Full Access permits this action",
                              )
                            : externalPolicy(
                                  candidate,
                                  candidateIdentity,
                                  this.options.settings,
                              ),
                        context,
                        signal,
                        "",
                        candidateIdentity.packageApproval,
                    );
                    if (!admission.isAllowed)
                        throw this.denied(admission, args);
                    await checkCurrent();
                };
                try {
                    await approve(action, identity);
                    const result = await externalInvocations.run(
                        {
                            toolCallId,
                            identity,
                            arguments: args,
                            signal,
                            checkCurrent,
                            approveNested: async (
                                nestedIdentity,
                                nestedArgs,
                            ) => {
                                if (
                                    nestedIdentity.server !== identity.server ||
                                    nestedIdentity.registration !==
                                        identity.registration
                                )
                                    return false;
                                const nested = createAction(
                                    {
                                        toolCallId: `${toolCallId}:elicitation:${randomUUID()}`,
                                        tool: definition.name,
                                        args: {
                                            arguments: nestedArgs,
                                            externalTool: JSON.parse(
                                                JSON.stringify(nestedIdentity),
                                            ),
                                            schema,
                                            originatingActionDigest:
                                                action.digest,
                                            ...(nestedIdentity.connectedAccountEmail
                                                ? {
                                                      connected_account_email:
                                                          nestedIdentity.connectedAccountEmail,
                                                  }
                                                : {}),
                                        },
                                        cwd,
                                        source: "nested",
                                        sessionId: action.sessionId,
                                        policyRevision: action.policyRevision,
                                    },
                                    this.policy.profile,
                                );
                                try {
                                    await approve(nested, nestedIdentity);
                                    return true;
                                } catch {
                                    return false;
                                }
                            },
                        },
                        () =>
                            execute.call(
                                definition,
                                toolCallId,
                                args as typeof params,
                                signal,
                                onUpdate,
                                observeToolUserInput(
                                    context,
                                    action,
                                    this.reviewContext,
                                    signal,
                                ),
                            ),
                    );
                    await this.options.audit.record(
                        action,
                        "execution",
                        "settled",
                    );
                    return result;
                } catch (error) {
                    await this.options.audit.record(
                        action,
                        "execution",
                        "failed",
                    );
                    throw error;
                } finally {
                    lifetime.abort();
                    this.completeCall(toolCallId);
                }
            },
        };
    }
    private async admitAndExecute(
        action: GuardAction,
        job: WorkerJob,
        context: ExtensionContext,
        options: ExecutionOptions,
        trustedAuthorization = "",
        retryArguments?: Readonly<Record<string, Json>>,
    ): Promise<Json> {
        this.assertReady();
        const signal = AbortSignal.any([
            this.stopped.signal,
            ...(action.source === "user-bash"
                ? []
                : [this.approvals.lifecycle.signal]),
            ...(options.signal ? [options.signal] : []),
        ]);
        const authorizationVersion = this.reviewContext.scopeVersion;
        const policyDecision = await this.evaluate(action, signal);
        const packageApproval =
            job.kind === "shell" && isPackageCacheEligible(policyDecision)
                ? await skillPackageApproval(job.command, job.cwd).catch(
                      () => undefined,
                  )
                : undefined;
        const admission = await this.requestAdmission(
            action,
            policyDecision,
            context,
            signal,
            trustedAuthorization,
            packageApproval,
        );
        if (!admission.isAllowed) throw this.denied(admission, retryArguments);
        signal.throwIfAborted();
        if (this.reviewContext.scopeVersion !== authorizationVersion)
            throw new GuardError(
                "STALE_AUTHORIZATION",
                "User authorization changed during review; request a fresh review",
            );
        if (
            this.sessionId !== action.sessionId ||
            (await canonicalPath(context.cwd, context.cwd)) !== action.cwd ||
            this.policy.revision !== action.policyRevision
        )
            throw new GuardError(
                "STALE_APPROVAL",
                "Execution context changed after admission",
            );
        const finalDecision = await this.evaluate(action, signal);
        if (finalDecision.kind === "deny")
            throw new GuardError("PERMISSION_DENIED", finalDecision.reason);
        if (digest(finalDecision.delta) !== digest(policyDecision.delta))
            throw new GuardError(
                "STALE_APPROVAL",
                "Resolved permissions changed after admission",
            );
        if (
            digest(finalDecision.authority ?? null) !==
            digest(policyDecision.authority ?? null)
        )
            throw new GuardError(
                "STALE_APPROVAL",
                "Execution authority changed after admission",
            );
        try {
            const result = await this.options.executor.execute(
                job,
                this.policy.profile,
                admission.delta,
                {
                    ...options,
                    signal,
                    authority: admission.authority,
                    timeoutSeconds:
                        options.timeoutSeconds ??
                        this.options.settings.executionTimeoutSeconds,
                },
            );
            await this.options.audit.record(action, "execution", "settled");
            return result;
        } catch (error) {
            await this.options.audit.record(action, "execution", "failed");
            throw error;
        } finally {
            this.completeCall(action.toolCallId);
        }
    }
    wrapTool<
        TParameters extends ToolSchema & {
            properties: Record<string, ToolSchema>;
        },
        TDetails,
        TState,
    >(
        definition: ToolDefinition<TParameters, TDetails, TState>,
        toolOptions?: ReadToolOptions | BashToolOptions,
    ): ToolDefinition<TParameters, TDetails, TState> {
        const tool = definition.name as (typeof TOOL_NAMES)[number];
        if (!TOOL_NAMES.includes(tool))
            throw new GuardError(
                "UNKNOWN_LOCAL_TOOL",
                "Cannot delegate unknown local tool",
            );
        const parameters =
            tool === "bash"
                ? {
                      ...definition.parameters,
                      properties: {
                          ...definition.parameters.properties,
                          sandbox_permissions: {
                              type: "string",
                              enum: ["use_default", "require_escalated"],
                              description:
                                  "Compatibility field: request approval review for this exact command.",
                          },
                          additional_permissions: {
                              type: "object",
                              properties: {
                                  readPaths: {
                                      type: "array",
                                      items: { type: "string" },
                                  },
                                  writePaths: {
                                      type: "array",
                                      items: { type: "string" },
                                  },
                                  domains: {
                                      type: "array",
                                      items: { type: "string" },
                                  },
                              },
                              additionalProperties: false,
                              description:
                                  "Describe the exact additional action scope for approval review.",
                          },
                          justification: {
                              type: "string",
                              description:
                                  "Explain the boundary crossing for review.",
                          },
                      },
                  }
                : definition.parameters;
        return {
            ...definition,
            parameters,
            execute: async (toolCallId, params, signal, onUpdate, context) => {
                this.assertReady();
                if (!this.options.settings.isEnabled)
                    return definition.execute(
                        toolCallId,
                        params,
                        signal,
                        onUpdate,
                        context,
                    );
                const cwd = await canonicalPath(context.cwd, context.cwd);
                if (tool === "bash") {
                    const input = params as Record<string, Json>;
                    const requested = JSON.parse(
                        canonicalJson(
                            Object.fromEntries(
                                [
                                    "sandbox_permissions",
                                    "additional_permissions",
                                    "justification",
                                ]
                                    .filter((key) => input[key] !== undefined)
                                    .map((key) => [key, input[key]]),
                            ),
                        ),
                    ) as Record<string, Json>;
                    const delegate = createBashToolDefinition(cwd, {
                        ...(toolOptions as BashToolOptions),
                        operations: {
                            exec: async (command, finalCwd, options) => {
                                const env = options.env;
                                const shellPath =
                                    (toolOptions as BashToolOptions)
                                        ?.shellPath ?? "/bin/bash";
                                const args = {
                                    command,
                                    shellPath,
                                    ...(options.timeout !== undefined
                                        ? { timeout: options.timeout }
                                        : {}),
                                    environment: reviewEnvironment(env),
                                    redactedEnvironmentVariables:
                                        redactedEnvironmentNames(env),
                                    ...requested,
                                };
                                const resolvedCwd = await canonicalPath(
                                    finalCwd,
                                    finalCwd,
                                );
                                const action = createAction(
                                    {
                                        toolCallId,
                                        tool,
                                        args: JSON.parse(canonicalJson(args)),
                                        cwd: resolvedCwd,
                                        source:
                                            this.sources.get(toolCallId) ??
                                            "model",
                                        sessionId:
                                            context.sessionManager.getSessionId(),
                                        policyRevision: this.policy.revision,
                                    },
                                    this.policy.profile,
                                );
                                return (await this.admitAndExecute(
                                    action,
                                    {
                                        kind: "shell",
                                        command,
                                        shellPath,
                                        cwd: resolvedCwd,
                                    },
                                    { ...context, cwd: finalCwd },
                                    {
                                        signal: options.signal,
                                        timeoutSeconds: options.timeout,
                                        env,
                                        onData: options.onData,
                                    },
                                    "",
                                    JSON.parse(canonicalJson(params)),
                                )) as unknown as { exitCode: number | null };
                            },
                        },
                    });
                    return delegate.execute(
                        toolCallId,
                        params as { command: string; timeout?: number },
                        signal,
                        onUpdate as Parameters<typeof delegate.execute>[3],
                        context,
                    ) as ReturnType<
                        ToolDefinition<TParameters, TDetails, TState>["execute"]
                    >;
                }
                const boundParameters = JSON.parse(
                    canonicalJson(params),
                ) as Record<string, Json>;
                const args = { ...boundParameters };
                const target = await resolveToolPath(
                    typeof args.path === "string" ? args.path : ".",
                    cwd,
                    tool === "read",
                );
                args.path = pathToFileURL(target).href;
                const action = createAction(
                    {
                        toolCallId,
                        tool,
                        args,
                        cwd,
                        source: this.sources.get(toolCallId) ?? "model",
                        sessionId: context.sessionManager.getSessionId(),
                        policyRevision: this.policy.revision,
                    },
                    this.policy.profile,
                );
                const options =
                    tool === "read"
                        ? {
                              ...(toolOptions as ReadToolOptions),
                              ...(context.model?.inputLimits?.images?.resize
                                  ? {
                                        resizeOptions:
                                            context.model.inputLimits.images
                                                .resize,
                                    }
                                  : {}),
                          }
                        : undefined;
                const delegate = definition;
                const execute = () =>
                    this.admitAndExecute(
                        action,
                        {
                            kind: "tool",
                            tool,
                            args: action.args as Record<string, Json>,
                            cwd,
                            toolCallId,
                            ...(options ? { options } : {}),
                        },
                        context,
                        {
                            signal,
                            onUpdate: onUpdate
                                ? (result) => onUpdate(result as never)
                                : undefined,
                            delegate: async (admittedSignal) =>
                                (await delegate.execute(
                                    toolCallId,
                                    boundParameters as typeof params,
                                    admittedSignal,
                                    onUpdate,
                                    context,
                                )) as unknown as Json,
                        },
                        "",
                        JSON.parse(canonicalJson(params)),
                    );
                const result = await (tool === "write" || tool === "edit"
                    ? withApprovalMutationQueue(
                          await canonicalPath(target, cwd),
                          execute,
                      )
                    : execute());
                return result as never;
            },
        };
    }
    userBashOperations(
        context: ExtensionContext,
        trustedCommand?: string,
    ): BashOperations {
        if (!this.options.settings.isEnabled)
            return createLocalBashOperations({
                shellPath: this.options.shellPath,
            });
        const operations: BashOperations = {
            exec: async (command, cwd, options) => {
                const resolvedCwd = await canonicalPath(cwd, cwd);
                const env = options.env;
                const shellPath = this.options.shellPath ?? "/bin/bash";
                const action = createAction(
                    {
                        toolCallId: randomUUID(),
                        tool: "bash",
                        source: "user-bash",
                        args: JSON.parse(
                            canonicalJson({
                                command,
                                shellPath,
                                environment: reviewEnvironment(env),
                                redactedEnvironmentVariables:
                                    redactedEnvironmentNames(env),
                                ...(options.timeout !== undefined
                                    ? { timeout: options.timeout }
                                    : {}),
                            }),
                        ),
                        cwd: resolvedCwd,
                        sessionId: context.sessionManager.getSessionId(),
                        policyRevision: this.policy.revision,
                    },
                    this.policy.profile,
                );
                return (await this.admitAndExecute(
                    action,
                    { kind: "shell", command, shellPath, cwd: resolvedCwd },
                    context,
                    {
                        signal: options.signal,
                        timeoutSeconds: options.timeout,
                        env: options.env,
                        onData: options.onData,
                    },
                    trustedCommand === undefined
                        ? ""
                        : `The user directly requested this shell command: ${trustedCommand}`,
                    { command: trustedCommand ?? command },
                )) as unknown as { exitCode: number | null };
            },
        };
        this.ownedOperations.add(operations);
        return operations;
    }
    isGuardedOperations(operations: BashOperations): boolean {
        return this.ownedOperations.has(operations);
    }
}
