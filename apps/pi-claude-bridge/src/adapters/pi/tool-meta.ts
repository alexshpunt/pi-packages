// The `_meta` pi's extensions report for each tool, by tool name. An MCP tool's is
// the `_meta` its server declared in `tools/list`. Two sources, both read on every
// call:
// - `meta` of `pi.getAllTools()`, on pi versions that report it.
// - Replies on the `tool-meta` channel of `pi.events`, for pi versions that do not:
//   an extension that registers tools with `_meta` (an MCP extension) calls the
//   request's `reply` before `emit` returns, with `{ [toolName]: meta }` of its own
//   tools. Several extensions may reply, and none at all.
// A tool reported by both keeps the `getAllTools()` value, which is pi's own record.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TOOL_META_CHANNEL = "tool-meta";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function listPiToolMeta(pi: Pick<ExtensionAPI, "events" | "getAllTools">): Map<string, Record<string, unknown>> {
	const metas = new Map<string, Record<string, unknown>>();
	const keep = (name: unknown, meta: unknown) => {
		if (typeof name === "string" && isRecord(meta)) metas.set(name, meta);
	};
	pi.events.emit(TOOL_META_CHANNEL, {
		reply: (tools: unknown) => {
			if (!isRecord(tools)) return;
			for (const [name, meta] of Object.entries(tools)) keep(name, meta);
		},
	});
	for (const tool of pi.getAllTools()) keep(tool.name, (tool as { meta?: unknown }).meta);
	return metas;
}
