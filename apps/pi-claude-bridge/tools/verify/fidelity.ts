import { fingerprint } from "./report.js";
import type { Facts } from "./types.js";

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);

function withoutCacheControl(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutCacheControl);
	if (isRecord(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "cache_control").map(([key, item]) => [key, withoutCacheControl(item)]));
	return value;
}

function plainTextContent(message: unknown): unknown {
	if (!isRecord(message)) return message;
	const content = message.content;
	if (Array.isArray(content) && content.length === 1 && isRecord(content[0]) && content[0].type === "text" && Object.keys(content[0]).length === 2) {
		return { ...message, content: content[0].text };
	}
	return message;
}

/** Same comparison exclusions as diag/probe-rebuild-fidelity.mjs, never raw values in reports. */
export function requestElements(body: RecordValue, shouldNormalizeTextShape = true): { path: string; value: unknown }[] {
	const system = Array.isArray(body.system) ? body.system : body.system ? [{ type: "text", text: body.system }] : [];
	return [
		{ path: "tools", value: withoutCacheControl(body.tools ?? []) },
		...system.flatMap((block, index) => isRecord(block) && String(block.text ?? "").startsWith("x-anthropic-billing-header") ? [] : [{ path: `system[${index}]`, value: withoutCacheControl(block) }]),
		...(Array.isArray(body.messages) ? body.messages : []).map((message, index) => ({ path: `messages[${index}]`,
			value: shouldNormalizeTextShape ? plainTextContent(withoutCacheControl(message)) : withoutCacheControl(message) })),
	];
}

const valueFingerprint = (value: unknown) => fingerprint(JSON.stringify(value) ?? "<absent>");

/** Diagnostic intervention, never production behavior: a system-role message whose
 *  content is a plain string is sent as one text block, the shape Claude Code gives
 *  the same message while it is the last one. Returns the body itself when unchanged. */
export function systemTextAsBlocks(body: RecordValue): RecordValue {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const isSystemText = (message: unknown) => isRecord(message) && message.role === "system" && typeof message.content === "string";
	if (!messages.some(isSystemText)) return body;
	return { ...body, messages: messages.map(message => isSystemText(message)
		? { ...(message as RecordValue), content: [{ type: "text", text: (message as RecordValue).content }] } : message) };
}

/** Role, content kind, block types/sizes and cache_control placement per message — no text. */
export function messageShapes(body: Facts): Facts[] {
	return (body.messages as Facts[]).map(message => ({
		role: message.role, kind: Array.isArray(message.content) ? "blocks" : typeof message.content,
		blocks: (Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }]).map((block: Facts) => ({
			type: block.type, textBytes: typeof block.text === "string" ? Buffer.byteLength(block.text) : null, hasCacheControl: !!block.cache_control,
		})),
	}));
}

export type CapturedPrefix = { path: string; value: ReturnType<typeof fingerprint> }[];

/** Safe cross-process evidence; raw requests stay inside the capturing process. */
export function captureRequestPrefix(body: RecordValue, shouldNormalizeTextShape = true): CapturedPrefix {
	return requestElements(body, shouldNormalizeTextShape).map(element => ({ path: element.path, value: valueFingerprint(element.value) }));
}

export function compareCapturedPrefixes(before: CapturedPrefix, after: CapturedPrefix): Facts {
	for (const [index, element] of before.entries()) {
		if (element.value.sha256 !== after[index]?.value.sha256) return {
			previousElements: before.length, matchedElements: index,
			firstDifference: { path: element.path, kind: after[index] ? "value" : "missing-element", before: element.value, after: after[index]?.value ?? null },
		};
	}
	return { previousElements: before.length, matchedElements: before.length, firstDifference: null };
}

/** Finds structural and serialized-key-order differences without disclosing input text. */
function firstDifference(before: unknown, after: unknown, path: string): Facts | null {
	if (before === after) return null;
	if (Array.isArray(before) && Array.isArray(after)) {
		for (let index = 0; index < Math.min(before.length, after.length); index++) {
			const difference = firstDifference(before[index], after[index], `${path}[${index}]`);
			if (difference) return difference;
		}
		if (before.length === after.length) return null;
		return { path, kind: "array-length", beforeLength: before.length, afterLength: after.length };
	}
	if (isRecord(before) && isRecord(after)) {
		const beforeKeys = Object.keys(before), afterKeys = Object.keys(after);
		for (const key of beforeKeys) {
			if (!Object.hasOwn(after, key)) return { path: `${path}.${key}`, kind: "removed-key" };
			const difference = firstDifference(before[key], after[key], `${path}.${key}`);
			if (difference) return difference;
		}
		for (const key of afterKeys) if (!Object.hasOwn(before, key)) return { path: `${path}.${key}`, kind: "added-key" };
		return JSON.stringify(beforeKeys) === JSON.stringify(afterKeys) ? null : { path, kind: "key-order", beforeKeys, afterKeys };
	}
	let firstCharacter: number | null = null;
	if (typeof before === "string" && typeof after === "string") {
		firstCharacter = 0;
		while (firstCharacter < Math.min(before.length, after.length) && before[firstCharacter] === after[firstCharacter]) firstCharacter++;
	}
	return { path, kind: "value", before: valueFingerprint(before), after: valueFingerprint(after), firstCharacter };
}

export function compareRequestPrefix(before: RecordValue, after: RecordValue, shouldNormalizeTextShape = true): Facts {
	const previous = requestElements(before, shouldNormalizeTextShape), current = requestElements(after, shouldNormalizeTextShape);
	for (let index = 0; index < previous.length; index++) {
		const next = current[index];
		const difference = !next ? { path: previous[index].path, kind: "missing-element" } : firstDifference(previous[index].value, next.value, previous[index].path);
		if (difference) return { previousElements: previous.length, matchedElements: index, firstDifference: difference };
	}
	return { previousElements: previous.length, matchedElements: previous.length, firstDifference: null };
}
