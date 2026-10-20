import { concurrentMap } from "../shared/concurrent.ts";
import { fetchJsonWithTimeout } from "../shared/http.ts";
import { OLLAMA_BASE } from "./base.ts";
import { isOllamaShowResponse, isRecord, type OllamaShowResponse } from "./types.ts";

const FETCH_TIMEOUT_MS = 10000;
// --- Fetch Models ---
export async function fetchModelIds(signal?: AbortSignal, timeoutMs = FETCH_TIMEOUT_MS): Promise<string[]> {
  const headers: Record<string, string> = {};
  const apiKey = process.env.OLLAMA_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const res = await fetchJsonWithTimeout<unknown>(`${OLLAMA_BASE}/v1/models`, { headers }, timeoutMs, signal);

  if (res.status === 429) {
    throw new Error("Ollama Cloud model list fetch rate limited. Try again shortly.");
  }
  if (!res.ok) {
    if (res.status === 0) {
      throw new Error(
        `Ollama Cloud model list fetch failed: transport error (${res.error ?? "unknown"}). Try again shortly.`,
      );
    }
    throw new Error(`Failed to fetch model list: ${res.status}${res.error ? ` - ${res.error}` : ""}`);
  }
  if (!isRecord(res.data) || !Array.isArray(res.data.data)) {
    throw new Error("Failed to fetch model list: unexpected response shape (expected a data array).");
  }
  const ids: string[] = [];
  for (const [index, model] of res.data.data.entries()) {
    if (!isRecord(model) || typeof model.id !== "string" || model.id.trim() !== model.id || model.id === "") {
      throw new Error(`Failed to fetch model list: invalid model ID at data[${index}].`);
    }
    ids.push(model.id);
  }
  return ids;
}

export async function fetchModelDetails(
  id: string,
  signal?: AbortSignal,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<OllamaShowResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = process.env.OLLAMA_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const res = await fetchJsonWithTimeout<unknown>(
    `${OLLAMA_BASE}/api/show`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ model: id }),
    },
    timeoutMs,
    signal,
  );

  if (res.status === 429) {
    throw new Error("Ollama Cloud /api/show rate limited. Try again shortly.");
  }
  if (!res.ok) {
    if (res.status === 0) {
      throw new Error(
        `Ollama Cloud /api/show for ${id} failed: transport error (${res.error ?? "unknown"}). Try again shortly.`,
      );
    }
    throw new Error(`Failed to fetch /api/show for ${id}: ${res.status}${res.error ? ` - ${res.error}` : ""}`);
  }
  if (!isOllamaShowResponse(res.data)) {
    throw new Error(
      `Failed to fetch /api/show for ${id}: unexpected response shape (expected string capabilities and model_info object).`,
    );
  }
  return res.data;
}

/**
 * Fetch per-model /api/show details for a list of model IDs, 8 workers at a time.
 * Returns the models that succeeded. Throws when every detail request fails
 * (the zero-succeeded case), so the caller can surface a real failure instead
 * of an empty catalog.
 */
export async function refreshOllamaCloudModels(
  modelIds: string[],
  signal?: AbortSignal,
): Promise<{ models: Record<string, OllamaShowResponse>; failed: number }> {
  const result = await collectModelDetails(modelIds, signal);
  if (Object.keys(result.models).length === 0) {
    throw new Error(
      `Failed to fetch model details${result.failures.length ? ` (${result.failures.length} failed)` : ""}`,
    );
  }
  return { models: result.models, failed: result.failures.length };
}

export interface ModelDetailFailure {
  id: string;
  reason: string;
}

/** Fixed diagnostic categories, never server bodies or authentication data. */
export function modelFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/rate limited|429/.test(message)) return "rate limited";
  if (/transport error/.test(message)) return "transport error";
  if (/response shape|Invalid.*response/.test(message)) return "invalid response shape";
  if (/401|403/.test(message)) return "authentication failed";
  return "request failed";
}

export async function collectModelDetails(
  modelIds: string[],
  signal?: AbortSignal,
  fetchDetails: typeof fetchModelDetails = fetchModelDetails,
): Promise<{ models: Record<string, OllamaShowResponse>; failures: ModelDetailFailure[] }> {
  const results = await concurrentMap(modelIds, 8, async (id) => [id, await fetchDetails(id, signal)] as const);
  const succeeded: [string, OllamaShowResponse][] = [];
  const failures: ModelDetailFailure[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") succeeded.push([...result.value]);
    else failures.push({ id: modelIds[index], reason: modelFailureReason(result.reason) });
  }
  return { models: Object.fromEntries(succeeded), failures };
}
