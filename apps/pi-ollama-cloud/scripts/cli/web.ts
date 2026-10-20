import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCache } from "../../src/cache/storage.ts";
import { executeWebFetch } from "../../src/web/fetch.ts";
import { withMockFetch } from "./mock-transport.ts";
import { runFeature, type VerificationFeature } from "./verification.ts";

export const webFeature: VerificationFeature = {
  id: "05-fetch-recovery",
  cli: "scripts/cli/web.ts",
  shared: ["src/web/fetch.ts", "src/web/errors.ts", "src/cache/storage.ts"],
  consumers: ["src/pi/web-tools.ts", "web-tools.ts"],
  async verify({ check }) {
    for (const failure of [500, 401, 403, 429, "transport", "shape", "abort"] as const) {
      await check(`404 → 강제 ${failure} → 일반 재시도 → 캐시 적중`, async () => {
        const temp = mkdtempSync(join(tmpdir(), "ollama-fetch-recovery-"));
        const path = join(temp, "cache.json");
        const cache = createCache({ path });
        const params = { url: "https://example.test/fixture" };
        let calls = 0;
        try {
          await withMockFetch(
            async () => {
              calls += 1;
              if (calls === 1) return new Response("fixture missing", { status: 404 });
              if (calls === 2) {
                if (failure === "transport") throw new Error("fixture transport");
                if (failure === "abort") throw new DOMException("fixture cancelled", "AbortError");
                if (failure === "shape") return Response.json({ title: "invalid" });
                return new Response("fixture transient", { status: failure });
              }
              return Response.json({ title: "Recovered", content: "fixture body", links: [] });
            },
            async () => {
              const resolveKey = async () => "fixture-key";
              await assert.rejects(executeWebFetch(params, undefined, resolveKey, cache), /failure cached/);
              await assert.rejects(
                executeWebFetch({ ...params, refresh: true }, undefined, resolveKey, cache),
                /not cached/,
              );
              assert.equal(createCache({ path }).loadCache().pages[params.url], undefined);
              const recovered = await executeWebFetch(params, undefined, resolveKey, cache);
              assert.match(recovered.content[0].text, /Recovered/);
              const cached = await executeWebFetch(params, undefined, resolveKey, cache);
              assert.match(cached.content[0].text, /# from cache/);
              assert.equal(calls, 3);
            },
          );
        } finally {
          rmSync(temp, { recursive: true, force: true });
        }
      });
    }
    await check("성공 본문도 강제 재조회 실패 뒤 fresh hit로 반환하지 않음", async () => {
      const temp = mkdtempSync(join(tmpdir(), "ollama-fetch-success-"));
      const cache = createCache({ path: join(temp, "cache.json") });
      let calls = 0;
      try {
        await withMockFetch(
          async () => {
            calls += 1;
            return calls === 2
              ? new Response("fixture error", { status: 500 })
              : Response.json({ title: "OK", content: String(calls), links: [] });
          },
          async () => {
            const params = { url: "https://example.test/fixture" };
            await executeWebFetch(params, undefined, async () => "fixture", cache);
            await assert.rejects(
              executeWebFetch({ ...params, refresh: true }, undefined, async () => "fixture", cache),
            );
            await executeWebFetch(params, undefined, async () => "fixture", cache);
            assert.equal(calls, 3);
          },
        );
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    });
  },
};
runFeature(import.meta.url, webFeature);
