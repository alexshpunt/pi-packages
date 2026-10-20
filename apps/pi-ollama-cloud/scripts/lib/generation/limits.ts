import { isRecord } from "../../../src/models/types.ts";
import { concurrentMap } from "../../../src/shared/concurrent.ts";
import { fetchJsonWithTimeout } from "../../../src/shared/http.ts";
import { isSafeModelId } from "./parsers.ts";

const PROBE_TIERS = [65536, 131072, 262144, 524288];
const PROBE_TIMEOUT_MS = 60000;
export interface LimitMeasurement {
  limit: number;
  kind: "exact" | "lower-bound";
}
export type LimitProbe = (id: string, signal?: AbortSignal) => Promise<LimitMeasurement | undefined>;
export async function probeMaxTokens(
  id: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<LimitMeasurement | undefined> {
  for (const tier of PROBE_TIERS) {
    signal?.throwIfAborted();
    const response = await fetchJsonWithTimeout<unknown>(
      "https://ollama.com/v1/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: id,
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
          max_tokens: tier,
          stop: ["OK"],
        }),
      },
      PROBE_TIMEOUT_MS,
      signal,
    );
    signal?.throwIfAborted();
    if (response.ok) {
      if (
        !isRecord(response.data) ||
        !Array.isArray(response.data.choices) ||
        !response.data.choices.length ||
        !response.data.choices.every((choice: unknown) => isRecord(choice) && isRecord(choice.message))
      )
        return undefined;
      continue;
    }
    const match = response.status === 400 ? /maximum output tokens \((\d+)\)/.exec(response.error ?? "") : null;
    const limit = match ? Number(match[1]) : undefined;
    return limit !== undefined && Number.isSafeInteger(limit) && limit > 0 && limit < tier
      ? { limit, kind: "exact" }
      : undefined;
  }
  return { limit: PROBE_TIERS[PROBE_TIERS.length - 1], kind: "lower-bound" };
}
export interface GeneratedLimits {
  limits: Record<string, number>;
  info: {
    measurementStartedAt: string;
    requestedIds: string[];
    measurements: Record<string, LimitMeasurement>;
    preservedIds: string[];
    unknownIds: string[];
  };
}
export async function collectLimits(
  ids: readonly string[],
  existing: Readonly<Record<string, number>>,
  probe: LimitProbe,
  signal?: AbortSignal,
  measurementStartedAt = new Date().toISOString(),
): Promise<GeneratedLimits> {
  signal?.throwIfAborted();
  if (!ids.length || ids.some((id) => !isSafeModelId(id)) || new Set(ids).size !== ids.length)
    throw new Error("Empty or invalid limit probe list; refusing to write.");
  if (Object.values(existing).some((value) => !Number.isSafeInteger(value) || value <= 0))
    throw new Error("Invalid existing output limits.");
  const results = await concurrentMap([...ids], 8, (id) => probe(id, signal));
  signal?.throwIfAborted();
  const limits = { ...existing };
  const measurements: Record<string, LimitMeasurement> = {};
  const preservedIds: string[] = [];
  const unknownIds: string[] = [];
  for (const [index, result] of results.entries()) {
    const id = ids[index];
    const value = result.status === "fulfilled" ? result.value : undefined;
    if (
      value &&
      Number.isSafeInteger(value.limit) &&
      value.limit > 0 &&
      ["exact", "lower-bound"].includes(value.kind)
    ) {
      limits[id] = value.limit;
      measurements[id] = value;
    } else if (Object.hasOwn(existing, id)) preservedIds.push(id);
    else unknownIds.push(id);
  }
  if (!Object.keys(measurements).length)
    throw new Error("No usable probe data; refusing to write limits.generated.ts.");
  return {
    limits,
    info: {
      measurementStartedAt,
      requestedIds: [...ids].sort(),
      measurements,
      preservedIds: preservedIds.sort(),
      unknownIds: unknownIds.sort(),
    },
  };
}
