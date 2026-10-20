import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { GENERATED_CATALOG_INFO, GENERATED_MODELS } from "../generated/catalog.generated.ts";
import { envInt } from "../shared/http.ts";
import { collectModelDetails, fetchModelDetails, fetchModelIds, modelFailureReason } from "./api.ts";
import { OLLAMA_BASE } from "./base.ts";
import type { CatalogDiagnostics, CatalogDiagnosticsStore } from "./catalog-diagnostics.ts";
import { assembleModels, resolveModelMetadata } from "./metadata.ts";
import { restoreModelPolicies } from "./snapshot.ts";

export const MODEL_SUCCESS_TTL_MS = 4 * 60 * 60_000;
export const MODEL_FAIL_RETRY_MS = envInt("PI_OLLAMA_MODEL_FAIL_RETRY_MINUTES", 15) * 60_000;
export interface CatalogOptions {
  diagnostics: CatalogDiagnosticsStore;
  now?: () => number;
  failureRetryMs?: number;
  fetchIds?: typeof fetchModelIds;
  fetchDetails?: typeof fetchModelDetails;
}
export function createCatalogService(options: CatalogOptions) {
  const now = options.now ?? Date.now;
  const retryMs = options.failureRetryMs ?? MODEL_FAIL_RETRY_MS;
  const fetchIds = options.fetchIds ?? fetchModelIds;
  let state: CatalogDiagnostics | undefined;
  let generation = 0;
  function record(next: CatalogDiagnostics) {
    state = next;
    options.diagnostics.write(next);
  }
  return {
    getDiagnostics: () => state ?? options.diagnostics.read(),
    async refresh(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
      const disk = options.diagnostics.read();
      if (disk && (!state || (disk.lastAttemptAtMs ?? 0) > (state.lastAttemptAtMs ?? 0))) state = disk;
      const isKnownSnapshot =
        state?.snapshotCheckedAtMs !== undefined && state.snapshotCheckedAtMs === context.stored?.checkedAt;
      const restored = restoreModelPolicies(
        context.stored?.models ?? [],
        isKnownSnapshot ? state?.nativeThinkingIds : [],
      );
      const fallback = restored.length
        ? restored
        : restoreModelPolicies(GENERATED_MODELS, GENERATED_CATALOG_INFO.nativeThinkingIds);
      const source = restored.length ? "stored" : "generated";
      state = {
        schemaVersion: 1,
        policyVersion: 1,
        status: "restored",
        nativeThinkingIds: [],
        failures: [],
        ...state,
        source,
      };
      if (!context.allowNetwork || context.signal.aborted) return fallback;
      const timeMs = now();
      if (!context.force) {
        const hasFailure =
          ["partial", "failure", "empty"].includes(state.status) &&
          (state.lastAttemptAtMs ?? 0) >= (context.stored?.checkedAt ?? 0);
        if (
          hasFailure &&
          state.lastAttemptAtMs !== undefined &&
          state.lastAttemptAtMs <= timeMs &&
          state.lastAttemptAtMs >= (context.stored?.checkedAt ?? 0) &&
          (state.nextRetryAtMs ?? 0) > timeMs
        )
          return fallback;
        const checkedAt = context.stored?.checkedAt;
        if (!hasFailure && checkedAt !== undefined && checkedAt <= timeMs && timeMs - checkedAt < MODEL_SUCCESS_TTL_MS)
          return fallback;
      }
      const requestGeneration = ++generation;
      const isCurrent = () => !context.signal.aborted && requestGeneration === generation;
      const prior = state;
      const failure = async (status: "partial" | "failure" | "empty", failures: CatalogDiagnostics["failures"]) => {
        if (!isCurrent()) return;
        try {
          await context.publish({
            update: () => {
              if (isCurrent())
                record({
                  ...prior,
                  source,
                  status,
                  lastAttemptAtMs: timeMs,
                  lastSuccessAtMs: prior.lastSuccessAtMs ?? context.stored?.checkedAt,
                  nextRetryAtMs: timeMs + retryMs,
                  failures,
                  persistence: "unchanged",
                });
            },
          });
        } catch {
          // Diagnostics are best effort, never replace the last-good catalog.
          if (isCurrent())
            record({
              ...prior,
              source,
              status,
              lastAttemptAtMs: timeMs,
              nextRetryAtMs: timeMs + retryMs,
              failures,
              persistence: "unchanged",
            });
        }
      };
      let ids: string[];
      try {
        ids = await fetchIds(context.signal);
      } catch (error) {
        if (!isCurrent()) return fallback;
        await failure("failure", [{ reason: modelFailureReason(error) }]);
        throw error;
      }
      if (!isCurrent()) return fallback;
      const result = await collectModelDetails(ids, context.signal, options.fetchDetails ?? fetchModelDetails);
      if (!isCurrent()) return fallback;
      if (result.failures.length > 0) {
        const isPartial = Object.keys(result.models).length > 0;
        await failure(isPartial ? "partial" : "failure", result.failures);
        throw new Error(
          isPartial
            ? `Ollama Cloud catalog refresh incomplete: ${result.failures.length} model(s) failed; retry after ${retryMs}ms.`
            : `Failed to fetch model details (${result.failures.length} failed); retry after ${retryMs}ms.`,
        );
      }
      const models = assembleModels(result.models);
      if (models.length === 0) {
        await failure("empty", [{ reason: "No tools-capable models returned." }]);
        return fallback;
      }
      const persisted = models.map((model) => ({
        ...model,
        provider: "ollama-cloud",
        api: "openai-completions",
        baseUrl: `${OLLAMA_BASE}/v1`,
      }));
      const checkedAt = now();
      const nativeThinkingIds = Object.entries(result.models)
        .filter(([id, raw]) => resolveModelMetadata(id, raw).sources.thinking === "api")
        .map(([id]) => id);
      try {
        const accepted = await context.publish({
          persist: { models: persisted, checkedAt },
          update: () => {
            if (isCurrent())
              record({
                schemaVersion: 1,
                policyVersion: 1,
                source: "live",
                status: "success",
                lastAttemptAtMs: timeMs,
                lastSuccessAtMs: checkedAt,
                snapshotCheckedAtMs: checkedAt,
                nativeThinkingIds,
                failures: [],
                persistence: "saved",
              });
          },
        });
        if (!accepted || !isCurrent()) return fallback;
      } catch {
        if (!isCurrent()) return fallback;
        record({
          ...prior,
          source: "live",
          status: "success",
          lastAttemptAtMs: timeMs,
          lastSuccessAtMs: checkedAt,
          failures: [],
          persistence: "failed",
        });
      }
      return persisted;
    },
  };
}
