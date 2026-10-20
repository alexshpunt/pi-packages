import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fetchModelIds, refreshOllamaCloudModels } from "../../src/models/api.ts";
import { assembleModels, resolveModelMetadata } from "../../src/models/metadata.ts";
import { isRecord } from "../../src/models/types.ts";
import { chatResponse, withMockFetch } from "./mock-transport.ts";
import { runFeature, type VerificationFeature } from "./verification.ts";

export async function showModelMetadata(signal: AbortSignal): Promise<void> {
  const ids = await fetchModelIds(signal);
  const { models: raw, failed } = await refreshOllamaCloudModels(ids, signal);
  const metadata = Object.entries(raw).map(([id, data]) => resolveModelMetadata(id, data));
  console.log(
    `전체 ${ids.length}개 / 채팅 후보 ${metadata.filter((m) => m.isChatCandidate).length}개 / 조회 실패 ${failed}개`,
  );
  for (const model of metadata) {
    console.log(
      JSON.stringify({
        id: model.requestedId,
        metadataId: model.metadataId,
        chat: model.isChatCandidate,
        reason: model.exclusionReason,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        price: model.sources.price === "unknown" ? "unknown (not free)" : model.cost,
        sources: model.sources,
        thinking: model.thinking,
      }),
    );
  }
}

export const modelsFeature: VerificationFeature = {
  id: "03-model-metadata",
  cli: "scripts/cli/models.ts",
  shared: ["src/models/metadata.ts", "src/models/thinking-levels.ts", "src/models/types.ts"],
  consumers: ["models.ts", "src/models/catalog.ts", "src/pi/chat.ts"],
  async verify({ check }) {
    const fixture: unknown = JSON.parse(
      readFileSync(new URL("../../test/fixtures/models/live-2026-10-18.json", import.meta.url), "utf8"),
    );
    assert.ok(isRecord(fixture) && isRecord(fixture.models));
    const raw = fixture.models;
    await check("전체 모델 목록과 tools 채팅 후보를 구분하고 필드별 출처를 표시", async () => {
      const all = Object.entries(raw).map(([id, data]) => resolveModelMetadata(id, data));
      assert.equal(all.length, 6);
      assert.equal(all.find((m) => m.requestedId === "clef:27b")?.isChatCandidate, false);
      assert.equal(assembleModels(raw).length, 5);
      for (const id of ["beam", "muse-spark-open", "deepseek-v4.1-flash:1017", "glm-5.3-flash:cloud"]) {
        const metadata = resolveModelMetadata(id, raw[id]);
        assert.equal(metadata.sources.price, "unknown");
        assert.equal(metadata.sources.maxTokens, "fallback");
        assert.equal(metadata.maxTokens, 32768);
        assert.equal(metadata.sources.contextWindow, "api");
        assert.equal(metadata.sources.thinking, "api");
        assert.equal(metadata.metadataId, id);
      }
      assert.equal(resolveModelMetadata("glm-5.3-flash", raw["glm-5.3-flash"]).maxTokens, 524288);
    });
    await check("알 수 없는 thinking·잘못된 형식·기존 입력·off 예외의 안전한 처리", async () => {
      const future = resolveModelMetadata("future", {
        capabilities: ["tools", "thinking"],
        thinking: { values: ["future-effort"], default: "future-effort" },
      });
      assert.equal(future.sources.thinking, "fallback");
      assert.ok(future.thinking.warnings.length > 0);
      const invalid = resolveModelMetadata("future", {
        capabilities: ["tools", "thinking"],
        thinking: { values: [42] },
      });
      assert.equal(invalid.sources.thinking, "fallback");
      assert.equal(resolveModelMetadata("constructor", { capabilities: ["tools"] }).maxTokens, 32768);
      const legacy = resolveModelMetadata("glm-5.3-flash", { capabilities: ["tools", "thinking"] });
      assert.notEqual(legacy.sources.thinking, "api");
      for (const id of ["gpt-oss:120b", "minimax-m2.7", "minimax-m2.7:cloud"]) {
        const model = resolveModelMetadata(id, {
          capabilities: ["tools", "thinking"],
          thinking: { values: [false, "low", "high"] },
        });
        assert.equal(model.thinking.map?.off, null);
      }
      const glm = resolveModelMetadata("glm-5.3-flash", raw["glm-5.3-flash"]);
      assert.equal(glm.thinking.map?.medium, null);
      assert.equal(glm.thinking.map?.off, null);
      assert.equal(glm.thinking.nativeDefault, "max");
    });
    await check("실제 Pi 최종 payload의 요청 ID·caller effort·compat·토큰 상한", async () => {
      const temp = mkdtempSync(join(tmpdir(), "ollama-model-metadata-"));
      try {
        const runtime = await ModelRuntime.create({
          authPath: join(temp, "auth.json"),
          modelsPath: null,
          refreshOnCreate: false,
        });
        runtime.registerProvider("ollama-cloud", {
          api: "openai-completions",
          baseUrl: "https://ollama.com/v1",
          models: assembleModels(raw),
        });
        await runtime.setRuntimeApiKey("ollama-cloud", "fixture");
        for (const [id, reasoning, effort] of [
          ["glm-5.3-flash:cloud", "low", "low"],
          ["glm-5.3-flash", "xhigh", "max"],
          ["beam", "xhigh", "xhigh"],
          ["beam", "max", "max"],
          ["muse-spark-open", undefined, "none"],
        ] as const) {
          const model = runtime.getModel("ollama-cloud", id);
          assert.ok(model);
          let calls = 0;
          await withMockFetch(
            async (_url, init) => {
              calls += 1;
              const payload: unknown = JSON.parse(String(init?.body));
              assert.ok(isRecord(payload));
              assert.equal(payload.model, id);
              assert.equal(payload.reasoning_effort, effort);
              assert.equal(payload.max_tokens, 4096);
              assert.equal(payload.provider, undefined);
              return chatResponse();
            },
            async () => {
              const result = await runtime.completeSimple(
                model,
                { messages: [{ role: "user", content: "fixture", timestamp: 1 }] },
                {
                  reasoning: reasoning as ThinkingLevel | undefined,
                  maxTokens: 4096,
                },
              );
              assert.equal(result.stopReason, "stop");
            },
          );
          assert.equal(calls, 1);
        }
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    });
  },
};
runFeature(import.meta.url, modelsFeature);
