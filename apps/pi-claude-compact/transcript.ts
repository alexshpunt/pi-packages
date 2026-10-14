import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { convertToLlm, estimateTokens, type ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { TRANSCRIPT_PREFACE, TRUNCATED_HEAD_MARKER } from "./prompt.ts";

/** One API round (Claude Code's w1): an assistant response plus everything up to the next response. */
export interface MessageGroup {
  entries: ProjectedSessionEntry[];
}

function contributesMessages(entry: ProjectedSessionEntry): boolean {
  return entry.messages.length > 0;
}

function startsAssistantRound(entry: ProjectedSessionEntry): boolean {
  return entry.messages.some((message) => message.role === "assistant");
}

/**
 * Fnn: an assistant reply the model actually sees again. Pi's providers drop failed and aborted
 * replies from every request, as Claude Code drops its API error messages.
 */
export function isAnsweredAssistant(message: AgentMessage): boolean {
  return message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted";
}

/** Splits the projected context into rounds. A new round starts at every assistant response. */
export function buildGroups(entries: readonly ProjectedSessionEntry[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let current: ProjectedSessionEntry[] = [];
  for (const entry of entries) {
    if (!contributesMessages(entry)) continue;
    if (startsAssistantRound(entry) && current.length > 0) {
      groups.push({ entries: current });
      current = [entry];
    } else {
      current.push(entry);
    }
  }
  if (current.length > 0) groups.push({ entries: current });
  return groups;
}

/** Summarizable messages: system snapshots are carried by the compaction entry itself, never summarized. */
export function groupMessages(groups: readonly MessageGroup[]): AgentMessage[] {
  return groups.flatMap((group) =>
    group.entries.flatMap((entry) => entry.messages.filter((message) => message.role !== "system")),
  );
}

export function groupHasAssistant(groups: readonly MessageGroup[]): boolean {
  return groups.some((group) => group.entries.some(startsAssistantRound));
}

/** First entry of the first kept group. Never a compaction entry: that one only exists as the summary. */
export function firstKeptEntryId(groups: readonly MessageGroup[], keptFrom: number): string | undefined {
  for (const group of groups.slice(keptFrom)) {
    for (const entry of group.entries) {
      if (entry.sourceEntry.type !== "compaction") return entry.sourceEntry.id;
    }
  }
  return undefined;
}

export function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateTokens(message);
  return total;
}

function stripContent<T extends TextContent | ImageContent>(
  content: T[],
): { content: (T | TextContent)[]; changed: boolean } {
  let changed = false;
  const stripped = content.map((part): T | TextContent => {
    if (part.type !== "image") return part;
    changed = true;
    return { type: "text", text: "[image]" };
  });
  return { content: stripped, changed };
}

/** cSe: replace image payloads with "[image]" after a media-size rejection. */
export function stripMedia(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (message.role === "user" || message.role === "toolResult" || message.role === "custom") {
      if (typeof message.content === "string") return message;
      const { content, changed } = stripContent(message.content);
      return changed ? ({ ...message, content } as AgentMessage) : message;
    }
    return message;
  });
}

/** iSe: drop the oldest rounds from a summarize request, enough to cover `tokenGap` (or ~20% when unknown). */
export function truncateHead(
  messages: readonly AgentMessage[],
  tokenGap: number | undefined,
  mediaStripped: boolean,
): AgentMessage[] | null {
  const body =
    messages[0]?.role === "user" && messages[0].content === TRUNCATED_HEAD_MARKER ? messages.slice(1) : messages;
  const rounds: AgentMessage[][] = [];
  let current: AgentMessage[] = [];
  for (const message of body) {
    if (message.role === "assistant" && current.length > 0) {
      rounds.push(current);
      current = [message];
    } else current.push(message);
  }
  if (current.length > 0) rounds.push(current);
  if (rounds.length < 2) return null;

  let dropCount: number;
  if (tokenGap !== undefined) {
    let dropped = 0;
    dropCount = 0;
    for (const round of rounds) {
      dropped += estimateMessagesTokens(mediaStripped ? stripMedia(round) : round);
      dropCount++;
      if (dropped >= tokenGap) break;
    }
  } else {
    dropCount = Math.max(1, Math.floor(rounds.length * 0.2));
  }
  dropCount = Math.min(dropCount, rounds.length - 1);
  if (dropCount < 1) return null;

  const rest = rounds.slice(dropCount).flat();
  if (rest[0]?.role === "assistant") {
    return [{ role: "user", content: TRUNCATED_HEAD_MARKER, timestamp: Date.now() }, ...rest];
  }
  return rest;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

type Part = TextContent | ImageContent;

class PartBuilder {
  readonly parts: Part[] = [];
  private text = "";

  appendText(text: string): void {
    this.text += text;
  }

  appendImage(image: ImageContent): void {
    if (this.text) this.parts.push({ type: "text", text: this.text });
    this.text = "";
    this.parts.push(image);
  }

  finish(): Part[] {
    if (this.text) this.parts.push({ type: "text", text: this.text });
    this.text = "";
    return this.parts;
  }
}

function appendContent(builder: PartBuilder, content: string | Part[], allowImages: boolean): void {
  if (typeof content === "string") {
    builder.appendText(content);
    return;
  }
  for (const part of content) {
    if (part.type === "text") builder.appendText(part.text);
    else if (allowImages) {
      builder.appendText("\n");
      builder.appendImage(part);
      builder.appendText("\n");
    } else builder.appendText("[image]");
  }
}

function appendTagged(
  builder: PartBuilder,
  open: string,
  close: string,
  content: string | Part[],
  allowImages: boolean,
) {
  builder.appendText(`${open}\n`);
  appendContent(builder, content, allowImages);
  builder.appendText(`\n${close}\n\n`);
}

/** Pi's LLM content for a message Pi converts into a user turn (bash executions, extension messages). */
function llmContent(message: AgentMessage): string | Part[] | undefined {
  const converted = convertToLlm([message])[0];
  return converted?.role === "user" ? converted.content : undefined;
}

function appendMessage(builder: PartBuilder, message: AgentMessage, allowImages: boolean): void {
  switch (message.role) {
    case "user":
      appendTagged(builder, "<user>", "</user>", message.content, allowImages);
      return;
    case "bashExecution": {
      // A shell command the user ran from the prompt (Claude Code's bash-mode input).
      const content = llmContent(message);
      if (content !== undefined) appendTagged(builder, "<user>", "</user>", content, allowImages);
      return;
    }
    case "assistant": {
      if (!isAnsweredAssistant(message)) return;
      const visible = message.content.filter((part) => part.type !== "thinking");
      if (visible.length === 0) return;
      builder.appendText("<assistant>\n");
      for (const part of visible) {
        if (part.type === "text") builder.appendText(`${part.text}\n`);
        else if (part.type === "toolCall") {
          builder.appendText(
            `<tool_call name="${escapeAttribute(part.name)}">${JSON.stringify(part.arguments)}</tool_call>\n`,
          );
        }
      }
      builder.appendText("</assistant>\n\n");
      return;
    }
    case "toolResult":
      appendTagged(
        builder,
        `<tool_result name="${escapeAttribute(message.toolName)}"${message.isError ? ' error="true"' : ""}>`,
        "</tool_result>",
        message.content,
        allowImages,
      );
      return;
    case "compactionSummary":
      appendTagged(builder, "<previous_summary>", "</previous_summary>", message.summary, allowImages);
      return;
    case "branchSummary":
      appendTagged(builder, "<branch_summary>", "</branch_summary>", message.summary, allowImages);
      return;
    case "custom": {
      const content = llmContent(message);
      if (content === undefined) return;
      appendTagged(
        builder,
        `<context source="${escapeAttribute(message.customType)}">`,
        "</context>",
        content,
        allowImages,
      );
      return;
    }
    default:
      // System snapshots are carried by the compaction entry and never summarized.
      return;
  }
}

/**
 * Renders the messages to summarize as one user turn: preface, full transcript (tool results are not
 * truncated, thinking and failed replies are omitted), then the compaction prompt. Images stay inline
 * unless disallowed.
 */
export function buildSummaryRequestContent(
  messages: readonly AgentMessage[],
  compactPrompt: string,
  allowImages: boolean,
): Part[] {
  const builder = new PartBuilder();
  builder.appendText(`${TRANSCRIPT_PREFACE}\n\n<transcript>\n`);
  for (const message of messages) appendMessage(builder, message, allowImages);
  builder.appendText(`</transcript>\n\n${compactPrompt}`);
  return builder.finish();
}
