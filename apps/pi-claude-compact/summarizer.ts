import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  type Context,
  isContextOverflow,
  type Model,
  type RetryPolicy,
  retryAssistantCall,
  type Usage,
  uuidv7,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildCompactPrompt, SUMMARIZER_SYSTEM_PROMPT } from "./prompt.ts";
import { outputReserveTokens } from "./thresholds.ts";
import { buildSummaryRequestContent, stripMedia } from "./transcript.ts";

export type SummaryAttempt =
  | { ok: true; rawSummary: string; usage: Usage }
  | { ok: false; reason: "prompt_too_long"; tokenGap: number | undefined }
  | { ok: false; reason: "media_too_large" }
  | { ok: false; reason: "aborted" }
  | { ok: false; reason: "error"; detail: string };

export interface SummaryRequest {
  registry: ExtensionContext["modelRegistry"];
  model: Model<Api>;
  messages: readonly AgentMessage[];
  customInstructions: string | undefined;
  mediaStripped: boolean;
  signal: AbortSignal | undefined;
  retry: RetryPolicy | undefined;
}

interface TokenOverage {
  actual: number;
  limit: number;
}

/** Claude Code's uze() plus the OpenAI and Gemini wordings of the same error. */
export function parseTokenOverage(text: string): TokenOverage | undefined {
  const anthropic = text.match(/prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i);
  if (anthropic) return { actual: Number(anthropic[1]), limit: Number(anthropic[2]) };
  const openai = text.match(/maximum context length is (\d+) tokens[\s\S]*?(?:resulted in|requested) (\d+) tokens/i);
  if (openai) return { actual: Number(openai[2]), limit: Number(openai[1]) };
  const gemini = text.match(/input token count \(?(\d+)\)?[^0-9]*exceeds[^0-9]*\(?(\d+)\)?/i);
  if (gemini) return { actual: Number(gemini[1]), limit: Number(gemini[2]) };
  return undefined;
}

export function tokenGapFromError(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const overage = parseTokenOverage(text);
  if (!overage) return undefined;
  const gap = overage.actual - overage.limit;
  return gap > 0 ? gap : undefined;
}

const PROMPT_TOO_LONG = /prompt is too long|context length|context window|too many (input )?tokens|token count/i;

/** Claude Code's fde/Qio plus the plain-text wordings other providers use. */
export function isMediaTooLarge(text: string): boolean {
  if (/request_too_large|image_block|document_block|media_budget/i.test(text)) return true;
  return /\b(image|media|document|pdf)\b/i.test(text) && /(too large|exceed|maximum|dimension|size)/i.test(text);
}

function responseText(response: AssistantMessage): string {
  return response.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function classify(response: AssistantMessage, model: Model<Api>, signal: AbortSignal | undefined): SummaryAttempt {
  if (signal?.aborted || response.stopReason === "aborted") return { ok: false, reason: "aborted" };
  const text = responseText(response);
  if (response.stopReason === "error") {
    const detail = response.errorMessage ?? "summarization request failed";
    if (isContextOverflow(response, model.contextWindow) || PROMPT_TOO_LONG.test(detail)) {
      return { ok: false, reason: "prompt_too_long", tokenGap: tokenGapFromError(detail) };
    }
    if (isMediaTooLarge(detail)) return { ok: false, reason: "media_too_large" };
    return { ok: false, reason: "error", detail };
  }
  // cke: any non-empty reply text is the summary, as in Claude Code (no truncation check).
  if (!text) {
    if (response.stopReason === "length" && isContextOverflow(response, model.contextWindow)) {
      return { ok: false, reason: "prompt_too_long", tokenGap: undefined };
    }
    return { ok: false, reason: "error", detail: "summarization produced an empty response" };
  }
  return { ok: true, rawSummary: text, usage: response.usage };
}

/** One summarization call (Claude Code's Ndr): transcript + compaction prompt, no tools, no cache write. */
export async function requestSummary(request: SummaryRequest): Promise<SummaryAttempt> {
  const { model, signal } = request;
  const messages = request.mediaStripped ? stripMedia(request.messages) : request.messages;
  // claude-bridge's one-off summary path forwards text only, so images become explicit placeholders.
  const allowImages = !request.mediaStripped && model.input.includes("image") && model.baseUrl !== "claude-bridge";
  const context: Context = {
    systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildSummaryRequestContent(messages, buildCompactPrompt(request.customInstructions), allowImages),
        timestamp: Date.now(),
      },
    ],
  };
  try {
    const response = await retryAssistantCall(
      () =>
        request.registry
          .streamSimple(model, context, {
            maxTokens: outputReserveTokens(model.maxTokens),
            signal,
            cacheRetention: "none",
            sessionId: uuidv7(),
          })
          .result(),
      request.retry,
      signal,
    );
    return classify(response, model, signal);
  } catch (error) {
    if (signal?.aborted) return { ok: false, reason: "aborted" };
    const detail = error instanceof Error ? error.message : String(error);
    if (PROMPT_TOO_LONG.test(detail))
      return { ok: false, reason: "prompt_too_long", tokenGap: tokenGapFromError(detail) };
    if (isMediaTooLarge(detail)) return { ok: false, reason: "media_too_large" };
    return { ok: false, reason: "error", detail };
  }
}
