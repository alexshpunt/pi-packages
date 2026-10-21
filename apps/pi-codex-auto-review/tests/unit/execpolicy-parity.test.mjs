import { getEventListeners } from "node:events";
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import {
    CODEX_EXECPOLICY_REVISION,
    evaluateRules,
    parseRules,
} from "../../dist/policy/rules.js";

const corpus = JSON.parse(
    await readFile(
        new URL("../fixtures/execpolicy-reference.json", import.meta.url),
        "utf8",
    ),
);
expect(corpus.reference.revision).toBe(CODEX_EXECPOLICY_REVISION);
for (const entry of corpus.cases.filter(
    (entry) => entry.platform !== "posix" || process.platform !== "win32",
)) {
    test(`[rules] original Codex result replay: ${entry.name}`, async () => {
        if (entry.expected.error) {
            await expect(
                evaluateRules(entry.sources, entry.commands),
            ).rejects.toThrow(
                expect.objectContaining({
                    code: "INVALID_RULES",
                }),
            );
        } else {
            expect(
                await evaluateRules(entry.sources, entry.commands),
            ).toStrictEqual(entry.expected.result);
        }
    });
}
test("[rules] pending cancellation releases its listener and leaves the host responsive", async () => {
    const controller = new AbortController();
    const pending = evaluateRules(
        [
            {
                name: "busy.rules",
                source: 'values = []\nfor i in range(100000):\n    values.append(str(i))\nprefix_rule(["probe", values])',
            },
        ],
        [],
        controller.signal,
    );
    const timer = setTimeout(
        () => controller.abort(new Error("Owned cancellation")),
        5,
    );
    try {
        await expect(pending).rejects.toThrow(
            expect.objectContaining({ code: "INVALID_RULES" }),
        );
        expect(controller.signal.aborted).toBe(true);
        expect(getEventListeners(controller.signal, "abort").length).toBe(0);
    } finally {
        clearTimeout(timer);
    }
    expect(
        (
            await evaluateRules(
                [{ name: "next.rules", source: 'prefix_rule(["next"])' }],
                [["next"]],
            )
        ).matches[0][0].decision,
    ).toBe("allow");
});
test("[rules] bounded evaluation and host access rejection also cover the synchronous API", async () => {
    for (const source of [
        'prefix_rule(["x" * 1000000000])',
        'prefix_rule(["x"]); open("/tmp/host-access")',
        'prefix_rule(["x"]); [].constructor("return process")()',
        'prefix_rule(["x"]); eval("True")',
        'prefix_rule(["x"]); for_value = [str(x) for x in range(1000000000)]',
    ]) {
        await expect(
            evaluateRules([{ name: "bounded.rules", source }]),
        ).rejects.toThrow(expect.objectContaining({ code: "INVALID_RULES" }));
        expect(() => parseRules(source)).toThrow(
            expect.objectContaining({ code: "INVALID_RULES" }),
        );
    }
});
test("[rules] request validation keeps the original strict JSON boundary", async () => {
    for (const sources of [
        null,
        [null],
        [{ name: "x", source: "", extra: true }],
        [{ name: "x", source: 1 }],
        [{ name: "\ud800", source: "" }],
        [{ name: "x", source: "\ud800" }],
    ]) {
        await expect(evaluateRules(sources)).rejects.toThrow(
            expect.objectContaining({ code: "INVALID_RULES" }),
        );
    }
    await expect(evaluateRules([], [[1]])).rejects.toThrow(
        expect.objectContaining({ code: "INVALID_RULES" }),
    );
    await expect(evaluateRules([], [["\ud800"]])).rejects.toThrow(
        expect.objectContaining({
            code: "INVALID_RULES",
        }),
    );
    expect(
        (await evaluateRules([{ name: "x", source: "", extra: undefined }]))
            .rules,
    ).toStrictEqual([]);
});
