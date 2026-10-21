import { expect } from "vitest";
import { planStream } from "./pi.mjs";

// Adapted to Pi's public stream seam from Codex rust-v0.160.0:
// core/tests/common/responses.rs::mount_sse_sequence. No Rust/HTTP transport
// is copied: exact request counts, ordered replies and downstream tool-output
// assertions are the shared contract. This is deterministic provider evidence.
export async function replayScenario(session, steps) {
    const requests = [],
        results = [],
        failures = [];
    const callIds = steps.flatMap((step, index) =>
        (step.calls ?? []).map(
            (_call, callIndex) => `fixture-${index + 1}-${callIndex}`,
        ),
    );
    const dispose = session.subscribe((event) => {
        if (
            event.type === "tool_execution_end" &&
            callIds.includes(event.toolCallId)
        )
            results.push(event);
    });
    await planStream(
        session,
        steps.map((step) => step.calls ?? []),
    );
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = async (model, context, options) => {
        // Pi can ask its stream adapter to settle an already-cancelled turn.
        // Match a real provider: cancellation must not consume a scripted reply.
        options?.signal?.throwIfAborted();
        const index = requests.length;
        requests.push({
            messages: structuredClone(context.messages),
            signal: options?.signal,
        });
        try {
            expect(
                index < steps.length,
                `Unexpected main-model request ${index + 1}`,
            ).toBeTruthy();
            const previousCalls = steps
                .slice(0, index)
                .reduce((count, step) => count + (step.calls?.length ?? 0), 0);
            expect(
                results.length,
                "Every preceding call must produce a tool result",
            ).toBe(previousCalls);
            for (const result of results) {
                const output = context.messages.find(
                    (message) =>
                        message.role === "toolResult" &&
                        message.toolCallId === result.toolCallId,
                );
                expect(
                    output,
                    `Tool output ${result.toolCallId} must reach the next main-model request`,
                ).toBeTruthy();
                expect(output.isError).toBe(result.isError);
                const text = (content) =>
                    content
                        .filter((item) => item.type === "text")
                        .map((item) => item.text)
                        .join("\n");
                expect(
                    text(output.content),
                    `Tool output ${result.toolCallId} must retain its complete text for the next model request`,
                ).toBe(text(result.result.content));
            }
            await steps[index].inspect?.({
                model,
                context,
                options,
                results,
                requests,
            });
            options?.signal?.throwIfAborted();
            return await stream(model, context, options);
        } catch (error) {
            failures.push(error);
            throw error;
        }
    };
    return {
        requests,
        results,
        dispose,
        assertComplete({ isCancelled = false } = {}) {
            expect(
                failures,
                "Script assertions must not be swallowed as provider failures",
            ).toStrictEqual([]);
            expect(
                requests.length,
                "Every scripted main-model response must be consumed",
            ).toBe(steps.length);
            if (!isCancelled)
                expect(results.length, "Every scripted tool must settle").toBe(
                    callIds.length,
                );
        },
    };
}

export function replayReviews(replies) {
    const requests = [],
        failures = [];
    return {
        requests,
        provider: {
            async complete(request, options) {
                const index = requests.length;
                requests.push(request);
                try {
                    expect(
                        index < replies.length,
                        `Unexpected reviewer request ${index + 1}`,
                    ).toBeTruthy();
                    const reply = replies[index];
                    if (reply instanceof Error) throw reply;
                    const value =
                        typeof reply === "function"
                            ? await reply(request, options)
                            : reply;
                    return typeof value === "string"
                        ? value
                        : JSON.stringify(value);
                } catch (error) {
                    if (error !== replies[index]) failures.push(error);
                    throw error;
                }
            },
        },
        assertComplete() {
            expect(
                failures,
                "Reviewer script assertions must remain visible to the test",
            ).toStrictEqual([]);
            expect(
                requests.length,
                "Every scripted reviewer response must be consumed",
            ).toBe(replies.length);
        },
    };
}
