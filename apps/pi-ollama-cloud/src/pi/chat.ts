import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type CredentialResolver, resolveCredential } from "../auth/resolver.ts";
import { fetchModelDetails } from "../models/api.ts";
import { OLLAMA_BASE } from "../models/base.ts";
import { assembleModels } from "../models/metadata.ts";

export const CHAT_TIMEOUT_MS = 120_000;
export const CHAT_PROMPT = "1+1";
export const MAX_RESPONSE_TOKENS = 4096;

/** Use the extension's model configuration and Pi transport without normalizing the requested ID. */
export async function completeOllamaChat(
  modelId: string,
  signal: AbortSignal,
  resolveApiKey: CredentialResolver = resolveCredential,
  observePayload?: (payload: unknown) => void,
): Promise<{ answer: string; truncated: boolean }> {
  const { apiKey, env } = await resolveApiKey(signal);
  if (!apiKey) {
    throw new Error(
      "채팅에 필요한 API 키가 없습니다. Pi의 /login에서 Ollama Cloud 키를 등록하거나 OLLAMA_API_KEY를 설정하세요.",
    );
  }

  const details = await fetchModelDetails(modelId, signal);
  const [modelConfig] = assembleModels({ [modelId]: details });
  if (!modelConfig) {
    throw new Error(`${modelId}는 이 확장이 요구하는 도구 호출을 지원하지 않습니다. 다른 모델을 선택하세요.`);
  }
  signal.throwIfAborted();

  const agentDir = await mkdtemp(join(tmpdir(), "pi-ollama-cli-"));
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(agentDir, "models-cache.json"),
      refreshOnCreate: false,
      signal,
    });
    runtime.registerProvider("ollama-cloud", {
      name: "Ollama Cloud",
      api: "openai-completions",
      baseUrl: `${OLLAMA_BASE}/v1`,
      models: [modelConfig],
    });
    await runtime.setRuntimeApiKey("ollama-cloud", apiKey, { signal });
    const model = runtime.getModel("ollama-cloud", modelId);
    if (!model || model.id !== modelId) {
      throw new Error(`요청한 모델 ID를 Pi에 등록하지 못했습니다: ${modelId}`);
    }

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), CHAT_TIMEOUT_MS);
    try {
      const result = await runtime.completeSimple(
        model,
        { messages: [{ role: "user", content: CHAT_PROMPT, timestamp: Date.now() }] },
        {
          signal: AbortSignal.any([signal, timeoutController.signal]),
          maxTokens: Math.min(MAX_RESPONSE_TOKENS, model.maxTokens),
          env,
          onPayload: (payload) => {
            observePayload?.(payload);
            if (
              payload === null ||
              typeof payload !== "object" ||
              Array.isArray(payload) ||
              !("model" in payload) ||
              payload.model !== modelId
            ) {
              throw new Error("전송할 모델 ID가 입력한 값과 달라 요청을 중단했습니다.");
            }
          },
        },
      );
      signal.throwIfAborted();
      if (timeoutController.signal.aborted) {
        throw new Error("채팅이 120초 안에 끝나지 않아 중단했습니다. 잠시 후 다시 시도하거나 다른 모델을 선택하세요.");
      }
      if (result.stopReason === "error" || result.stopReason === "aborted") {
        throw new Error(`Ollama 채팅 실패: ${result.errorMessage ?? result.stopReason}`);
      }
      const answer = result.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("")
        .trim();
      if (!answer) {
        throw new Error("모델이 텍스트 답변을 반환하지 않았습니다. 다른 모델을 선택하거나 다시 시도하세요.");
      }
      return { answer, truncated: result.stopReason === "length" };
    } finally {
      clearTimeout(timeout);
      timeoutController.abort();
    }
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}
