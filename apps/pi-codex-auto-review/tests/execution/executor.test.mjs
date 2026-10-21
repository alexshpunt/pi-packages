import { access, chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { EMPTY_DELTA } from "../../dist/contracts.js";
import { PiExecutor } from "../../dist/tools/executor.js";
import { fixture } from "../harness/fixtures.mjs";
import { shellQuote } from "../harness/shell.mjs";

async function setup(t) {
    const f = await fixture(t),
        executor = new PiExecutor();
    t.onTestFinished(() => executor.close());
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
    expect(await readFile(path, "utf8")).toBe("changed");
    expect(result.content[0].text).toMatch(/changed/);
    expect(f.executor.activeInvocationCount).toBe(0);
    expect(f.executor.qualify).toBe(undefined);
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
    expect(result.exitCode).toBe(7);
    const text = Buffer.concat(output).toString();
    expect(text.includes(f.workspace)).toBeTruthy();
    expect(text.includes("caller-value")).toBeTruthy();
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
    expect(calls).toBe(1);
    expect(result.content[0].text).toBe("original SDK result");
    caller.abort();
    expect(received.aborted).toBe(true);
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
        expect(result.exitCode).toBe(0);
        expect(Buffer.concat(output).toString()).toBe("ready");
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
    const rejected = expect(pending).rejects.toThrow(/aborted/);
    await started;
    caller.abort();
    await rejected;
    await expect(
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
    ).rejects.toThrow(/timeout/);
    await new Promise((resolve) => setTimeout(resolve, 550));
    await expect(access(cancelled)).rejects.toThrow();
    await expect(access(timed)).rejects.toThrow();
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
    const rejected = expect(pending).rejects.toThrow(/aborted/);
    await started;
    await f.executor.close();
    await rejected;
    expect(f.executor.activeInvocationCount).toBe(0);
    await expect(
        f.executor.execute(
            { kind: "shell", command: "printf must-not-run", cwd: f.workspace },
            f.profile,
            EMPTY_DELTA,
        ),
    ).rejects.toThrow();
});
