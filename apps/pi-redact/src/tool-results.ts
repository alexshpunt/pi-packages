import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import type { MaskEngine } from "./engine.js";
import { maskContent, WITHHELD_TEXT } from "./messages.js";

/**
 * Changes that mask a tool result before Pi stores and displays it, or `undefined` when
 * nothing was detected. `details` is saved in the session file. `structuredContent` is not,
 * but Pi passes it to `tool_execution_end` listeners such as JSON-mode output and RPC clients,
 * and a hook that replaces `content` alone drops it.
 */
export function maskToolResult(engine: MaskEngine, event: ToolResultEvent): ToolResultEventResult | undefined {
  const filePath = event.toolName === "read" && typeof event.input.path === "string" ? event.input.path : undefined;
  const label = filePath === undefined ? `${event.toolName} result` : `read ${filePath}`;
  // Untyped tools may return no content; Pi stores that as an empty list.
  const content = engine.labeled(label, () => maskContent(engine, event.content, filePath));
  const details = engine.labeled(`${label} details`, () => engine.maskJson(event.details));
  const structuredContent =
    event.structuredContent === undefined
      ? undefined
      : engine.labeled(`${label} structured content`, () =>
          // `read` returns its text here too; scan it with the same path hint as `content`.
          typeof event.structuredContent === "string"
            ? engine.maskText(event.structuredContent, filePath)
            : engine.maskJson(event.structuredContent),
        );

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
