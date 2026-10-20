import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePiCredential } from "../../src/auth/pi-resolver.ts";
import { readStoredOllamaCloudKey } from "../../src/auth/resolver.ts";
import { completeOllamaChat } from "../../src/pi/chat.ts";
import { chatResponse, withMockFetch } from "./mock-transport.ts";
import { runFeature, type VerificationFeature } from "./verification.ts";

export const authFeature: VerificationFeature = {
  id: "02-auth",
  cli: "scripts/cli/auth.ts",
  shared: ["src/auth/pi-resolver.ts"],
  consumers: ["src/pi/chat.ts", "scripts/generate-limits.ts", "scripts/smoke-web-tools.ts", "src/auth/context.ts"],
  async verify({ check }) {
    const temp = mkdtempSync(join(tmpdir(), "ollama-auth-fixtures-"));
    const previous = process.env.TEST_OLLAMA_KEY;
    const fallback = process.env.OLLAMA_API_KEY;
    process.env.TEST_OLLAMA_KEY = "fixture-env";
    process.env.OLLAMA_API_KEY = "fixture-fallback";
    let fixtureIndex = 0;
    function fixture(key?: string, env?: Record<string, string>) {
      const path = join(temp, `${fixtureIndex++}.json`);
      writeFileSync(path, JSON.stringify(key === undefined ? {} : { "ollama-cloud": { type: "api_key", key, env } }), {
        mode: 0o600,
      });
      return path;
    }
    try {
      await check("리터럴·$ENV·${ENV}·명령 참조를 Pi가 해석하고 저장 키 우선순위를 유지", async () => {
        for (const [raw, expected] of [
          ["fixture-literal", "fixture-literal"],
          ["$TEST_OLLAMA_KEY", "fixture-env"],
          ["${TEST_OLLAMA_KEY}", "fixture-env"],
          ["!printf fixture-command", "fixture-command"],
        ]) {
          const path = fixture(raw);
          const before = readFileSync(path);
          assert.equal(readStoredOllamaCloudKey(path), raw);
          const result = await resolvePiCredential(path);
          assert.equal(result.apiKey, expected);
          assert.equal(result.source, "auth.json");
          assert.deepEqual(readFileSync(path), before);
        }
      });
      await check("누락 값·명령 실패의 fallback과 credentials.env 보존", async () => {
        assert.equal((await resolvePiCredential(fixture())).source, "OLLAMA_API_KEY");
        assert.equal((await resolvePiCredential(fixture("$MISSING_OLLAMA_FIXTURE_ENV"))).apiKey, "fixture-fallback");
        assert.equal((await resolvePiCredential(fixture("!exit 1"))).apiKey, "fixture-fallback");
        const result = await resolvePiCredential(fixture("$TEST_OLLAMA_KEY", { TEST_OLLAMA_KEY: "fixture-scoped" }));
        assert.equal(result.apiKey, "fixture-scoped");
        assert.equal(result.env?.TEST_OLLAMA_KEY, "fixture-scoped");
      });
      await check("취소된 요청은 인증 평가 전에 중단", async () => {
        const controller = new AbortController();
        try {
          controller.abort();
          await assert.rejects(resolvePiCredential(join(temp, "missing.json"), { signal: controller.signal }), {
            name: "AbortError",
          });
        } finally {
          controller.abort();
        }
      });
      await check("Pi 최종 채팅 전송에 원문 참조 대신 해석된 키 사용", async () => {
        const path = fixture("$TEST_OLLAMA_KEY");
        let calls = 0;
        await withMockFetch(
          async (url, init) => {
            if (String(url).endsWith("/api/show")) return Response.json({ capabilities: ["tools"] });
            assert.ok(String(url).endsWith("/chat/completions"));
            calls += 1;
            assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-env");
            return chatResponse();
          },
          async () => {
            const controller = new AbortController();
            try {
              await completeOllamaChat("fixture", controller.signal, (signal) => resolvePiCredential(path, { signal }));
            } finally {
              controller.abort();
            }
          },
        );
        assert.equal(calls, 1);
      });
    } finally {
      if (previous === undefined) delete process.env.TEST_OLLAMA_KEY;
      else process.env.TEST_OLLAMA_KEY = previous;
      if (fallback === undefined) delete process.env.OLLAMA_API_KEY;
      else process.env.OLLAMA_API_KEY = fallback;
      rmSync(temp, { recursive: true, force: true });
    }
  },
};
runFeature(import.meta.url, authFeature);
