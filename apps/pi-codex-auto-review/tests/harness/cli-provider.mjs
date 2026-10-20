import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

/** Offline provider loaded by the real CLI, including its independent reviewer request. */
export default function registerFixtureProvider(pi) {
    const fixture = JSON.parse(
        readFileSync(process.env.PI_GUARD_CLI_FIXTURE, "utf8"),
    );
    let mainCalls = 0,
        reviewCalls = 0;
    pi.registerProvider("owned-cli", {
        baseUrl: "http://unused.invalid",
        api: "pi-guard-cli-fixture",
        apiKey: "owned-offline-fixture",
        models: [
            {
                id: "owned-model",
                name: "Owned CLI model",
                reasoning: false,
                input: ["text"],
                contextWindow: 100000,
                maxTokens: 4096,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
        ],
        streamSimple(model, context, options) {
            const isReview =
                context.systemPrompt?.includes("# Outcome Policy") === true ||
                context.messages.some(
                    (message) =>
                        message.role === "system" &&
                        JSON.stringify(message).includes("# Outcome Policy"),
                );
            if (isReview) reviewCalls++;
            else mainCalls++;
            assert.ok(
                mainCalls <= 2 && reviewCalls <= 1,
                "CLI exceeded the finite model plan",
            );
            assert.equal(model.provider, "owned-cli");
            assert.equal(model.id, "owned-model");
            if (isReview) {
                const message = context.messages.find(
                    (message) => message.role === "user",
                );
                const request = JSON.parse(
                    typeof message.content === "string"
                        ? message.content
                        : message.content
                              .filter((block) => block.type === "text")
                              .map((block) => block.text)
                              .join(""),
                );
                assert.equal(request.untrustedAction.tool, "write");
                assert.ok(
                    request.requestedPermissionDelta.writePaths.length > 0,
                );
            }
            appendFileSync(
                fixture.trace,
                `${JSON.stringify({
                    provider: model.provider,
                    model: model.id,
                    isReview,
                    maxTokens: options?.maxTokens,
                })}\n`,
            );
            const content = isReview
                ? [
                      {
                          type: "text",
                          text: '{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"Explicitly owned CLI sentinel"}',
                      },
                  ]
                : mainCalls === 1
                  ? [
                        {
                            type: "toolCall",
                            id: "owned-cli-write",
                            name: "write",
                            arguments: {
                                path: fixture.target,
                                content: "cli-approved-effect",
                            },
                        },
                    ]
                  : [{ type: "text", text: "owned-cli-complete" }];
            const message = {
                role: "assistant",
                api: model.api,
                provider: model.provider,
                model: model.id,
                content,
                usage: {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 2,
                    cost: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        total: 0,
                    },
                },
                stopReason: content[0].type === "toolCall" ? "toolUse" : "stop",
                timestamp: Date.now(),
            };
            const stream = createAssistantMessageEventStream();
            queueMicrotask(() => {
                stream.push({ type: "start", partial: message });
                stream.push({
                    type: "done",
                    reason: message.stopReason,
                    message,
                });
                stream.end(message);
            });
            return stream;
        },
    });
}
