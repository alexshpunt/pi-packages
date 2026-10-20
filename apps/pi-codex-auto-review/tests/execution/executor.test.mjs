import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { EMPTY_DELTA } from "../../dist/contracts.js";
import { PiExecutor } from "../../dist/tools/executor.js";
import { fixture } from "../harness/fixtures.mjs";
import { shellQuote } from "../harness/shell.mjs";

async function setup(t) {
    const f = await fixture(t),
        executor = new PiExecutor();
    t.after(() => executor.close());
    return { ...f, executor };
}
test("[execution] Pi tools perform write, edit and read using the normal SDK filesystem queue", async (t) => {
    const f = await setup(t),
        path = join(f.workspace, "nested/owned.txt");
    for (const [tool, args] of [
        ["write", { path, content: "original" }],
        [
            "edit",
            { path, edits: [{ oldText: "original", newText: "changed" }] },
        ],
    ])
        await f.executor.execute(
            { kind: "tool", tool, args, cwd: f.workspace, toolCallId: tool },
            f.profile,
            EMPTY_DELTA,
        );
    const result = await f.executor.execute(
        {
            kind: "tool",
            tool: "read",
            args: { path },
            cwd: f.workspace,
            toolCallId: "read",
        },
        f.profile,
        EMPTY_DELTA,
    );
    assert.equal(await readFile(path, "utf8"), "changed");
    assert.match(result.content[0].text, /changed/);
    assert.equal(f.executor.activeInvocationCount, 0);
    assert.equal(f.executor.qualify, undefined);
});
test("[execution] shell cwd, caller environment, output and nonzero status reach Pi unchanged", async (t) => {
    const f = await setup(t),
        output = [];
    const result = await f.executor.execute(
        {
            kind: "shell",
            command: 'pwd; printf "$OWNED_VALUE"; exit 7',
            cwd: f.workspace,
        },
        f.profile,
        EMPTY_DELTA,
        {
            env: { PATH: process.env.PATH, OWNED_VALUE: "caller-value" },
            onData: (chunk) => output.push(chunk),
        },
    );
    assert.equal(result.exitCode, 7);
    const text = Buffer.concat(output).toString();
    assert.ok(text.includes(f.workspace));
    assert.ok(text.includes("caller-value"));
});
test("[execution] the executor uses the supplied SDK delegate once and exposes the linked caller cancellation", async (t) => {
    const f = await setup(t),
        caller = new AbortController();
    let calls = 0,
        received;
    const result = await f.executor.execute(
        {
            kind: "tool",
            tool: "read",
            args: { path: "not-read" },
            cwd: f.workspace,
            toolCallId: "delegate",
        },
        f.profile,
        EMPTY_DELTA,
        {
            signal: caller.signal,
            delegate: async (signal) => {
                calls++;
                received = signal;
                return {
                    content: [{ type: "text", text: "original SDK result" }],
                };
            },
        },
    );
    assert.equal(calls, 1);
    assert.equal(result.content[0].text, "original SDK result");
    caller.abort();
    assert.equal(received.aborted, true);
});
test("[execution] starting a shell does not enumerate an unrelated unlistable directory", async (t) => {
    const f = await setup(t),
        opaque = join(f.workspace, "unrelated");
    await mkdir(opaque);
    await chmod(opaque, 0o111);
    try {
        const output = [];
        const result = await f.executor.execute(
            { kind: "shell", command: "printf ready", cwd: f.workspace },
            f.profile,
            EMPTY_DELTA,
            { onData: (chunk) => output.push(chunk) },
        );
        assert.equal(result.exitCode, 0);
        assert.equal(Buffer.concat(output).toString(), "ready");
    } finally {
        await chmod(opaque, 0o700);
    }
});
test("[cancellation] SDK caller cancellation and a seconds deadline prevent delayed shell writes", async (t) => {
    const f = await setup(t),
        cancelled = join(f.workspace, "cancelled.txt"),
        timed = join(f.workspace, "timed.txt"),
        caller = new AbortController();
    let ready;
    const started = new Promise((resolve) => (ready = resolve));
    const pending = f.executor.execute(
        {
            kind: "shell",
            command: `printf ready; sleep 0.5; printf late > ${shellQuote(cancelled)}`,
            cwd: f.workspace,
        },
        f.profile,
        EMPTY_DELTA,
        { signal: caller.signal, onData: () => ready() },
    );
    const rejected = assert.rejects(pending, /aborted/);
    await started;
    caller.abort();
    await rejected;
    await assert.rejects(
        f.executor.execute(
            {
                kind: "shell",
                command: `sleep 0.5; printf late > ${shellQuote(timed)}`,
                cwd: f.workspace,
            },
            f.profile,
            EMPTY_DELTA,
            { timeoutSeconds: 0.1 },
        ),
        /timeout/,
    );
    await new Promise((resolve) => setTimeout(resolve, 550));
    await assert.rejects(access(cancelled));
    await assert.rejects(access(timed));
});
test("[cancellation] close settles a running SDK shell and rejects subsequent execution", async (t) => {
    const f = await setup(t);
    let ready;
    const started = new Promise((resolve) => (ready = resolve));
    const pending = f.executor.execute(
        { kind: "shell", command: "printf ready; sleep 2", cwd: f.workspace },
        f.profile,
        EMPTY_DELTA,
        { onData: () => ready() },
    );
    const rejected = assert.rejects(pending, /aborted/);
    await started;
    await f.executor.close();
    await rejected;
    assert.equal(f.executor.activeInvocationCount, 0);
    await assert.rejects(
        f.executor.execute(
            { kind: "shell", command: "printf must-not-run", cwd: f.workspace },
            f.profile,
            EMPTY_DELTA,
        ),
    );
});
