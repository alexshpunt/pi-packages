import { expect, test } from "vitest";
import {
    approvalEligible,
    createAction,
    createProfile,
} from "../../dist/contracts.js";
import { validateSettings } from "../../dist/policy/index.js";
import {
    externalPolicy,
    requiresMcpApproval,
} from "../../dist/tools/external.js";

test("[external-policy] Codex MCP annotation precedence and four approval modes", () => {
    for (const [annotations, expected] of [
        [{}, true],
        [{ readOnlyHint: true }, false],
        [{ readOnlyHint: true, destructiveHint: true }, true],
        [{ destructiveHint: false }, true],
        [{ destructiveHint: false, openWorldHint: false }, false],
        [{ readOnlyHint: false, openWorldHint: false }, true],
    ]) {
        expect(
            requiresMcpApproval(annotations),
            JSON.stringify(annotations),
        ).toBe(expected);
        expect(requiresMcpApproval(annotations, "prompt")).toBe(true);
        expect(requiresMcpApproval(annotations, "approve")).toBe(false);
        expect(requiresMcpApproval(annotations, "writes")).toBe(
            annotations.readOnlyHint !== true,
        );
    }
    const action = createAction(
        {
            tool: "mcp__owned__read",
            toolCallId: "owned",
            args: {},
            source: "model",
            cwd: process.cwd(),
            sessionId: "s",
            policyRevision: "p",
        },
        createProfile({
            mode: "read-only",
            readRoots: [process.cwd()],
            writeRoots: [],
            denyRead: [],
            denyWrite: [],
            allowedDomains: [],
            deniedDomains: [],
        }),
    );
    const identity = {
        kind: "mcp",
        server: "owned",
        tool: "read",
        registration: "r",
        annotations: { readOnlyHint: true },
    };
    expect(externalPolicy(action, identity, validateSettings({})).kind).toBe(
        "allow",
    );
    expect(
        externalPolicy(
            action,
            { ...identity, requiresStrictReview: true },
            validateSettings({}),
        ).requiresFreshReview,
    ).toBe(true);
    expect(
        externalPolicy(
            action,
            { ...identity, approvalMode: "approve" },
            validateSettings({}),
        ).kind,
    ).toBe("allow");
    expect(
        externalPolicy(
            action,
            identity,
            validateSettings({ approvalsReviewer: "user" }),
        ).kind,
    ).toBe("allow");
    expect(
        externalPolicy(
            action,
            { ...identity, requiresUserInput: true },
            validateSettings({}),
        ).requiresUserInput,
    ).toBe(true);
    const repl = {
        ...identity,
        server: "node_repl",
        tool: "js",
        annotations: { destructiveHint: true },
        approvalMode: "prompt",
    };
    expect(
        externalPolicy(
            action,
            repl,
            validateSettings({ approvalsReviewer: "user" }),
        ).kind,
    ).toBe("ask");
    expect(
        externalPolicy(
            action,
            { ...repl, isSensitiveAction: true },
            validateSettings({ approvalsReviewer: "user" }),
        ).kind,
    ).toBe("ask");
    expect(
        approvalEligible({ sandbox: true, rules: true }, "mcp_elicitations"),
    ).toBe(false);
    expect(
        approvalEligible(
            { sandbox: false, rules: false, mcp_elicitations: true },
            "mcp_elicitations",
        ),
    ).toBe(true);
});
