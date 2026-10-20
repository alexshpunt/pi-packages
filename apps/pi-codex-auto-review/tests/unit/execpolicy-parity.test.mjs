import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
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
assert.equal(corpus.reference.revision, CODEX_EXECPOLICY_REVISION);
for (const entry of corpus.cases.filter(
    (entry) => entry.platform !== "posix" || process.platform !== "win32",
)) {
    test(`[rules] original Codex result replay: ${entry.name}`, async () => {
        if (entry.expected.error) {
            await assert.rejects(evaluateRules(entry.sources, entry.commands), {
                code: "INVALID_RULES",
            });
        } else {
            assert.deepEqual(
                await evaluateRules(entry.sources, entry.commands),
                entry.expected.result,
            );
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
        await assert.rejects(pending, { code: "INVALID_RULES" });
        assert.equal(controller.signal.aborted, true);
        assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    } finally {
        clearTimeout(timer);
    }
    assert.equal(
        (
            await evaluateRules(
                [{ name: "next.rules", source: 'prefix_rule(["next"])' }],
                [["next"]],
            )
        ).matches[0][0].decision,
        "allow",
    );
});
test("[rules] bounded evaluation and host access rejection also cover the synchronous API", async () => {
    for (const source of [
        'prefix_rule(["x" * 1000000000])',
        'prefix_rule(["x"]); open("/tmp/host-access")',
        'prefix_rule(["x"]); [].constructor("return process")()',
        'prefix_rule(["x"]); eval("True")',
        'prefix_rule(["x"]); for_value = [str(x) for x in range(1000000000)]',
    ]) {
        await assert.rejects(
            evaluateRules([{ name: "bounded.rules", source }]),
            { code: "INVALID_RULES" },
        );
        assert.throws(() => parseRules(source), { code: "INVALID_RULES" });
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
        await assert.rejects(evaluateRules(sources), { code: "INVALID_RULES" });
    }
    await assert.rejects(evaluateRules([], [[1]]), { code: "INVALID_RULES" });
    await assert.rejects(evaluateRules([], [["\ud800"]]), {
        code: "INVALID_RULES",
    });
    assert.deepEqual(
        (await evaluateRules([{ name: "x", source: "", extra: undefined }]))
            .rules,
        [],
    );
});
