import { it } from "node:test";
import assert from "node:assert/strict";
import { crc32, inflateSync } from "node:zlib";
import { VERIFICATION_PNG_BASE64 } from "../tools/verify/fixtures/image.js";
import { compareRequestPrefix } from "../tools/verify/fidelity.js";
import { isReportSafe } from "../tools/verify/report.js";
import { observeToolResultShape } from "../tools/verify/checks/06-tool-result-shapes.js";
import { usageComparison } from "../tools/verify/rebuild-cases.js";

it("uses an intact PNG fixture rather than silently exercising image-removal fallback", () => {
	const png = Buffer.from(VERIFICATION_PNG_BASE64, "base64");
	assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
	const compressed = [];
	for (let offset = 8; offset < png.length;) {
		const size = png.readUInt32BE(offset);
		const type = png.subarray(offset + 4, offset + 8).toString();
		assert.equal(crc32(png.subarray(offset + 4, offset + 8 + size)), png.readUInt32BE(offset + 8 + size), type);
		if (type === "IHDR") {
			assert.equal(png.readUInt32BE(offset + 8), 32);
			assert.equal(png.readUInt32BE(offset + 12), 32);
		}
		if (type === "IDAT") compressed.push(png.subarray(offset + 8, offset + 8 + size));
		offset += size + 12;
	}
	assert.equal(inflateSync(Buffer.concat(compressed)).length, (32 * 3 + 1) * 32);
});

it("reports tool-result shapes as safe fingerprints, not a raw content field", () => {
	const shape = observeToolResultShape({ type: "tool_result", tool_use_id: "fixture", content: "PRIVATE-CONTENT" });
	assert.equal(isReportSafe(shape), true);
	assert.equal(JSON.stringify(shape).includes("PRIVATE-CONTENT"), false);
	assert.equal(shape.contentFingerprint.byteLength, JSON.stringify("PRIVATE-CONTENT").length);
});

it("measures cacheable-token shortfall with no tolerance and retains the original formula", () => {
	const before = { usage: { input: 2, cacheRead: 100, cacheWrite: 50 } };
	const after = { usage: { input: 2, cacheRead: 150, cacheWrite: 5 } };
	const measured = usageComparison(before, after);
	assert.equal(measured.shortfall, 0);
	assert.equal(measured.originalMetricShortfall, 2);
	assert.equal(measured.cacheWriteAboveNewInput, 0);
	assert.equal(usageComparison(before, { usage: { ...after.usage, cacheRead: 149 } }).shortfall, 1);
});

it("compares the prior prefix without requiring equal message counts", () => {
	const before = { messages: [{ role: "user", content: "original" }] };
	const after = { messages: [...before.messages, { role: "assistant", content: "answer" }] };
	assert.equal(compareRequestPrefix(before, after).firstDifference, null);
});

it("normalizes only the documented billing, cache-control and single text forms", () => {
	const before = { system: [{ type: "text", text: "x-anthropic-billing-header: old" }, { type: "text", text: "same" }],
		messages: [{ role: "user", content: [{ type: "text", text: "same", cache_control: { type: "ephemeral" } }] }] };
	const after = { system: [{ type: "text", text: "x-anthropic-billing-header: new" }, { type: "text", text: "same" }],
		messages: [{ role: "user", content: "same" }] };
	assert.equal(compareRequestPrefix(before, after).firstDifference, null);
	assert.equal(compareRequestPrefix(before, after, false).firstDifference.path, "messages[0].content");
});

it("retains serialized object-key order when identifying tool-result drift", () => {
	const before = { messages: [{ role: "user", content: [{ tool_use_id: "tool", type: "tool_result", content: "same" }] }] };
	const after = { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "tool", content: "same" }] }] };
	const result = compareRequestPrefix(before, after);
	assert.equal(result.firstDifference.kind, "key-order");
	assert.equal(result.firstDifference.path, "messages[0].content[0]");
});

it("reports the first mismatch by path and fingerprint, never fixture text", () => {
	const marker = "PRIVATE-FIXTURE-MARKER";
	const result = compareRequestPrefix({ messages: [{ role: "user", content: marker }] }, { messages: [{ role: "user", content: "changed" }] });
	assert.equal(result.firstDifference.path, "messages[0].content");
	assert.equal(result.firstDifference.firstCharacter, 0);
	assert.equal(isReportSafe(result), true);
	assert.equal(JSON.stringify(result).includes(marker), false);
});
