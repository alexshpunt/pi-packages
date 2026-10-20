import assert from "node:assert/strict";
import test from "node:test";
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
        assert.equal(
            requiresMcpApproval(annotations),
            expected,
            JSON.stringify(annotations),
        );
        assert.equal(requiresMcpApproval(annotations, "prompt"), true);
        assert.equal(requiresMcpApproval(annotations, "approve"), false);
        assert.equal(
            requiresMcpApproval(annotations, "writes"),
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
    assert.equal(
        externalPolicy(action, identity, validateSettings({})).kind,
        "allow",
    );
    assert.equal(
        externalPolicy(
            action,
            { ...identity, requiresStrictReview: true },
            validateSettings({}),
        ).requiresFreshReview,
        true,
    );
    assert.equal(
        externalPolicy(
            action,
            { ...identity, approvalMode: "approve" },
            validateSettings({}),
        ).kind,
        "allow",
    );
    assert.equal(
        externalPolicy(
            action,
            identity,
            validateSettings({ approvalsReviewer: "user" }),
        ).kind,
        "allow",
    );
    assert.equal(
        externalPolicy(
            action,
            { ...identity, requiresUserInput: true },
            validateSettings({}),
        ).requiresUserInput,
        true,
    );
    const repl = {
        ...identity,
        server: "node_repl",
        tool: "js",
        annotations: { destructiveHint: true },
        approvalMode: "prompt",
    };
    assert.equal(
        externalPolicy(
            action,
            repl,
            validateSettings({ approvalsReviewer: "user" }),
        ).kind,
        "ask",
    );
    assert.equal(
        externalPolicy(
            action,
            { ...repl, isSensitiveAction: true },
            validateSettings({ approvalsReviewer: "user" }),
        ).kind,
        "ask",
    );
    assert.equal(
        approvalEligible({ sandbox: true, rules: true }, "mcp_elicitations"),
        false,
    );
    assert.equal(
        approvalEligible(
            { sandbox: false, rules: false, mcp_elicitations: true },
            "mcp_elicitations",
        ),
        true,
    );
});
