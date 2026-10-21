import { afterEach, describe, expect, it, vi } from "vitest";
import { createToolBridge } from "../src/provider/tool-bridge.js";
import { QueryContext } from "../src/provider/query-context.js";

afterEach(() => vi.restoreAllMocks());

describe("tool result debug previews", () => {
	it.each([false, true])("serializes extracted results only with DEBUG=%s", DEBUG => {
		const bridge = createToolBridge({ DEBUG, debug: vi.fn() });
		const content = [{ type: "image", data: "x".repeat(1024 * 1024), mimeType: "image/png" }];
		const stringify = vi.spyOn(JSON, "stringify");
		const results = bridge.extractAllToolResults({ messages: [
			{ role: "toolResult", toolCallId: "call-1", content },
		] });
		expect(stringify).toHaveBeenCalledTimes(DEBUG ? 1 : 0);
		expect(results[0].content).toStrictEqual(content);
	});

	it.each([false, true])("serializes delivered results only with DEBUG=%s", async DEBUG => {
		const bridge = createToolBridge({ DEBUG, debug: vi.fn() });
		const c = new QueryContext();
		const resolve = vi.fn();
		c.pendingToolCalls.set("call-1", { toolName: "read", resolve });
		const result = { toolCallId: "call-1", content: [{ type: "text", text: "x".repeat(1024 * 1024) }] };
		const stringify = vi.spyOn(JSON, "stringify");
		await bridge.deliverToolResults(c, [result], null, 1);
		expect(stringify).toHaveBeenCalledTimes(DEBUG ? 1 : 0);
		expect(resolve).toHaveBeenCalledWith(result);
		expect(c.pendingToolCalls.size).toBe(0);
	});
});
