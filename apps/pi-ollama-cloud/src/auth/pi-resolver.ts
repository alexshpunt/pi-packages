import { join } from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { OLLAMA_BASE } from "../models/base.ts";
import type { ResolvedCredential } from "./resolver.ts";

export interface CredentialOptions {
  signal?: AbortSignal;
  env?: Record<string, string>;
}

/** Keep host credential evaluation behind one public-API adapter. Never promote raw references to overrides. */
export async function resolvePiCredential(
  authPath = join(getAgentDir(), "auth.json"),
  options: CredentialOptions = {},
): Promise<ResolvedCredential & { env?: Record<string, string> }> {
  options.signal?.throwIfAborted();
  try {
    const runtime = await ModelRuntime.create({
      authPath,
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
      signal: options.signal,
    });
    runtime.registerProvider("ollama-cloud", {
      baseUrl: `${OLLAMA_BASE}/v1`,
      api: "openai-completions",
      models: [],
    });
    const resolved = await runtime.getAuth("ollama-cloud", options);
    // Pi 1.2.0 runs credential commands synchronously (bounded by its 10s timeout).
    // Cancellation is checked before and after that host-owned operation.
    options.signal?.throwIfAborted();
    if (resolved?.auth.apiKey) {
      return {
        apiKey: resolved.auth.apiKey,
        source: "auth.json",
        ...(resolved.env ? { env: resolved.env } : {}),
      };
    }
    const apiKey = options.env?.OLLAMA_API_KEY ?? process.env.OLLAMA_API_KEY;
    return apiKey
      ? { apiKey, source: "OLLAMA_API_KEY", ...(options.env ? { env: options.env } : {}) }
      : { apiKey: undefined, source: undefined };
  } catch {
    options.signal?.throwIfAborted();
    // Host errors may contain a configured command. Do not expose it or a key.
    throw new Error("Ollama Cloud 인증 해석 실패. auth.json의 키·환경 변수·명령 참조를 확인하세요.");
  }
}
