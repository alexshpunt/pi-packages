import type { ToolAnnotations } from "@earendil-works/pi-coding-agent";
import {
    decision,
    type GuardAction,
    immutable,
    type Json,
    type PolicyDecision,
} from "../contracts.js";
import type { PackageApproval } from "../package-approvals.js";
import type { GuardSettings } from "../policy/index.js";

export interface ExternalToolIdentity {
    readonly kind: "mcp" | "extension";
    readonly server: string;
    readonly tool: string;
    readonly registration: string;
    readonly connectorId?: string;
    readonly account?: string;
    readonly connectedAccountEmail?: string;
    readonly approvalMode?: "auto" | "prompt" | "writes" | "approve";
    readonly annotations?: ToolAnnotations;
    readonly requiresUserInput?: boolean;
    readonly isSensitiveAction?: boolean;
    readonly requiresStrictReview?: boolean;
    /** Version and content fingerprint used to reuse an earlier approval of the same tool. */
    readonly packageApproval?: PackageApproval;
}
/** A call to another extension's external tool, as the reviewer sees it. */
export interface ExternalToolCall {
    readonly identity: ExternalToolIdentity;
    /** The registered definition: parameters, description, annotations and namespace. */
    readonly schema: Json;
}
/** Literal ordering of Codex mcp_tool_call.rs requires_mcp_tool_approval. */
export function requiresMcpApproval(
    annotations: ToolAnnotations = {},
    mode: ExternalToolIdentity["approvalMode"] = "auto",
): boolean {
    if (mode === "prompt") return true;
    if (mode === "writes") return annotations.readOnlyHint !== true;
    if (mode === "approve") return false;
    if (annotations.destructiveHint === true) return true;
    if (annotations.readOnlyHint === true) return false;
    return (
        (annotations.destructiveHint ?? true) ||
        (annotations.openWorldHint ?? true)
    );
}
export function externalPolicy(
    action: GuardAction,
    identity: ExternalToolIdentity,
    _settings: GuardSettings,
): PolicyDecision {
    const isFresh =
        identity.requiresStrictReview === true ||
        identity.isSensitiveAction === true ||
        identity.requiresUserInput === true;
    const shouldReview =
        isFresh ||
        requiresMcpApproval(identity.annotations, identity.approvalMode);
    return immutable({
        ...decision(
            action,
            shouldReview ? "ask" : "allow",
            shouldReview
                ? "Review the exact registered external action"
                : "Registered external tool approval policy permits this action",
        ),
        approvalCategory: "mcp_elicitations",
        requiresFreshReview: isFresh,
        requiresUserInput: identity.requiresUserInput === true,
    });
}
