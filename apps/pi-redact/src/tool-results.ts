import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import type { MaskEngine } from "./engine.js";
import { maskContent, WITHHELD_TEXT } from "./messages.js";

/**
 * Changes that mask a tool result before Pi stores and displays it, or `undefined` when
 * nothing was detected. `details` and `structuredContent` are masked too: they are saved
 * in the session file, and a hook that replaces `content` alone drops `structuredContent`.
 */
export function maskToolResult(engine: MaskEngine, event: ToolResultEvent): ToolResultEventResult | undefined {
  const filePath = event.toolName === "read" && typeof event.input.path === "string" ? event.input.path : undefined;
  // Untyped tools may return no content; Pi stores that as an empty list.
  const content = maskContent(engine, event.content, filePath);
  const details = engine.maskJson(event.details);
  const structuredContent =
    event.structuredContent === undefined ? undefined : engine.maskJson(event.structuredContent);

  const result: ToolResultEventResult = {};
  if (content !== event.content) {
    result.content = content;
    if (structuredContent !== undefined) result.structuredContent = structuredContent;
  } else if (structuredContent !== event.structuredContent) {
    result.structuredContent = structuredContent;
  }
  if (details !== event.details) result.details = details;
  return Object.keys(result).length === 0 ? undefined : result;
}

/** Result that replaces a tool result whose masking failed; its structured content is dropped with it. */
export function withheldToolResult(): ToolResultEventResult {
  return { content: [{ type: "text", text: WITHHELD_TEXT }], details: {}, isError: true };
}
