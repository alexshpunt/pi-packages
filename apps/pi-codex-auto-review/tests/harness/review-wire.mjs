import assert from "node:assert/strict";
import { digest } from "../../dist/contracts.js";

const expected = [],
    transmitted = [];
const text = (content) =>
    typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("")
          : "";
function conversation(messages) {
    return messages
        .filter((message) => !["system", "developer"].includes(message.role))
        .map((message) => {
            const calls =
                message.tool_calls?.map((call) => ({
                    id: call.id,
                    name: call.function.name,
                    arguments:
                        typeof call.function.arguments === "string"
                            ? JSON.parse(call.function.arguments)
                            : call.function.arguments,
                })) ??
                (Array.isArray(message.content)
                    ? message.content
                          .filter((part) => part.type === "toolCall")
                          .map((call) => ({
                              id: call.id,
                              name: call.name,
                              arguments: call.arguments,
                          }))
                    : []);
            return {
                role: message.role === "toolResult" ? "tool" : message.role,
                text: text(message.content),
                ...(calls.length ? { calls } : {}),
                ...(["tool", "toolResult"].includes(message.role)
                    ? { toolCallId: message.toolCallId ?? message.tool_call_id }
                    : {}),
            };
        });
}

export function reviewInputIdentity(systemPrompt, data, tools, messages) {
    const packet = JSON.parse(data),
        { digest: actionDigest, ...action } = packet.untrustedAction,
        { digest: contextDigest, ...context } = packet.context;
    assert.equal(
        actionDigest,
        digest(action),
        "The exact action changed before transport",
    );
    assert.equal(
        contextDigest,
        digest(context),
        "The retained context changed before transport",
    );
    assert.equal(packet.executionContext?.osIsolation, false);
    assert.equal(
        packet.untrustedAction.permissionDigest,
        digest(packet.executionContext.permissionProfile),
    );
    assert.ok(
        packet.context.items.some(
            (item) => item.source === "user" && item.trust === "authorization",
        ),
    );
    assert.ok(
        ["sandbox", "rules", "mcp_elicitations"].includes(
            packet.approvalRequest?.category,
        ),
    );
    assert.deepEqual(
        tools.map((tool) => tool.function?.name ?? tool.name).sort(),
        ["inspect_directory", "inspect_file"],
    );
    const declarations = tools.map((tool) => {
        const fn = tool.function ?? tool;
        return {
            name: fn.name,
            description: fn.description,
            parameters: fn.parameters,
        };
    });
    return {
        inputDigest: digest(packet),
        policyDigest: digest(systemPrompt),
        conversationDigest: digest(conversation(messages)),
        toolsDigest: digest(declarations),
    };
}

export function expectReviewInput(context) {
    const system =
        context.systemPrompt ??
        context.messages
            .filter((message) => ["system", "developer"].includes(message.role))
            .map((message) => text(message.content))
            .join("\n");
    if (!system.includes("# Outcome Policy")) return;
    const identity = reviewInputIdentity(
        system,
        text(
            context.messages.find((message) => message.role === "user")
                ?.content,
        ),
        context.tools ?? [],
        context.messages,
    );
    expected.push(identity);
    return identity;
}

/** Inspect copies of outbound JSON only; do not change requests, responses or headers. */
export async function observeReviewFetch(input, init) {
    const body =
        typeof init?.body === "string"
            ? init.body
            : input instanceof Request
              ? await input.clone().text()
              : undefined;
    if (!body) return;
    let payload;
    try {
        payload = JSON.parse(body);
    } catch {
        return;
    }
    if (!Array.isArray(payload.messages)) return;
    const system = payload.messages
        .filter((message) => ["system", "developer"].includes(message.role))
        .map((message) => text(message.content))
        .join("\n");
    if (!system.includes("# Outcome Policy")) return;
    const identity = reviewInputIdentity(
        system,
        text(
            payload.messages.find((message) => message.role === "user")
                ?.content,
        ),
        payload.tools ?? [],
        payload.messages,
    );
    transmitted.push(identity);
    return identity;
}

export function reviewWireEvidence() {
    assert.ok(expected.length > 0, "No actual reviewer inputs were observed");
    assert.deepEqual(
        transmitted,
        expected,
        "Provider transport changed, omitted or duplicated a reviewer input",
    );
    return {
        status: "pass",
        expected: [...expected],
        transmitted: [...transmitted],
    };
}
