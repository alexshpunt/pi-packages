import { getEventListeners } from "node:events";
import { expect, test, vi } from "vitest";
import { externalInvocations } from "../../dist/tools/external.js";
import { FixtureMcpTransport } from "../harness/mcp.mjs";

const capture = vi.hoisted(() => ({}));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
    ...await original(),
    createMcpExtension: (options) => {
        capture.options = options;
        return () => {};
    },
}));
const { createGuardedMcpExtension } = await import("../../dist/tools/mcp.js");

async function setup(enabled = true) {
    const base = new FixtureMcpTransport([], async () => ({}));
    const sent = [];
    base.send = vi.fn(async (message, options) => { sent.push({ message, options }); });
    await createGuardedMcpExtension("/unused", () => ({ options: { settings: { isEnabled: enabled } } }), { createTransport: () => base });
    const transport = capture.options.createTransport({ name: "owned", source: "fixture", config: { command: "unused" } }, "/unused");
    const received = [];
    transport.onMessage((message) => received.push(message));
    const invocation = {
        identity: { server: "owned", tool: "probe" },
        arguments: { original: true },
        signal: new AbortController().signal,
        checkCurrent: vi.fn(async () => {}),
        approveNested: vi.fn(async () => true),
    };
    return { base, transport, sent, received, invocation };
}

for (const enabled of [true, false]) {
    test(`[mcp-transport] forwards all send options including Off=${!enabled}`, async () => {
        const f = await setup(enabled);
        const options = { signal: new AbortController().signal };
        for (const method of ["initialize", "tools/list", "tools/call", "notifications/initialized"]) {
            await externalInvocations.run(f.invocation, () => f.transport.send({ jsonrpc: "2.0", id: method, method, params: { name: "probe" } }, options));
            expect(f.sent.at(-1).options).toBe(options);
        }
        await f.transport.close();
        expect(getEventListeners(options.signal, "abort")).toHaveLength(0);
    });
}

for (const end of ["abort", "send-failure", "notification", "response", "close"]) {
    test(`[mcp-transport] releases request tracking and nested approval authority after ${end}`, async () => {
        const f = await setup();
        const caller = new AbortController();
        if (end === "send-failure") f.base.send.mockImplementationOnce(async (message, options) => {
            f.sent.push({ message, options });
            throw new Error("failed transport");
        });
        const send = externalInvocations.run(f.invocation, () => f.transport.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "probe" } }, { signal: caller.signal }));
        if (end === "send-failure") await expect(send).rejects.toThrow("failed transport");
        else await send;
        const callId = f.sent[0].message.params._meta.callId;
        if (end === "abort") caller.abort();
        if (end === "notification") await f.transport.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
        if (end === "response") f.base.emit({ jsonrpc: "2.0", id: 1, result: {} });
        if (end === "close") await f.transport.close();
        expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
        f.base.emit({ jsonrpc: "2.0", id: "late", method: "elicitation/create", params: {
            requestedSchema: { type: "object", properties: {} },
            _meta: { callId, codex_approval_kind: "mcp_tool_call", tool_name: "probe", tool_params: {} },
        } });
        await vi.waitFor(() => expect(f.sent.at(-1).message.id).toBe("late"));
        expect(f.sent.at(-1).message.result.action).toBe("decline");
        expect(f.invocation.approveNested).not.toHaveBeenCalled();
        await f.transport.close();
    });
}

test("[mcp-transport] drops cancelled catalog requests and rejects abort during binding before dispatch", async () => {
    const f = await setup();
    const caller = new AbortController();
    await f.transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { signal: caller.signal });
    caller.abort();
    const late = { jsonrpc: "2.0", id: 1, result: { tools: null } };
    f.base.emit(late);
    expect(f.received.at(-1)).toBe(late);
    const pending = new AbortController();
    let release;
    f.invocation.checkCurrent.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const send = externalInvocations.run(f.invocation, () => f.transport.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "probe" } }, { signal: pending.signal }));
    pending.abort();
    release();
    await expect(send).rejects.toThrow();
    expect(f.sent).toHaveLength(1);
    await f.transport.close();
});
