/**
 * The `meta` of MCP tools, for other extensions.
 *
 * Each MCP tool's definition carries `meta`: the `_meta` object of its `tools/list` entry as the
 * server sent it. It is never sent to the model. Pi versions whose `pi.getAllTools()` does not report
 * `meta` keep it from other extensions, so they ask over `pi.events` instead:
 *
 * ```ts
 * const meta: Record<string, Record<string, unknown>> = {};
 * pi.events.emit("tool-meta", { reply: (tools) => Object.assign(meta, tools) });
 * ```
 *
 * `reply` is called before `emit` returns, with the `meta` of every tool this extension registered
 * that has one, keyed by tool name. It is not called by extensions that do not answer the channel,
 * and may be called by more than one that does, each with its own tools.
 */

import type { JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** `pi.events` channel on which extensions ask for the `meta` of tools. */
export const TOOL_META_CHANNEL = "tool-meta";

/** The `_meta` of a tool's `tools/list` entry. */
export type ToolMeta = Readonly<Record<string, JsonValue>>;

/** What extensions emit on {@link TOOL_META_CHANNEL}. */
export interface ToolMetaRequest {
  reply(meta: Record<string, ToolMeta>): void;
}

function isToolMetaRequest(data: unknown): data is ToolMetaRequest {
  return typeof data === "object" && data !== null && typeof (data as { reply?: unknown }).reply === "function";
}

/**
 * Answer requests on {@link TOOL_META_CHANNEL} with the `meta` of `tools()`, keyed by tool name. Tools
 * without `meta` are left out, and each reply gets its own copies.
 */
export function answerToolMetaRequests(
  events: ExtensionAPI["events"],
  tools: () => Iterable<{ readonly name: string; readonly meta?: ToolMeta }>,
): void {
  events.on(TOOL_META_CHANNEL, (data) => {
    if (!isToolMetaRequest(data)) return;
    const reply: Record<string, ToolMeta> = {};
    for (const { name, meta } of tools()) {
      if (meta) reply[name] = { ...meta };
    }
    data.reply(reply);
  });
}
