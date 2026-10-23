import { createHash } from "node:crypto";
import type { CarriedToolResult, CarriedToolResultSource } from "./types.js";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { JsonlRecord } from "cc-session-io";

type RecordValue = Record<string, unknown>;

const MAX_SAVED_OUTPUT_BYTES = 32 * 1024 * 1024;
const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const IMAGE_SOURCE = /^\[Image: source: ([^\n]+)\]$/;
const PERSISTED = /^<persisted-output>\nOutput too large \([^)]*\)\. Full output saved to: ([^\n]+)\n/;
const OVERSIZED = /^Error: result \([^)]*\) exceeds maximum allowed tokens\. Output has been saved to ([^\n]+?)\.\n/;

function isRecord(value: unknown): value is RecordValue {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Identity only, not wire representation. Never retain another full copy of a large result. */
function contentFingerprint(content: unknown): string | undefined {
	const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
	if (!Array.isArray(blocks)) return undefined;
	const canonical: unknown[] = [];
	for (const block of blocks) {
		if (!isRecord(block)) return undefined;
		if (block.type === "text" && typeof block.text === "string") canonical.push(["text", block.text]);
		else if (block.type === "image") {
			const source = isRecord(block.source) ? block.source : undefined;
			const mimeType = source?.media_type ?? block.mimeType;
			const data = source?.data ?? block.data;
			if (typeof mimeType !== "string" || typeof data !== "string" || (source && source.type !== "base64")) return undefined;
			canonical.push(["image", mimeType, data]);
		} else return undefined;
	}
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** The record may refer to an earlier rotated session, but never another project. */
function savedFilePath(projectDir: string, path: string): string | undefined {
	if (!isAbsolute(path)) return undefined;
	const root = resolve(projectDir);
	const parts = relative(root, resolve(path)).split(sep);
	if (parts.length !== 3 || !SESSION_ID.test(parts[0]) || parts[1] !== "tool-results" || !parts[2]) return undefined;
	for (const directory of [root, join(root, parts[0]), join(root, parts[0], parts[1])]) {
		if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return undefined;
	}
	return join(root, ...parts);
}

/** Read at most 32 MiB from a regular, non-symlink saved output. A growing or
 *  truncated file is not proof that the original result equals Pi's current one. */
export function readSavedOutput(projectDir: string, path: string): string | undefined {
	let descriptor: number | undefined;
	try {
		const filePath = savedFilePath(projectDir, path);
		if (!filePath) return undefined;
		const stat = lstatSync(filePath, { throwIfNoEntry: false });
		if (!stat?.isFile() || stat.size > MAX_SAVED_OUTPUT_BYTES) return undefined;
		descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
		const opened = fstatSync(descriptor);
		if (!opened.isFile() || opened.size > MAX_SAVED_OUTPUT_BYTES || opened.dev !== stat.dev || opened.ino !== stat.ino) return undefined;
		const data = Buffer.alloc(opened.size);
		let offset = 0;
		while (offset < data.length) {
			const bytes = readSync(descriptor, data, offset, data.length - offset, offset);
			if (bytes === 0) return undefined;
			offset += bytes;
		}
		if (fstatSync(descriptor).size !== opened.size) return undefined;
		return data.toString("utf8");
	} catch {
		return undefined;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function sourceOf(content: unknown): CarriedToolResultSource | undefined {
	if (typeof content === "string") {
		const path = PERSISTED.exec(content)?.[1] ?? OVERSIZED.exec(content)?.[1];
		return path ? { kind: "saved", path, isJSON: path.endsWith(".json") || /\nFormat: JSON(?:\n|$)/.test(content) } : undefined;
	}
	if (!Array.isArray(content)) return undefined;
	const kept: unknown[] = [], paths: string[] = [];
	for (let index = 0; index < content.length; index++) {
		const block = content[index];
		kept.push(block);
		const next = content[index + 1];
		const match = isRecord(block) && block.type === "image" && isRecord(next) && next.type === "text" && typeof next.text === "string"
			? IMAGE_SOURCE.exec(next.text) : null;
		// Only the generated marker immediately following its image is removed.
		// An ordinary Pi text block that resembles a marker must still match.
		if (match) { paths.push(match[1]); index++; }
	}
	return paths.length ? { kind: "image", content: kept, paths } : undefined;
}

/** Collect descriptors only. Files are read lazily for ids still present in Pi's
 *  history, rather than reading every historical oversized result during compaction. */
export function collectCarriedToolResults(records: readonly JsonlRecord[]): Map<string, CarriedToolResult> {
	const carried = new Map<string, CarriedToolResult>();
	for (const raw of records) {
		const record = raw as unknown;
		if (!isRecord(record) || record.type !== "user" || record.isSidechain) continue;
		const content = isRecord(record.message) ? record.message.content : undefined;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!isRecord(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
			const source = sourceOf(block.content);
			if (source) carried.set(block.tool_use_id, { content: block.content, isError: block.is_error === true, source });
			else carried.delete(block.tool_use_id);
		}
	}
	return carried;
}

function sourceFingerprint(source: CarriedToolResultSource, projectDir: string): string | undefined {
	if (source.kind === "image") {
		for (const path of source.paths) {
			const filePath = savedFilePath(projectDir, path);
			if (!filePath) return undefined;
			const stat = lstatSync(filePath, { throwIfNoEntry: false });
			// Inline image data remains complete even if its old on-disk copy is gone.
			if (stat && !stat.isFile()) return undefined;
		}
		return contentFingerprint(source.content);
	}
	const text = readSavedOutput(projectDir, source.path);
	if (text === undefined) return undefined;
	if (!source.isJSON) return contentFingerprint(text);
	try {
		const parsed: unknown = JSON.parse(text);
		return Array.isArray(parsed) ? contentFingerprint(parsed) : undefined;
	} catch { return undefined; }
}

/** Replace only content whose source and error state still match Pi. Pairing,
 *  message order and tool ids stay untouched; callers restore wire key order later. */
export function applyCarriedToolResults(
	messages: readonly { role: string; content: unknown }[],
	carried: ReadonlyMap<string, CarriedToolResult>,
	projectDir: string,
): string[] {
	const replaced: string[] = [];
	for (const message of messages) {
		if (message.role !== "user" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (!isRecord(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
			const candidate = carried.get(block.tool_use_id);
			if (!candidate || candidate.isError !== (block.is_error === true)) continue;
			const current = contentFingerprint(block.content);
			if (current === undefined) continue;
			try {
				if (current !== sourceFingerprint(candidate.source, projectDir)) continue;
			} catch { continue; }
			block.content = candidate.content;
			replaced.push(block.tool_use_id);
		}
	}
	return replaced;
}
