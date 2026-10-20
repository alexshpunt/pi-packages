import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { createCatalogDiagnosticsStore } from "../../src/models/catalog-diagnostics.ts";
import { createCatalogService, MODEL_FAIL_RETRY_MS, MODEL_SUCCESS_TTL_MS } from "../../src/models/catalog-service.ts";
import { assembleModels } from "../../src/models/metadata.ts";
import { withMockFetch } from "./mock-transport.ts";
import { runFeature, type VerificationFeature } from "./verification.ts";

type Refresh = (context: RefreshModelsContext) => Promise<ProviderModelConfig[]>;
const id = "glm-5.3-flash";
const raw = { capabilities: ["tools", "thinking", "vision"], model_info: { "fixture.context_length": 222222 } };
function storedModel() {
  return {
    ...assembleModels({ [id]: raw })[0],
    provider: "ollama-cloud",
    api: "openai-completions",
    baseUrl: "https://ollama.com/v1",
  };
}

export async function assertRestoredCatalogPolicy(refresh: Refresh) {
  const controller = new AbortController();
  try {
    const [model] = await refresh({
      allowNetwork: false,
      signal: controller.signal,
      publish: async () => true,
      stored: {
        checkedAt: 1,
        models: [
          {
            ...storedModel(),
            maxTokens: 17,
            cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 },
            compat: { supportsStore: true },
          },
        ],
      },
    });
    assert.ok(model && "maxTokens" in model);
    assert.equal(model.maxTokens, 524288);
    assert.equal(model.contextWindow, 222222);
    assert.deepEqual(model.input, ["text", "image"]);
    assert.deepEqual(model.cost, storedModel().cost);
    assert.deepEqual(model.compat, storedModel().compat);
  } finally {
    controller.abort();
  }
}
export async function assertPartialKeepsTimestamp(refresh: Refresh) {
  const controller = new AbortController();
  const checkedAt = Date.now() - 5 * 60 * 60_000;
  let attemptedCheckedAt: number | undefined;
  try {
    await withMockFetch(
      async (url, init) => {
        if (String(url).endsWith("/v1/models")) return Response.json({ data: [{ id }, { id: "failed-model" }] });
        const body = JSON.parse(String(init?.body)) as { model: string };
        return body.model === id ? Response.json(raw) : new Response("fixture error", { status: 500 });
      },
      async () => {
        await assert.rejects(
          refresh({
            allowNetwork: true,
            signal: controller.signal,
            stored: { checkedAt, models: [storedModel()] },
            publish: async (publication) => {
              if (publication.persist) attemptedCheckedAt = publication.persist.checkedAt;
              publication.update?.();
              return true;
            },
          }),
          /incomplete/,
        );
        assert.ok(
          attemptedCheckedAt === undefined || attemptedCheckedAt === checkedAt,
          "Partial failure advanced the success timestamp",
        );
      },
    );
  } finally {
    controller.abort();
  }
}

export const catalogFeature: VerificationFeature = {
  id: "04-catalog-cache",
  cli: "scripts/cli/catalog.ts",
  shared: ["src/models/catalog-service.ts", "src/models/catalog-diagnostics.ts", "src/models/snapshot.ts"],
  consumers: ["src/models/catalog.ts", "src/index.ts"],
  async verify({ check }) {
    const temp = mkdtempSync(join(tmpdir(), "ollama-catalog-"));
    let timeMs = 86_400_000;
    let mode: "success" | "partial" | "failure" | "empty" | "abort" = "success";
    let publicationMode: "accept" | "reject" | "throw" = "accept";
    let stored: ModelsStoreEntry | undefined;
    let listCalls = 0;
    let detailCalls = 0;
    const store = createCatalogDiagnosticsStore(join(temp, "diagnostics.json"));
    const service = createCatalogService({
      diagnostics: store,
      now: () => timeMs,
      fetchIds: async (signal) => {
        listCalls += 1;
        if (mode === "abort")
          return new Promise<string[]>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new DOMException("fixture", "AbortError")), { once: true });
          });
        return mode === "empty" ? [] : [id, "beam"];
      },
      fetchDetails: async (modelId) => {
        detailCalls += 1;
        if (mode === "failure" || (mode === "partial" && modelId === "beam")) throw new Error("fixture request failed");
        return { ...raw, thinking: { values: [false, "low", "high", "max"], default: "high" } };
      },
    });
    const controller = new AbortController();
    const context = (force = false, allowNetwork = true, signal = controller.signal): RefreshModelsContext => ({
      allowNetwork,
      force,
      signal,
      stored,
      publish: async (publication) => {
        if (publicationMode === "reject" || signal.aborted) return false;
        if (publicationMode === "throw") throw new Error("fixture store failure");
        if (publication.persist) {
          assert.deepEqual(Object.keys(publication.persist).sort(), ["checkedAt", "models"]);
          stored = structuredClone(publication.persist);
        }
        publication.update?.();
        return true;
      },
    });
    try {
      await check("구버전 snapshot의 동적 context/input과 최신 로컬 정책 적용", async () => {
        await assertRestoredCatalogPolicy(service.refresh);
      });
      await check("cold/warm/force와 정확한 4시간 성공 TTL", async () => {
        await service.refresh(context());
        assert.equal(listCalls, 1);
        assert.equal(detailCalls, 2);
        await service.refresh(context(false, false));
        await service.refresh(context());
        assert.equal(listCalls, 1);
        await service.refresh(context(true));
        assert.equal(listCalls, 2);
        timeMs += MODEL_SUCCESS_TTL_MS + 1;
        await service.refresh(context());
        assert.equal(listCalls, 3);
      });
      await check("부분 실패는 정상 checkedAt을 유지하고 15분 후 재시도", async () => {
        const lastGoodAt = stored?.checkedAt;
        timeMs += MODEL_SUCCESS_TTL_MS + 1;
        mode = "partial";
        await assert.rejects(service.refresh(context()), /incomplete/);
        assert.equal(stored?.checkedAt, lastGoodAt);
        assert.equal(service.getDiagnostics()?.failures[0].id, "beam");
        assert.equal(service.getDiagnostics()?.nextRetryAtMs, timeMs + MODEL_FAIL_RETRY_MS);
        const before = listCalls;
        await service.refresh(context());
        assert.equal(listCalls, before);
        timeMs += MODEL_FAIL_RETRY_MS + 1;
        mode = "success";
        await service.refresh(context());
        assert.equal(listCalls, before + 1);
      });
      await check("전체 실패·빈 목록도 별도 실패 간격을 적용하며 force로 우회", async () => {
        mode = "failure";
        await assert.rejects(service.refresh(context(true)), /Failed to fetch model details/);
        const before = listCalls;
        await service.refresh(context());
        assert.equal(listCalls, before);
        mode = "empty";
        assert.ok((await service.refresh(context(true))).length > 0);
        assert.equal(service.getDiagnostics()?.status, "empty");
        mode = "success";
        await service.refresh(context(true));
      });
      await check("저장 실패와 superseded publish는 마지막 정상 snapshot을 훼손하지 않음", async () => {
        const original = structuredClone(stored);
        publicationMode = "throw";
        assert.ok((await service.refresh(context(true))).length > 0);
        assert.deepEqual(stored, original);
        assert.equal(service.getDiagnostics()?.persistence, "failed");
        publicationMode = "reject";
        assert.ok((await service.refresh(context(true))).length > 0);
        assert.deepEqual(stored, original);
        publicationMode = "accept";
      });
      await check("취소는 실패 cooldown을 만들지 않고 즉시 다음 요청을 허용", async () => {
        timeMs += MODEL_SUCCESS_TTL_MS + 1;
        mode = "abort";
        const cancellation = new AbortController();
        try {
          const pending = service.refresh(context(false, true, cancellation.signal));
          cancellation.abort();
          assert.ok((await pending).length > 0);
        } finally {
          cancellation.abort();
        }
        const before = listCalls;
        mode = "success";
        await service.refresh(context());
        assert.equal(listCalls, before + 1);
        const diagnostics: unknown = JSON.parse(readFileSync(join(temp, "diagnostics.json"), "utf8"));
        assert.ok(diagnostics && typeof diagnostics === "object" && !("models" in diagnostics));
      });
    } finally {
      controller.abort();
      rmSync(temp, { recursive: true, force: true });
    }
  },
};
runFeature(import.meta.url, catalogFeature);
