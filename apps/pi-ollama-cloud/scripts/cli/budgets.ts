import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCache } from "../../src/cache/bounded-storage.ts";
import { MAX_CACHE_BYTES, MAX_MEMORY_CACHE_BYTES, MAX_PERSISTED_ENTRY_BYTES } from "../../src/cache/constants.ts";
import { executeWebFetch } from "../../src/web/fetch.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, isWithinOutputBudget } from "../../src/web/paging.ts";
import { executeWebSearch } from "../../src/web/search.ts";
import { withMockFetch } from "./mock-transport.ts";
import { runFeature, type VerificationFeature } from "./verification.ts";

type Page = Awaited<ReturnType<typeof executeWebFetch>>;
async function readAll(call: (offset: number) => Promise<Page>, original: string) {
  let offset = 0;
  let combined = "";
  for (let pageIndex = 0; pageIndex < 200; pageIndex++) {
    const result = await call(offset);
    assert.equal(isWithinOutputBudget(result), true);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= DEFAULT_MAX_BYTES);
    assert.ok(result.content[0].text.split("\n").length <= DEFAULT_MAX_LINES);
    combined += result.content[0].text.slice(result.details.bodyStart, result.details.bodyEnd);
    if (result.details.nextOffset === undefined) {
      assert.equal(combined, original);
      return;
    }
    assert.ok(result.details.nextOffset > offset);
    offset = result.details.nextOffset;
  }
  throw new Error("Pagination did not finish.");
}

export const budgetsFeature: VerificationFeature = {
  id: "07-cache-budgets",
  cli: "scripts/cli/budgets.ts",
  shared: [
    "src/cache/bounded-storage.ts",
    "src/cache/budget.ts",
    "src/cache/disk.ts",
    "src/web/paging.ts",
    "src/web/search.ts",
    "src/web/fetch.ts",
  ],
  consumers: ["src/cache/storage.ts", "src/pi/web-tools.ts"],
  async verify({ check }) {
    const temp = mkdtempSync(join(tmpdir(), "ollama-budgets-"));
    try {
      await check("메모리 8MiB·디스크 8MiB·항목 256KiB와 전체 항목 eviction", async () => {
        assert.equal(MAX_MEMORY_CACHE_BYTES, 8 * 1024 * 1024);
        assert.equal(MAX_CACHE_BYTES, 8 * 1024 * 1024);
        assert.equal(MAX_PERSISTED_ENTRY_BYTES, 256 * 1024);
        const path = join(temp, "memory.json");
        const store = createCache({ path });
        store.loadCache().pages.large = { ts: Date.now(), title: "fixture", content: "x".repeat(9 * 1024 * 1024) };
        store.saveCache();
        assert.equal(store.loadCache().pages.large, undefined);
        assert.ok(Buffer.byteLength(JSON.stringify(store.loadCache())) <= MAX_MEMORY_CACHE_BYTES);
        assert.ok(statSync(path).size <= MAX_CACHE_BYTES);
        assert.equal(statSync(path).mode & 0o777, 0o600);
        const entry = { ts: Date.now(), title: "fixture", content: "\n".repeat(200000) };
        store.loadCache().pages.memoryOnly = entry;
        store.saveCache();
        assert.equal(store.loadCache().pages.memoryOnly?.content, entry.content);
        assert.equal(createCache({ path }).loadCache().pages.memoryOnly, undefined);
      });
      await check("정확한 JSON 바이트 경계와 과대 파일의 parse 전 거부", async () => {
        const entry = { ts: Date.now(), title: "한글🙂", content: '\b\t\n\f\r"\\'.repeat(10) };
        const bytes = Buffer.byteLength(JSON.stringify({ searches: {}, pages: { fixture: entry } }));
        for (const limit of [bytes - 1, bytes, bytes + 1]) {
          const store = createCache({ path: join(temp, `${limit}.json`), maxMemoryBytes: limit, maxCacheBytes: limit });
          store.loadCache().pages.fixture = entry;
          store.saveCache();
          assert.ok(Buffer.byteLength(JSON.stringify(store.loadCache())) <= limit);
          assert.equal(store.loadCache().pages.fixture !== undefined, limit >= bytes);
        }
        const path = join(temp, "oversized.json");
        writeFileSync(path, "{".repeat(4096));
        const store = createCache({ path, maxCacheBytes: 1024 });
        assert.deepEqual(store.loadCache(), { searches: {}, pages: {} });
        assert.equal(store.getDiagnostics?.().lastRead, "oversized");
      });
      await check("UTF-8·줄 수·JSON escaping 상한 안에서 fetch full과 search expand 원문 이어 읽기", async () => {
        for (const [index, body] of [
          "a".repeat(150000),
          "한글🙂\n".repeat(20000),
          '\b\t\n\f\r"\\'.repeat(12000),
          "",
        ].entries()) {
          const store = createCache({ path: join(temp, `paging-${index}.json`) });
          let searchCalls = 0;
          let fetchCalls = 0;
          await withMockFetch(
            async (url) => {
              if (String(url).endsWith("/api/web_search")) {
                searchCalls += 1;
                return Response.json({ results: [{ title: "fixture", url: "https://example.test", content: body }] });
              }
              fetchCalls += 1;
              return Response.json({ title: "fixture", content: body, links: [] });
            },
            async () => {
              await readAll(
                (offset) =>
                  executeWebFetch(
                    { url: "https://example.test", full: true, offset },
                    undefined,
                    async () => "fixture",
                    store,
                  ),
                body,
              );
              await readAll(
                (offset) =>
                  executeWebSearch(
                    { query: "fixture", max_results: 3, expand: 1, offset },
                    undefined,
                    async () => "fixture",
                    store,
                  ),
                body,
              );
            },
          );
          assert.equal(fetchCalls, 1);
          assert.equal(searchCalls, 1);
        }
      });
      await check("긴 제목·URL·query·링크·오류·details도 최종 반환 예산에 포함", async () => {
        const title = "제목".repeat(30000);
        const url = `https://example.test/${"x".repeat(8000)}`;
        const query = "query".repeat(20000);
        const body = "body🙂".repeat(20000);
        const store = createCache({ path: join(temp, "metadata.json") });
        await withMockFetch(
          async (address, init) => {
            const payload = JSON.parse(String(init?.body)) as { query?: string; url?: string };
            if (String(address).endsWith("/api/web_search")) {
              assert.equal(payload.query, query);
              return Response.json({ results: Array.from({ length: 10 }, () => ({ title, url, content: body })) });
            }
            assert.equal(payload.url, url);
            return Response.json({ title, content: body, links: Array.from({ length: 100 }, () => url) });
          },
          async () => {
            const search = await executeWebSearch({ query, max_results: 10 }, undefined, async () => "fixture", store);
            const page = await executeWebFetch({ url, full: true }, undefined, async () => "fixture", store);
            assert.ok(isWithinOutputBudget(search));
            assert.ok(isWithinOutputBudget(page));
            assert.ok(JSON.stringify(search.details).length < title.length);
            assert.match(page.content[0].text, /<same url>/);
            // Metadata clipping must not mutate retained original source strings.
            assert.equal(store.loadCache().pages[url]?.title, title);
          },
        );
        await withMockFetch(
          async () => new Response("failure".repeat(100000), { status: 500 }),
          async () => {
            await assert.rejects(
              executeWebFetch({ url, refresh: true }, undefined, async () => "fixture", store),
              (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.ok(
                  isWithinOutputBudget({ content: [{ type: "text", text: error.message }], details: undefined }),
                );
                return true;
              },
            );
          },
        );
      });
      await check("메모리 eviction 뒤 offset 재접근의 추가 API 호출 안내", async () => {
        const store = createCache({ path: join(temp, "eviction.json"), maxMemoryBytes: 1024 });
        let calls = 0;
        await withMockFetch(
          async () => {
            calls += 1;
            return Response.json({ title: "fixture", content: "x".repeat(100000), links: [] });
          },
          async () => {
            const first = await executeWebFetch(
              { url: "https://example.test", full: true },
              undefined,
              async () => "fixture",
              store,
            );
            assert.equal(first.details.cacheRetained, false);
            assert.match(first.content[0].text, /not retained/);
            await executeWebFetch(
              { url: "https://example.test", full: true, offset: first.details.nextOffset },
              undefined,
              async () => "fixture",
              store,
            );
            assert.equal(calls, 2);
            assert.ok(Buffer.byteLength(readFileSync(join(temp, "eviction.json"))) <= MAX_CACHE_BYTES);
          },
        );
      });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
};
runFeature(import.meta.url, budgetsFeature);
