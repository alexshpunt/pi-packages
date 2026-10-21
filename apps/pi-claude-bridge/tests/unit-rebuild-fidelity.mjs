import { expect, it } from "vitest";
import { crc32, inflateSync } from "node:zlib";
import { VERIFICATION_PNG_BASE64 } from "../tools/verify/fixtures/image.js";
import { compareRequestPrefix } from "../tools/verify/fidelity.js";
import { isReportSafe } from "../tools/verify/report.js";
import { observeToolResultShape } from "../tools/verify/checks/06-tool-result-shapes.js";
import { usageComparison } from "../tools/verify/rebuild-cases.js";

it("uses an intact PNG fixture rather than silently exercising image-removal fallback", () => {
	const png = Buffer.from(VERIFICATION_PNG_BASE64, "base64");
	expect([...png.subarray(0, 8)]).toStrictEqual([137, 80, 78, 71, 13, 10, 26, 10]);
	const compressed = [];
	for (let offset = 8; offset < png.length;) {
		const size = png.readUInt32BE(offset);
		const type = png.subarray(offset + 4, offset + 8).toString();
		expect(crc32(png.subarray(offset + 4, offset + 8 + size)), type).toBe(png.readUInt32BE(offset + 8 + size));
		if (type === "IHDR") {
			expect(png.readUInt32BE(offset + 8)).toBe(32);
			expect(png.readUInt32BE(offset + 12)).toBe(32);
		}
		if (type === "IDAT") compressed.push(png.subarray(offset + 8, offset + 8 + size));
		offset += size + 12;
	}
	expect(inflateSync(Buffer.concat(compressed)).length).toBe((32 * 3 + 1) * 32);
});

it("reports tool-result shapes as safe fingerprints, not a raw content field", () => {
	const shape = observeToolResultShape({ type: "tool_result", tool_use_id: "fixture", content: "PRIVATE-CONTENT" });
	expect(isReportSafe(shape)).toBe(true);
	expect(JSON.stringify(shape).includes("PRIVATE-CONTENT")).toBe(false);
	expect(shape.contentFingerprint.byteLength).toBe(JSON.stringify("PRIVATE-CONTENT").length);
});

it("measures cacheable-token shortfall with no tolerance and retains the original formula", () => {
	const before = { usage: { input: 2, cacheRead: 100, cacheWrite: 50 } };
	const after = { usage: { input: 2, cacheRead: 150, cacheWrite: 5 } };
	const measured = usageComparison(before, after);
	expect(measured.shortfall).toBe(0);
	expect(measured.originalMetricShortfall).toBe(2);
	expect(measured.cacheWriteAboveNewInput).toBe(0);
	expect(usageComparison(before, { usage: { ...after.usage, cacheRead: 149 } }).shortfall).toBe(1);
});

it("compares the prior prefix without requiring equal message counts", () => {
	const before = { messages: [{ role: "user", content: "original" }] };
	const after = { messages: [...before.messages, { role: "assistant", content: "answer" }] };
	expect(compareRequestPrefix(before, after).firstDifference).toBe(null);
});

it("normalizes only the documented billing, cache-control and single text forms", () => {
	const before = { system: [{ type: "text", text: "x-anthropic-billing-header: old" }, { type: "text", text: "same" }],
		messages: [{ role: "user", content: [{ type: "text", text: "same", cache_control: { type: "ephemeral" } }] }] };
	const after = { system: [{ type: "text", text: "x-anthropic-billing-header: new" }, { type: "text", text: "same" }],
		messages: [{ role: "user", content: "same" }] };
	expect(compareRequestPrefix(before, after).firstDifference).toBe(null);
	expect(compareRequestPrefix(before, after, false).firstDifference.path).toBe("messages[0].content");
});

it("retains serialized object-key order when identifying tool-result drift", () => {
	const before = { messages: [{ role: "user", content: [{ tool_use_id: "tool", type: "tool_result", content: "same" }] }] };
	const after = { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "tool", content: "same" }] }] };
	const result = compareRequestPrefix(before, after);
	expect(result.firstDifference.kind).toBe("key-order");
	expect(result.firstDifference.path).toBe("messages[0].content[0]");
});

it("reports the first mismatch by path and fingerprint, never fixture text", () => {
	const marker = "PRIVATE-FIXTURE-MARKER";
	const result = compareRequestPrefix({ messages: [{ role: "user", content: marker }] }, { messages: [{ role: "user", content: "changed" }] });
	expect(result.firstDifference.path).toBe("messages[0].content");
	expect(result.firstDifference.firstCharacter).toBe(0);
	expect(isReportSafe(result)).toBe(true);
	expect(JSON.stringify(result).includes(marker)).toBe(false);
});
