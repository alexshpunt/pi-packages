import type { ContextWithSystemEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { MaskEngine } from "./engine.js";

export type AgentMessage = ContextWithSystemEvent["messages"][number];
type AssistantBlock = Extract<AgentMessage, { role: "assistant" }>["content"][number];
type ContentBlock = AssistantBlock | Exclude<Extract<AgentMessage, { role: "user" }>["content"], string>[number];

/** Model-facing text that replaces content whose masking failed, so a failure never sends the original. */
export const WITHHELD_TEXT = "[pi-redact withheld this content because masking it failed]";

function maskBlock<T extends ContentBlock>(engine: MaskEngine, block: T, filePath: string | undefined): T {
  switch (block.type) {
    case "text": {
      const text = engine.maskText(block.text, filePath);
      return text === block.text ? block : { ...block, text };
    }
    case "toolCall": {
      const args = engine.maskJson(block.arguments);
      const argumentsError = block.argumentsError === undefined ? undefined : engine.maskText(block.argumentsError);
      if (args === block.arguments && argumentsError === block.argumentsError) return block;
      return { ...block, arguments: args, ...(argumentsError === undefined ? {} : { argumentsError }) };
    }
    // Images cannot be scanned. Thinking text and its provider signature must round-trip unchanged.
    case "image":
    case "thinking":
      return block;
    default:
      return engine.maskJson(block);
  }
}

/** Mask text blocks and tool-call arguments; returns `blocks` itself when nothing changed. */
export function maskBlocks<T extends ContentBlock>(engine: MaskEngine, blocks: T[], filePath?: string): T[] {
  let copy: T[] | undefined;
  blocks.forEach((block, index) => {
    const masked = maskBlock(engine, block, filePath);
    if (masked === block) return;
    copy ??= [...blocks];
    copy[index] = masked;
  });
  return copy ?? blocks;
}

/** Mask string or block content. A missing or malformed value is returned as it is: it holds no text. */
export function maskContent<T extends string | ContentBlock[]>(engine: MaskEngine, content: T, filePath?: string): T {
  if (typeof content === "string") return engine.maskText(content, filePath) as T;
  return (Array.isArray(content) ? maskBlocks(engine, content, filePath) : content) as T;
}

/** The text of one message as the model will read it. System messages stay unchanged by design. */
export function maskMessage(
  engine: MaskEngine,
  message: AgentMessage,
  readPaths: ReadonlyMap<string, string> = new Map(),
): AgentMessage {
  switch (message.role) {
    case "system":
      return message;
    case "user":
    case "custom": {
      const content = maskContent(engine, message.content);
      return content === message.content ? message : { ...message, content };
    }
    case "assistant": {
      const content = maskContent(engine, message.content);
      return content === message.content ? message : { ...message, content };
    }
    case "toolResult": {
      // Details are not sent to the model; the tool_result hook already masked the stored copy.
      const content = maskContent(engine, message.content, readPaths.get(message.toolCallId));
      return content === message.content ? message : { ...message, content };
    }
    case "bashExecution": {
      const command = engine.maskText(message.command);
      const output = engine.maskText(message.output);
      return command === message.command && output === message.output ? message : { ...message, command, output };
    }
    case "branchSummary":
    case "compactionSummary": {
      const summary = engine.maskText(message.summary);
      return summary === message.summary ? message : { ...message, summary };
    }
    default:
      return engine.maskJson(message);
  }
}

/** Replacement for a message that could not be masked. `undefined` drops a message of unknown shape. */
export function withholdMessage(message: AgentMessage): AgentMessage | undefined {
  switch (message.role) {
    case "system":
      return message;
    case "user":
    case "toolResult":
    case "custom":
      return { ...message, content: [{ type: "text", text: WITHHELD_TEXT }] } as AgentMessage;
    case "assistant":
      return {
        ...message,
        content: message.content.map((block) => {
          if (block.type === "text") return { ...block, text: WITHHELD_TEXT };
          if (block.type !== "toolCall") return block;
          const { argumentsError: _dropped, ...call } = block;
          return { ...call, arguments: {} };
        }),
      };
    case "bashExecution":
      return { ...message, command: WITHHELD_TEXT, output: WITHHELD_TEXT };
    case "branchSummary":
    case "compactionSummary":
      return { ...message, summary: WITHHELD_TEXT };
    default:
      return undefined;
  }
}

/** Paths of `read` calls by tool call id, so their results are scanned with the file's path hint. */
export function readPathsOf(messages: readonly AgentMessage[]): Map<string, string> {
  const paths = new Map<string, string>();
  for (const message of messages) {
    // A malformed message must not stop the whole request from being masked.
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content)
      if (block?.type === "toolCall" && block.name === "read" && typeof block.arguments?.path === "string")
        paths.set(block.id, block.arguments.path);
  }
  return paths;
}

export interface MaskedMessages {
  /** `messages` itself when nothing changed. */
  readonly messages: AgentMessage[];
  readonly withheldCount: number;
}

/** Mask every message; one that fails is withheld instead of being sent as it was. */
export function maskMessages(engine: MaskEngine, messages: AgentMessage[]): MaskedMessages {
  const readPaths = readPathsOf(messages);
  let copy: (AgentMessage | undefined)[] | undefined;
  let withheldCount = 0;
  messages.forEach((message, index) => {
    let masked: AgentMessage | undefined;
    try {
      masked = maskMessage(engine, message, readPaths);
    } catch {
      masked = withholdMessage(message);
      withheldCount++;
    }
    if (masked === message) return;
    copy ??= [...messages];
    copy[index] = masked;
  });
  if (!copy) return { messages, withheldCount };
  return { messages: copy.filter((message) => message !== undefined), withheldCount };
}

function maskEntry(engine: MaskEngine, entry: SessionEntry): SessionEntry {
  switch (entry.type) {
    case "message": {
      const message = maskMessage(engine, entry.message);
      return message === entry.message ? entry : { ...entry, message };
    }
    case "custom_message": {
      const content = maskContent(engine, entry.content);
      return content === entry.content ? entry : { ...entry, content };
    }
    case "branch_summary":
    case "compaction": {
      const summary = engine.maskText(entry.summary);
      return summary === entry.summary ? entry : { ...entry, summary };
    }
    default:
      return entry;
  }
}

function withholdEntry(entry: SessionEntry): SessionEntry {
  switch (entry.type) {
    case "message": {
      const message = withholdMessage(entry.message);
      if (message) return { ...entry, message };
      break;
    }
    case "custom_message":
      return { ...entry, content: WITHHELD_TEXT };
    case "branch_summary":
    case "compaction":
      return { ...entry, summary: WITHHELD_TEXT };
  }
  // A custom entry contributes no text to a summary.
  return {
    type: "custom",
    customType: "pi-redact-withheld",
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
  };
}

/**
 * Replace each entry of `entries` with a copy whose summarized text is masked; entries
 * themselves are never modified. Works in place because Pi's branch summarizer keeps a
 * reference to this array. Returns how many entries were withheld after a failure.
 */
export function maskSessionEntriesInPlace(engine: MaskEngine, entries: SessionEntry[]): number {
  let withheldCount = 0;
  entries.forEach((entry, index) => {
    try {
      entries[index] = maskEntry(engine, entry);
    } catch {
      entries[index] = withholdEntry(entry);
      withheldCount++;
    }
  });
  return withheldCount;
}
