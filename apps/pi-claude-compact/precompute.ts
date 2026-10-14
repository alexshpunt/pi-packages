// Claude Code's precomputed compaction (VXr / KXr / $xr): summarize in the background once context
// passes the precompute threshold, then reuse the result at the threshold if the conversation it
// summarized is still the head of the context, unchanged. The engine runs without head trimming.

import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, RetryPolicy } from "@earendil-works/pi-ai";
import type { ExtensionContext, ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { type EngineSuccess, runCompactionEngine } from "./engine.ts";
import { PRECOMPUTE_FAILURE_LIMIT, type PrecomputeJob, type SessionRuntime } from "./session-state.ts";
import { buildGroups } from "./transcript.ts";

export function latestCompactionId(entries: readonly ProjectedSessionEntry[]): string | null {
  const first = entries[0]?.sourceEntry;
  return first?.type === "compaction" ? first.id : null;
}

/**
 * Hash of what the model sees for these entries. Pi applies context edits by replacing projected
 * content under the same entry id, so ids alone cannot tell whether summarized content changed.
 */
export function projectedFingerprint(entries: readonly ProjectedSessionEntry[], ids: readonly string[]): string {
  const wanted = new Set(ids);
  const hash = createHash("sha256");
  for (const entry of entries) {
    if (!wanted.has(entry.sourceEntry.id)) continue;
    hash.update(entry.sourceEntry.id);
    hash.update(JSON.stringify(entry.messages));
  }
  return hash.digest("hex");
}

export interface PrecomputeStart {
  entries: readonly ProjectedSessionEntry[];
  models: readonly Model<Api>[];
  registry: ExtensionContext["modelRegistry"];
  retry: RetryPolicy | undefined;
}

export function startPrecompute(runtime: SessionRuntime, start: PrecomputeStart): void {
  const existing = runtime.precompute;
  if (existing && !(existing.result && !existing.result.ok)) return;
  if (runtime.precomputeFailures >= PRECOMPUTE_FAILURE_LIMIT) return;
  const groups = buildGroups(start.entries);
  if (groups.length < 2) return;
  const controller = new AbortController();
  const snapshot = [...start.entries];
  const job: PrecomputeJob = {
    anchorCompactionId: latestCompactionId(start.entries),
    controller,
    promise: Promise.resolve({ ok: false, reason: "aborted", attempts: 0 }),
    result: undefined,
    fingerprint: undefined,
  };
  job.promise = runCompactionEngine({
    groups,
    models: start.models,
    registry: start.registry,
    customInstructions: undefined,
    initialTokenGap: undefined,
    allowFallback: false,
    keepTrailingToolRound: false,
    signal: controller.signal,
    retry: start.retry,
  })
    .catch((error: unknown) => ({
      ok: false as const,
      reason: "error" as const,
      attempts: 0,
      detail: error instanceof Error ? error.message : String(error),
    }))
    .then((result) => {
      job.result = result;
      if (result.ok) {
        job.fingerprint = projectedFingerprint(snapshot, result.summarizedEntryIds);
        runtime.precomputeFailures = 0;
      } else if (result.reason !== "aborted" && result.reason !== "too_few_groups") {
        runtime.precomputeFailures++;
      }
      return result;
    });
  runtime.precompute = job;
}

export type PrecomputeTake =
  | { ok: true; result: EngineSuccess; keptMessages: AgentMessage[] }
  | { ok: false; reason: "none" | "stale" | "failed" | "aborted" };

function waitOrAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolvePromise) => {
    const onAbort = () => resolvePromise(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then((value) => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise(value);
    });
  });
}

/**
 * Consumes the job (it is never reused twice). Valid only when the summarized entries are still, in
 * order and with the same projected content, the head of the context and the kept boundary follows.
 */
export async function takePrecompute(
  runtime: SessionRuntime,
  entries: readonly ProjectedSessionEntry[],
  signal: AbortSignal | undefined,
): Promise<PrecomputeTake> {
  const job = runtime.precompute;
  if (!job) return { ok: false, reason: "none" };
  runtime.precompute = undefined;
  if (signal?.aborted) {
    job.controller.abort();
    return { ok: false, reason: "aborted" };
  }
  if (job.anchorCompactionId !== latestCompactionId(entries)) {
    job.controller.abort();
    return { ok: false, reason: "stale" };
  }
  const result = job.result ?? (await waitOrAbort(job.promise, signal));
  if (result === undefined) {
    job.controller.abort();
    return { ok: false, reason: "aborted" };
  }
  if (!result.ok || result.firstKeptEntryId === null) return { ok: false, reason: "failed" };

  const current = entries.filter((entry) => entry.messages.length > 0);
  const summarized = result.summarizedEntryIds;
  const headMatches = summarized.every((id, index) => current[index]?.sourceEntry.id === id);
  if (!headMatches || current[summarized.length]?.sourceEntry.id !== result.firstKeptEntryId) {
    return { ok: false, reason: "stale" };
  }
  if (job.fingerprint !== projectedFingerprint(current, summarized)) return { ok: false, reason: "stale" };
  const keptMessages = current
    .slice(summarized.length)
    .flatMap((entry) => entry.messages.filter((message) => message.role !== "system"));
  return { ok: true, result, keptMessages };
}
