import { randomUUID } from "node:crypto";
import { platform, release, type as osType } from "node:os";
import type { ChatMessage, JsonObject } from "../types.ts";

export function environmentContext(cwd: string, now = new Date()): string {
  const platformName = platform() === "darwin" ? "macos" : platform() === "win32" ? "windows" : platform();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(now);
  return `<system_info>\nThe following information is automatically generated context about your current environment.\nCurrent workspace directories:\n  ${cwd} (cwd)\n\nPlatform: ${platformName}\nOS Version: ${osType()} ${release()}\nToday's date: ${weekday}, ${date}\n</system_info>`;
}

/** Creates new wire message IDs without mutating history objects. Tool call IDs, signatures and images are preserved. */
export function wireMessages(messages: readonly ChatMessage[], options: { cwd?: string; includeContext?: boolean } = {}): JsonObject[] {
  const wire = messages.map((message) => {
    const result: JsonObject = { ...message, messageId: randomUUID() };
    if (!message.prompt) delete result.prompt;
    if (message.toolResultIsError === false) delete result.toolResultIsError;
    if (message.thinking === "") delete result.thinking;
    if (message.signature === "") delete result.signature;
    if (message.source === "CHAT_MESSAGE_SOURCE_USER" || message.source === "CHAT_MESSAGE_SOURCE_TOOL") {
      result.promptCacheOptions ??= { type: "CACHE_CONTROL_TYPE_EPHEMERAL" };
    }
    return result;
  });
  if (options.includeContext && wire.length) {
    wire.unshift({ messageId: randomUUID(), source: "CHAT_MESSAGE_SOURCE_USER", prompt: environmentContext(options.cwd ?? process.cwd()) });
    // Does not advertise built-in skills that do not exist here. The content is limited to allowed prompt/tool differences.
    wire.splice(2, 0, {
      messageId: randomUUID(), source: "CHAT_MESSAGE_SOURCE_USER",
      prompt: "<available_skills>\nNo skills are configured for this PoC. Use only tools provided in the request.\n</available_skills>",
    });
  }
  return wire;
}
