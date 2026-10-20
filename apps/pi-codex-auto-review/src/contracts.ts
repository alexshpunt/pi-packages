import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { ReadToolOptions } from "@earendil-works/pi-coding-agent";
import { isDomainPattern, normalizeHost } from "./policy/domains.js";

export type Json =
    | null
    | boolean
    | number
    | string
    | Json[]
    | { [key: string]: Json };
export type DecisionKind = "allow" | "ask" | "deny";
export type ActionSource = "model" | "nested" | "user-bash" | "extension";
export type EvidenceStatus =
    | "pass"
    | "fail"
    | "environment-blocked"
    | "not-run";
export type ToolName =
    | "bash"
    | "read"
    | "edit"
    | "write"
    | "grep"
    | "find"
    | "ls";
export const TOOL_NAMES: readonly ToolName[] = Object.freeze([
    "bash",
    "read",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
]);

export interface PermissionProfile {
    readonly mode: "read-only" | "workspace-write";
    readonly readRoots: readonly string[];
    readonly writeRoots: readonly string[];
    readonly denyRead: readonly string[];
    readonly denyWrite: readonly string[];
    readonly allowedDomains: readonly string[];
    readonly deniedDomains: readonly string[];
    /** Base sandbox metadata protection; unlike denyWrite, eligible exact actions may request review. */
    readonly readOnlyPaths?: readonly string[];
}
export interface PermissionDelta {
    readonly readPaths: readonly string[];
    readonly writePaths: readonly string[];
    readonly domains: readonly string[];
}
export const EMPTY_DELTA: PermissionDelta = Object.freeze({
    readPaths: Object.freeze([]),
    writePaths: Object.freeze([]),
    domains: Object.freeze([]),
});

export interface GuardAction {
    readonly schemaVersion: 1;
    readonly toolCallId: string;
    readonly tool: string;
    readonly source: ActionSource;
    readonly args: Readonly<Record<string, Json>>;
    readonly cwd: string;
    readonly sessionId: string;
    readonly policyRevision: string;
    readonly permissionDigest: string;
    readonly digest: string;
}
export interface PolicyDecision {
    readonly kind: DecisionKind;
    readonly reason: string;
    readonly actionDigest: string;
    readonly delta: PermissionDelta;
    readonly isHardDeny: boolean;
    readonly approvalCategory?: "sandbox" | "rules" | "mcp_elicitations";
    readonly requiresFreshReview?: boolean;
    readonly requiresUserInput?: boolean;
    readonly authority?: ExecutionAuthority;
}
export type ApprovalPolicy =
    | "on-request"
    | "never"
    | {
          readonly sandbox: boolean;
          readonly rules: boolean;
          readonly mcp_elicitations?: boolean;
      };
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type UserAuthorization = "unknown" | "low" | "medium" | "high";
/** Field names intentionally match the pinned Codex assessment wire format. */
export interface ReviewAssessment {
    readonly risk_level: RiskLevel;
    readonly user_authorization: UserAuthorization;
    readonly outcome: "allow" | "deny";
    readonly rationale: string;
}
export type ReviewTerminalState =
    | "approved"
    | "denied"
    | "timed-out"
    | "aborted"
    | "failed";
export interface ReviewContextItem {
    readonly id: string;
    readonly source:
        | "user"
        | "developer"
        | "agents"
        | "user-confirmation"
        | "assistant"
        | "tool-call"
        | "tool-result";
    readonly trust: "authorization" | "evidence";
    readonly content: Json;
    readonly isTruncated?: boolean;
}
export interface ReviewContext {
    readonly sessionId: string;
    readonly contextId: string;
    readonly turnId: string;
    readonly items: readonly ReviewContextItem[];
    readonly digest: string;
}
export interface ReviewBinding {
    readonly actionDigest: string;
    readonly contextDigest: string;
    readonly policyDigest: string;
}
export type ReviewResult = ReviewBinding &
    (
        | {
              readonly status: "approved" | "denied";
              readonly assessment: ReviewAssessment;
          }
        | {
              readonly status: "timed-out" | "aborted" | "failed";
              readonly failure:
                  | "timeout"
                  | "cancelled"
                  | "provider"
                  | "invalid-output"
                  | "investigation"
                  | "context";
              readonly reason: string;
          }
    );
export type ExecutionAuthority =
    | {
          readonly kind: "sandbox" | "scoped-permissions";
          readonly actionDigest: string;
      }
    | {
          readonly kind: "command-rule";
          readonly actionDigest: string;
          readonly ruleDigest: string;
      }
    | { readonly kind: "reviewed-command"; readonly actionDigest: string };
export interface RetryAuthorization {
    readonly id: string;
    readonly denialId: string;
    readonly actionIdentity: string;
    readonly sessionId: string;
    readonly contextId: string;
}
export interface RecentDenial {
    readonly id: string;
    readonly action: GuardAction;
    readonly contextId: string;
    readonly assessment: ReviewAssessment;
}
export interface Grant {
    readonly id: string;
    readonly scope: "once" | "session" | "persistent";
    readonly actionDigest: string;
    readonly ruleDigest: string;
    readonly sessionId: string;
    readonly policyRevision: string;
    readonly permissionDigest: string;
    readonly delta: PermissionDelta;
}
export interface ToolResult {
    content: (
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
    )[];
    details?: unknown;
    structuredContent?: Json;
    isError?: boolean;
}
export interface ExecutionOptions {
    readonly signal?: AbortSignal;
    /** Pi BashOperations timeout is in seconds. Review and UI deadlines use milliseconds. */
    readonly timeoutSeconds?: number;
    readonly env?: NodeJS.ProcessEnv;
    readonly onData?: (data: Buffer) => void;
    readonly onUpdate?: (result: ToolResult) => void;
    /** Execute the original Pi definition after admission, in the same process. */
    readonly delegate?: (signal: AbortSignal) => Promise<Json>;
    readonly authority?: ExecutionAuthority;
    readonly onNetworkRequest?: (
        request: NetworkApprovalRequest,
        signal: AbortSignal,
    ) => Promise<boolean>;
}
export interface NetworkApprovalRequest {
    readonly host: string;
    readonly port?: number;
}
export type WorkerJob =
    | {
          kind: "shell";
          command: string;
          cwd: string;
          shellPath?: string;
          timeoutSeconds?: number;
          env?: NodeJS.ProcessEnv;
      }
    | {
          kind: "tool";
          tool: ToolName;
          args: Record<string, Json>;
          cwd: string;
          toolCallId: string;
          options?: Omit<ReadToolOptions, "operations">;
      }
    | {
          kind: "file";
          operation: "read" | "write" | "mkdir" | "access" | "stat" | "list";
          path: string;
          content?: string;
          cwd: string;
      };
export type WorkerFrame =
    | { schemaVersion: 1; type: "data"; data: string }
    | { schemaVersion: 1; type: "update"; result: ToolResult }
    | { schemaVersion: 1; type: "result"; result: Json }
    | { schemaVersion: 1; type: "error"; code: string; message: string };
/** Only the unsandboxed broker's private IPC channel can send this control frame. */
export interface BrokerControlFrame {
    readonly schemaVersion: 1;
    readonly type: "workload-started";
    readonly processGroupId: number;
}
/** Private controller/broker IPC only. Workload stdout must still reject these frame types. */
export interface BrokerNetworkRequest {
    readonly schemaVersion: 1;
    readonly type: "network-request";
    readonly requestId: string;
    readonly destination: NetworkApprovalRequest;
}
export interface TestEvidence {
    readonly schemaVersion?: 1 | 2;
    readonly runId?: string;
    readonly artifactPath?: string;
    readonly provenance?: "executed" | "preserved-legacy" | "synthetic";
    readonly startedAt?: string;
    readonly recordedAt?: string;
    readonly provider?: {
        readonly package: string;
        readonly version: string;
        readonly id: string;
        readonly model: string;
    };
    readonly imageDigest?: string;
    readonly pluginArtifactDigest?: string;
    readonly suite: string;
    readonly status: EvidenceStatus;
    readonly command: string;
    readonly testFiles: readonly string[];
    readonly coveredBehavior: readonly string[];
    readonly tests: readonly {
        name: string;
        status: EvidenceStatus;
        isSkipped?: boolean;
    }[];
    readonly platform: string;
    readonly sourceDigest: string;
    readonly contractDigest: string;
    readonly runtimeVersions: Readonly<Record<string, string>>;
    readonly evidenceKind:
        | "unit-doubles"
        | "simulated-provider-ui"
        | "native-os"
        | "workflow";
    readonly nativeControls?: readonly {
        kind: "allow" | "deny";
        effect: string;
        isObserved: boolean;
        platform: string;
    }[];
    readonly blockedReasons: readonly string[];
}

export class GuardError extends Error {
    constructor(
        readonly code: string,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = "GuardError";
    }
}

export function canonicalJson(value: unknown): string {
    if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean"
    )
        return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value))
        return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (
        typeof value === "object" &&
        value !== null &&
        Object.getPrototypeOf(value) === Object.prototype
    ) {
        return `{${Object.keys(value)
            .sort()
            .map(
                (key) =>
                    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
            )
            .join(",")}}`;
    }
    throw new GuardError("INVALID_JSON", "Expected finite JSON data");
}
export function digest(value: unknown): string {
    return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
export function immutable<T>(value: T): T {
    if (value && typeof value === "object") {
        for (const item of Object.values(value)) immutable(item);
        Object.freeze(value);
    }
    return value;
}
export function createProfile(input: PermissionProfile): PermissionProfile {
    if (!["read-only", "workspace-write"].includes(input.mode))
        throw new GuardError("INVALID_PROFILE", "Unknown permission mode");
    for (const key of [
        "readRoots",
        "writeRoots",
        "denyRead",
        "denyWrite",
    ] as const) {
        if (
            !Array.isArray(input[key]) ||
            input[key].some(
                (p) =>
                    typeof p !== "string" || !isAbsolute(p) || p.includes("\0"),
            )
        )
            throw new GuardError("INVALID_PROFILE", `Invalid ${key}`);
    }
    if (
        input.readOnlyPaths !== undefined &&
        (!Array.isArray(input.readOnlyPaths) ||
            input.readOnlyPaths.some(
                (path) =>
                    typeof path !== "string" ||
                    !isAbsolute(path) ||
                    path.includes("\0"),
            ))
    )
        throw new GuardError("INVALID_PROFILE", "Invalid readOnlyPaths");
    if (input.mode === "read-only" && input.writeRoots.length)
        throw new GuardError(
            "INVALID_PROFILE",
            "Read-only profiles cannot contain write roots",
        );
    for (const key of ["allowedDomains", "deniedDomains"] as const) {
        if (
            !Array.isArray(input[key]) ||
            input[key].some((p) => !isDomainPattern(p))
        )
            throw new GuardError("INVALID_PROFILE", `Invalid ${key}`);
    }
    return immutable(
        JSON.parse(
            canonicalJson({
                ...input,
                allowedDomains: input.allowedDomains.map(normalizeHost),
                deniedDomains: input.deniedDomains.map(normalizeHost),
            }),
        ) as PermissionProfile,
    );
}
export function createAction(
    input: Omit<GuardAction, "schemaVersion" | "digest" | "permissionDigest">,
    profile: PermissionProfile,
): GuardAction {
    for (const key of [
        "toolCallId",
        "tool",
        "cwd",
        "sessionId",
        "policyRevision",
    ] as const) {
        if (
            typeof input[key] !== "string" ||
            !input[key] ||
            input[key].includes("\0")
        )
            throw new GuardError("INVALID_ACTION", `Invalid ${key}`);
    }
    if (!["model", "nested", "user-bash", "extension"].includes(input.source))
        throw new GuardError("INVALID_ACTION", "Invalid action source");
    if (
        !input.args ||
        Array.isArray(input.args) ||
        typeof input.args !== "object"
    )
        throw new GuardError("INVALID_ACTION", "Arguments must be an object");
    const fields = JSON.parse(
        canonicalJson({
            ...input,
            cwd: resolve(input.cwd),
            schemaVersion: 1,
            permissionDigest: digest(profile),
        }),
    );
    return immutable({ ...fields, digest: digest(fields) });
}
/** Reusable grants still bind exact inputs/cwd/source/profile, but not a previous logical call id. */
export function ruleDigest(action: GuardAction): string {
    const {
        digest: ignoredDigest,
        toolCallId: ignoredId,
        sessionId: ignoredSession,
        ...fields
    } = action;
    return digest(fields);
}
/** A retry gets a new invocation ID, but cannot change session, semantics or context. */
export function retryIdentity(action: GuardAction, contextId: string): string {
    // A runtime destination belongs to the same semantic command even though its new
    // invocation necessarily has a different origin digest. Destination/port stay bound.
    const { originatingActionDigest: ignoredOrigin, ...networkArgs } =
        action.args;
    const semantic =
        action.args.networkDestination && typeof ignoredOrigin === "string"
            ? { ...action, args: networkArgs }
            : action;
    return digest({
        action: ruleDigest(semantic),
        sessionId: action.sessionId,
        contextId,
    });
}
export function approvalEligible(
    policy: ApprovalPolicy,
    category: "sandbox" | "rules" | "mcp_elicitations",
): boolean {
    return (
        policy === "on-request" ||
        (typeof policy === "object" && policy[category] === true)
    );
}
export function decision(
    action: GuardAction,
    kind: DecisionKind,
    reason: string,
    delta: PermissionDelta = EMPTY_DELTA,
    isHardDeny = false,
): PolicyDecision {
    if (
        !["allow", "ask", "deny"].includes(kind) ||
        (isHardDeny && kind !== "deny")
    )
        throw new GuardError("INVALID_DECISION", "Invalid decision");
    return immutable({
        kind,
        reason,
        actionDigest: action.digest,
        delta: JSON.parse(canonicalJson(delta)),
        isHardDeny,
    });
}
export function validateWorkerFrame(value: unknown): WorkerFrame {
    const frame = value as WorkerFrame;
    if (
        frame?.schemaVersion !== 1 ||
        !["data", "update", "result", "error"].includes(frame.type)
    )
        throw new GuardError("INVALID_IPC", "Invalid worker frame");
    canonicalJson(value);
    if (frame.type === "data" && typeof frame.data !== "string")
        throw new GuardError("INVALID_IPC", "Invalid data frame");
    if (
        frame.type === "error" &&
        (typeof frame.code !== "string" || typeof frame.message !== "string")
    )
        throw new GuardError("INVALID_IPC", "Invalid error frame");
    if (frame.type === "result" && !Object.hasOwn(frame, "result"))
        throw new GuardError("INVALID_IPC", "Missing worker result");
    if (
        frame.type === "update" &&
        (!frame.result || !Array.isArray(frame.result.content))
    )
        throw new GuardError("INVALID_IPC", "Invalid update");
    return frame;
}
