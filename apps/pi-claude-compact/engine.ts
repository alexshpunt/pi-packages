// Claude Code's partial-preserve compaction engine (lSe / Dnn / Mnn / Udr / Wdr / iSe in the 2.1.296
// bundle). Summarize every round but the last; on "prompt too long" keep more trailing rounds, sized
// from the reported overage; when no round with an assistant reply is left to summarize, first try
// summarizing a large opening round on its own, then fall back to keeping only the unanswered user
// turn and trimming the head (at most 3 times).
//
// Not ported: the credits-boundary clamp (an Anthropic billing-limit error shape).

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Api, isContextOverflow, type Model, type RetryPolicy, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hasSummaryBlock } from "./prompt.ts";
import { requestSummary, type SummaryAttempt } from "./summarizer.ts";
import {
  estimateMessagesTokens,
  firstKeptEntryId,
  groupHasAssistant,
  groupMessages,
  isAnsweredAssistant,
  type MessageGroup,
  truncateHead,
} from "./transcript.ts";

export const MAX_HEAD_TRUNCATIONS = 3;
const SUBSTANTIVE_USER_TOKENS = 1_000;
/** Mnn's headroom for the post-compact restore: summary output + 5 files x 5k + 25k of skills. */
const OPENING_ROUND_RESTORE_HEADROOM = 20_000 + 5 * 5_000 + 25_000;

export interface EngineInput {
  groups: readonly MessageGroup[];
  /** Summarizer, then fallbacks used only after a non-size error. */
  models: readonly Model<Api>[];
  registry: ExtensionContext["modelRegistry"];
  customInstructions: string | undefined;
  /** Overage reported by the request that triggered this compaction (overflow recovery). */
  initialTokenGap: number | undefined;
  /** False for precompute: never trim the head in the background. */
  allowFallback: boolean;
  /**
   * Never fold a trailing tool round into a summarize-all. claude-bridge only discards a Claude Code
   * query parked at a tool boundary when the next request still carries that tool result.
   */
  keepTrailingToolRound: boolean;
  signal: AbortSignal | undefined;
  retry: RetryPolicy | undefined;
}

export type EngineFailureReason = "too_few_groups" | "aborted" | "error" | "exhausted" | "media_unstrippable";

export interface EngineSuccess {
  ok: true;
  rawSummary: string;
  usage: Usage;
  model: Model<Api>;
  /** null keeps nothing before the compaction (summarize-all). */
  firstKeptEntryId: string | null;
  /** Projected entry ids folded into the summary, in order (used to validate a precompute). */
  summarizedEntryIds: string[];
  keptMessages: AgentMessage[];
  summarizedMessages: AgentMessage[];
  headTruncated: boolean;
  attempts: number;
  groupsPreserved: number;
  totalGroups: number;
}

export interface EngineFailure {
  ok: false;
  reason: EngineFailureReason;
  attempts: number;
  detail?: string;
}

export type EngineResult = EngineSuccess | EngineFailure;

interface LastResort {
  toSummarize: AgentMessage[];
  keptMessages: AgentMessage[];
  keptEntryId: string | null;
  summarizedEntryIds: string[];
  headTruncations: number;
}

/** $nn: worth a summary request at all. */
function isSubstantive(messages: readonly AgentMessage[]): boolean {
  if (messages.some(isAnsweredAssistant)) return true;
  const users = messages.filter((message) => message.role === "user");
  return users.length > 0 && estimateMessagesTokens(users) >= SUBSTANTIVE_USER_TOKENS;
}

/** Dnn: how many trailing rounds of the summarize window cover `gap` tokens. */
export function roundsCoveringGap(sizes: readonly number[], summarizeEnd: number, gap: number): number {
  let covered = 0;
  let count = 0;
  for (let index = summarizeEnd - 1; index >= 0; index--) {
    covered += sizes[index] ?? 0;
    count++;
    if (covered >= gap) break;
  }
  if (count >= summarizeEnd - 1) return Math.max(1, Math.floor(summarizeEnd / 2));
  return count;
}

/** Mnn: the opening round alone is substantive and big enough that summarizing it closes the gap. */
function openingRoundCanCloseGap(groups: readonly MessageGroup[], sizes: readonly number[], gap: number): boolean {
  const opening = groupMessages(groups.slice(0, 1));
  const size = sizes[0] ?? 0;
  // Not when the reply to the opening round was itself a prompt-too-long failure.
  const reply = groups[1]?.entries[0]?.messages.find((message) => message.role === "assistant");
  if (reply?.role === "assistant" && reply.stopReason === "error" && isContextOverflow(reply)) return false;
  return isSubstantive(opening) && size - Math.ceil(size / 10) >= gap + OPENING_ROUND_RESTORE_HEADROOM;
}

/** Udr: why an opening-round-alone attempt is discarded (undefined: keep handling it normally). */
function openingRoundRejection(attempt: SummaryAttempt, mediaStripped: boolean): string | undefined {
  if (attempt.ok) return hasSummaryBlock(attempt.rawSummary) ? undefined : "its reply has no <summary> block";
  if (attempt.reason === "error") return "it failed";
  if (attempt.reason === "media_too_large")
    return mediaStripped ? "it hit a media-size error even stripped" : undefined;
  return undefined;
}

/** Wdr: keep the unanswered user turn after the last assistant reply, summarize everything before it. */
function lastResortSplit(
  groups: readonly MessageGroup[],
  keepTrailingToolRound: boolean,
): Omit<LastResort, "headTruncations"> {
  const entries = groups.flatMap((group) => group.entries);
  let lastReply = -1;
  let lastAnswered = -1;
  entries.forEach((entry, index) => {
    if (entry.messages.some(isAnsweredAssistant)) lastReply = index;
    if (entry.messages.some((message) => isAnsweredAssistant(message) || message.role === "toolResult")) {
      lastAnswered = index;
    }
  });
  let keepFrom = -1;
  for (let index = entries.length - 1; index > lastAnswered; index--) {
    const entry = entries[index]!;
    if (entry.sourceEntry.type === "compaction") continue;
    if (entry.messages.some((message) => message.role === "user")) {
      keepFrom = index;
      break;
    }
  }
  if (keepFrom === -1 && keepTrailingToolRound && lastReply > 0) {
    const tail = entries.slice(lastReply);
    if (tail.some((entry) => entry.messages.some((message) => message.role === "toolResult"))) keepFrom = lastReply;
  }
  const visible = (slice: typeof entries) =>
    slice.flatMap((entry) => entry.messages.filter((message) => message.role !== "system"));
  if (keepFrom === -1) {
    return {
      toSummarize: visible(entries),
      keptMessages: [],
      keptEntryId: null,
      summarizedEntryIds: entries.map((entry) => entry.sourceEntry.id),
    };
  }
  return {
    toSummarize: visible(entries.slice(0, keepFrom)),
    keptMessages: visible(entries.slice(keepFrom)),
    keptEntryId: entries[keepFrom]!.sourceEntry.id,
    summarizedEntryIds: entries.slice(0, keepFrom).map((entry) => entry.sourceEntry.id),
  };
}

function fail(reason: EngineFailureReason, attempts: number, detail?: string): EngineFailure {
  return detail === undefined ? { ok: false, reason, attempts } : { ok: false, reason, attempts, detail };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export async function runCompactionEngine(input: EngineInput): Promise<EngineResult> {
  const { groups, signal } = input;
  const total = groups.length;
  if (total < 2) return fail("too_few_groups", 0);
  if (input.models.length === 0) return fail("error", 0, "no summarization model is available");

  const sizes = groups.map((group) => estimateMessagesTokens(groupMessages([group])));

  let preserve = 1;
  let attempts = 0;
  let mediaStripped = false;
  let modelIndex = 0;
  let lastResort: LastResort | null = null;
  /** Re: overage of the last round-ladder attempt and where its summarize window ended. */
  let ladderOverage: { tokenGap: number | undefined; summarizeEnd: number } | undefined;
  /** Pe: an opening-round-alone attempt is (or was) in play. */
  let openingRound = false;
  /** Me: the last-resort overage that sent us back to the opening round. */
  let lastResortGap: number | undefined;
  /** $e: overage of the opening-round-alone attempt itself. */
  let openingRoundGap: number | undefined;

  if (input.initialTokenGap !== undefined && total > 3) {
    const gap = input.initialTokenGap - (sizes[total - 1] ?? 0);
    if (gap > 0) preserve = 1 + roundsCoveringGap(sizes, total - 1, gap);
  }

  while (true) {
    if (signal?.aborted) return fail("aborted", attempts);

    let toSummarize: AgentMessage[];
    let keptMessages: AgentMessage[];
    let keptEntryId: string | null;
    let summarizedEntryIds: string[];
    let summarizeEnd = 0;

    if (lastResort === null) {
      summarizeEnd = Math.max(0, total - preserve);
      const summarizeGroups = groups.slice(0, summarizeEnd);
      if (!groupHasAssistant(summarizeGroups) && !(openingRound && summarizeEnd === 1)) {
        if (!input.allowFallback) return fail(attempts > 0 ? "exhausted" : "too_few_groups", attempts);
        const split = lastResortSplit(groups, input.keepTrailingToolRound);
        const keptTokens = estimateMessagesTokens(split.keptMessages);
        const gaps: number[] = [];
        if (ladderOverage?.tokenGap !== undefined) {
          gaps.push(ladderOverage.tokenGap + sum(sizes.slice(ladderOverage.summarizeEnd)));
        }
        if (input.initialTokenGap !== undefined) gaps.push(input.initialTokenGap);
        if (lastResortGap !== undefined) gaps.push(lastResortGap + keptTokens);
        if (openingRoundGap !== undefined) gaps.push(openingRoundGap + sum(sizes.slice(1)));

        let headGap: { tokenGap: number | undefined } | undefined;
        if (gaps.length > 0) {
          const needed = Math.max(...gaps) - keptTokens;
          if (needed > 0) headGap = { tokenGap: needed };
        } else if (ladderOverage !== undefined) {
          headGap = { tokenGap: undefined };
        }
        if (
          headGap?.tokenGap !== undefined &&
          summarizeEnd === 1 &&
          openingRoundCanCloseGap(groups, sizes, Math.max(...gaps))
        ) {
          openingRound = true;
          continue;
        }
        const candidate =
          headGap === undefined ? split.toSummarize : truncateHead(split.toSummarize, headGap.tokenGap, mediaStripped);
        if (
          candidate === null ||
          !isSubstantive(headGap === undefined ? candidate : [...candidate, ...split.keptMessages])
        ) {
          return fail(attempts > 0 ? "exhausted" : "too_few_groups", attempts);
        }
        lastResort = { ...split, toSummarize: candidate, headTruncations: headGap === undefined ? 0 : 1 };
        continue;
      }
      toSummarize = groupMessages(summarizeGroups);
      keptMessages = groupMessages(groups.slice(summarizeEnd));
      keptEntryId = firstKeptEntryId(groups, summarizeEnd) ?? null;
      summarizedEntryIds = summarizeGroups.flatMap((group) => group.entries.map((entry) => entry.sourceEntry.id));
    } else {
      toSummarize = lastResort.toSummarize;
      keptMessages = lastResort.keptMessages;
      keptEntryId = lastResort.keptEntryId;
      summarizedEntryIds = lastResort.summarizedEntryIds;
    }

    attempts++;
    const model = input.models[modelIndex]!;
    const attempt = await requestSummary({
      registry: input.registry,
      model,
      messages: toSummarize,
      customInstructions: input.customInstructions,
      mediaStripped,
      signal,
      retry: input.retry,
    });

    if (openingRound && lastResort === null && openingRoundRejection(attempt, mediaStripped) !== undefined) {
      // The opening round alone yielded nothing usable: drop it in the last resort instead.
      preserve = total;
      continue;
    }

    if (attempt.ok) {
      return {
        ok: true,
        rawSummary: attempt.rawSummary,
        usage: attempt.usage,
        model,
        firstKeptEntryId: keptEntryId,
        summarizedEntryIds,
        keptMessages,
        summarizedMessages: toSummarize,
        headTruncated: (lastResort?.headTruncations ?? 0) > 0,
        attempts,
        groupsPreserved: lastResort === null ? total - summarizeEnd : 0,
        totalGroups: total,
      };
    }

    switch (attempt.reason) {
      case "aborted":
        return fail("aborted", attempts);
      case "error":
        if (modelIndex + 1 < input.models.length) {
          modelIndex++;
          attempts--;
          continue;
        }
        return fail("error", attempts, attempt.detail);
      case "media_too_large":
        if (!mediaStripped) {
          mediaStripped = true;
          attempts--;
          continue;
        }
        return fail("media_unstrippable", attempts);
      case "prompt_too_long":
        break;
    }

    if (lastResort !== null) {
      if (
        !openingRound &&
        lastResort.headTruncations === 0 &&
        attempt.tokenGap !== undefined &&
        openingRoundCanCloseGap(groups, sizes, attempt.tokenGap + estimateMessagesTokens(lastResort.keptMessages))
      ) {
        openingRound = true;
        lastResortGap = attempt.tokenGap;
        lastResort = null;
        preserve = total - 1;
        continue;
      }
      const trimmed: AgentMessage[] | null =
        lastResort.headTruncations < MAX_HEAD_TRUNCATIONS
          ? truncateHead(lastResort.toSummarize, attempt.tokenGap, mediaStripped)
          : null;
      if (trimmed === null || !isSubstantive([...trimmed, ...lastResort.keptMessages])) {
        return fail("exhausted", attempts);
      }
      lastResort = { ...lastResort, toSummarize: trimmed, headTruncations: lastResort.headTruncations + 1 };
      continue;
    }

    if (openingRound) openingRoundGap = attempt.tokenGap;
    else ladderOverage = { tokenGap: attempt.tokenGap, summarizeEnd };
    preserve += attempt.tokenGap === undefined ? 1 : roundsCoveringGap(sizes, summarizeEnd, attempt.tokenGap);
  }
}
