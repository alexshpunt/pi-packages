import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { describe, expect, it } from "vitest";
import { writeFromTwoProcesses } from "../scripts/cli/cache-workers.ts";
import { withMockFetch } from "../scripts/cli/mock-transport.ts";
import { sharingFeature } from "../scripts/cli/sharing.ts";
import { CACHE_LOCK_STALE_MS } from "../src/cache/lock.ts";
import { createCache } from "../src/cache/storage.ts";
import { registerWebFetchTool, registerWebSearchTool } from "../src/pi/web-tools.ts";
import type { createPagedResult } from "../src/web/paging.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const fetchName = "ollama_web_fetch";
const searchName = "ollama_web_search";
function paramsFor(name: string, refresh = false) {
  return name === fetchName ? { url: "https://example.test", refresh } : { query: "fixture", max_results: 3, refresh };
}
function responseFor(name: string, body: string) {
  return name === fetchName
    ? Response.json({ title: "fixture", content: body, links: [] })
    : Response.json({ results: [{ title: "fixture", url: "https://example.test", content: body }] });
}
function registered(
  cache: ReturnType<typeof createCache>,
  modelRegistry = { getApiKeyForProvider: async () => "fixture" },
) {
  const tools = new Map<string, ToolDefinition>();
  const pi = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
  registerWebFetchTool(pi, cache);
  registerWebSearchTool(pi, cache);
  const ctx = { modelRegistry } as unknown as ExtensionToolContext;
  return async (name: string, params: Record<string, unknown>, signal?: AbortSignal) => {
    const tool = tools.get(name);
    if (!tool) throw new Error("Missing registered tool");
    return (await tool.execute("fixture", params, signal, undefined, ctx)) as ReturnType<typeof createPagedResult>;
  };
}
async function withCache(run: (cache: ReturnType<typeof createCache>, path: string) => Promise<void>) {
  const temp = mkdtempSync(join(tmpdir(), "ollama-concurrency-"));
  try {
    const path = join(temp, "cache.json");
    await run(createCache({ path }), path);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

describe("shared cache concurrency", () => {
  it("protects the real merge/write critical section and shared-request lifetime", async () => {
    await sharingFeature.verify({
      check: async (_name, run) => {
        await run();
      },
    });
  }, 30000);

  it("merges two real isolated Pi consumers and each coalesces both registered tools", async () => {
    await withCache(async (cache, path) => {
      await writeFromTwoProcesses(path, true, "../../test/fixtures/cache-pi-worker.ts");
      expect(Object.keys(cache.loadCache().pages).sort()).toEqual([
        "https://example.test/first",
        "https://example.test/second",
      ]);
      expect(
        Object.values(cache.loadCache().searches)
          .map((entry) => entry.q)
          .sort(),
      ).toEqual(["first", "second"]);
    });
  }, 30000);

  it.each([fetchName, searchName])("shares %s while canceling only one waiter", async (name) => {
    await withCache(async (cache) => {
      const run = registered(cache);
      const first = new AbortController();
      const second = new AbortController();
      const started = deferred<void>();
      const gate = deferred<Response>();
      let calls = 0;
      let sharedSignal: AbortSignal | null | undefined;
      await withMockFetch(
        async (_url, init) => {
          calls += 1;
          sharedSignal = init?.signal;
          started.resolve();
          return gate.promise;
        },
        async () => {
          const a = run(name, paramsFor(name), first.signal);
          const b = run(name, paramsFor(name), second.signal);
          await started.promise;
          const rejected = expect(a).rejects.toThrow("one waiter");
          first.abort(new Error("one waiter"));
          await rejected;
          expect(sharedSignal?.aborted).toBe(false);
          expect(second.signal.aborted).toBe(false);
          gate.resolve(responseFor(name, "shared"));
          expect((await b).content[0].text).toContain("shared");
          expect(calls).toBe(1);
        },
      );
    });
  });

  it("cancels all waiters, invalidates the previous failure and rejects late publication", async () => {
    await withCache(async (cache, path) => {
      cache.loadCache().pages["https://example.test"] = { ts: Date.now(), error: "HTTP 404", status: 404 };
      cache.saveCache();
      const run = registered(cache);
      const a = new AbortController();
      const b = new AbortController();
      const started = deferred<void>();
      const late = deferred<Response>();
      let calls = 0;
      let sharedSignal: AbortSignal | null | undefined;
      await withMockFetch(
        async (_url, init) => {
          calls += 1;
          sharedSignal = init?.signal;
          if (calls === 1) {
            started.resolve();
            return late.promise;
          }
          return responseFor(fetchName, "recovered");
        },
        async () => {
          const first = run(fetchName, paramsFor(fetchName, true), a.signal);
          const second = run(fetchName, paramsFor(fetchName, true), b.signal);
          await started.promise;
          const rejected = Promise.all([expect(first).rejects.toThrow(), expect(second).rejects.toThrow()]);
          a.abort();
          b.abort();
          await rejected;
          expect(sharedSignal?.aborted).toBe(true);
          expect(createCache({ path }).loadCache().pages["https://example.test"]).toBeUndefined();
          late.resolve(responseFor(fetchName, "late"));
          await tick();
          expect(cache.loadCache().pages["https://example.test"]).toBeUndefined();
          expect((await run(fetchName, paramsFor(fetchName))).content[0].text).toContain("recovered");
          expect(calls).toBe(2);
        },
      );
    });
  });

  it.each([fetchName, searchName])("keeps newer refresh publication for %s", async (name) => {
    await withCache(async (cache) => {
      const run = registered(cache);
      const started = deferred<void>();
      const forcedStarted = deferred<void>();
      const old = deferred<Response>();
      const fresh = deferred<Response>();
      let calls = 0;
      await withMockFetch(
        async () => {
          calls += 1;
          if (calls === 1) {
            started.resolve();
            return old.promise;
          }
          forcedStarted.resolve();
          return fresh.promise;
        },
        async () => {
          const first = run(name, paramsFor(name));
          await started.promise;
          const second = run(name, paramsFor(name, true));
          await forcedStarted.promise;
          fresh.resolve(responseFor(name, "new"));
          await second;
          old.resolve(responseFor(name, "old"));
          expect((await first).details.cacheRetained).toBe(false);
          expect((await run(name, paramsFor(name))).content[0].text).toContain("new");
          expect(calls).toBe(2);
        },
      );
    });
  });

  it.each([fetchName, searchName])(
    "shares failures for %s and retries without a poisoned in-flight entry",
    async (name) => {
      await withCache(async (cache) => {
        const run = registered(cache);
        const started = deferred<void>();
        const failed = deferred<Response>();
        let calls = 0;
        await withMockFetch(
          async () => {
            calls += 1;
            if (calls === 1) {
              started.resolve();
              return failed.promise;
            }
            return responseFor(name, "retry");
          },
          async () => {
            const pending = Promise.allSettled([run(name, paramsFor(name)), run(name, paramsFor(name))]);
            await started.promise;
            failed.resolve(new Response("fixture", { status: 500 }));
            expect((await pending).map((result) => result.status)).toEqual(["rejected", "rejected"]);
            expect(calls).toBe(1);
            expect((await run(name, paramsFor(name))).content[0].text).toContain("retry");
            expect(calls).toBe(2);
          },
        );
      });
    },
  );

  it("does not share requests across actual registry contexts", async () => {
    await withCache(async (cache) => {
      const first = registered(cache);
      const second = registered(cache);
      const gate = deferred<Response>();
      const started = deferred<void>();
      let calls = 0;
      await withMockFetch(
        async () => {
          calls += 1;
          if (calls === 2) started.resolve();
          await gate.promise;
          return responseFor(fetchName, "separate");
        },
        async () => {
          const pending = Promise.all([
            first(fetchName, paramsFor(fetchName)),
            second(fetchName, paramsFor(fetchName)),
          ]);
          await started.promise;
          gate.resolve(responseFor(fetchName, "fixture"));
          await pending;
          expect(calls).toBe(2);
        },
      );
    });
  });

  it("propagates tool cancellation into the actual asynchronous lock wait", async () => {
    await withCache(async (cache, path) => {
      const release = lockfile.lockSync(path, {
        realpath: false,
        stale: CACHE_LOCK_STALE_MS,
        update: CACHE_LOCK_STALE_MS / 2,
      });
      const entered = deferred<void>();
      const controller = new AbortController();
      const observed = {
        ...cache,
        updateCache: async (...args: Parameters<NonNullable<typeof cache.updateCache>>) => {
          entered.resolve();
          await cache.updateCache?.(...args);
        },
      };
      try {
        await withMockFetch(
          async () => responseFor(fetchName, "canceled"),
          async () => {
            const pending = registered(observed)(fetchName, paramsFor(fetchName), controller.signal);
            await entered.promise;
            const rejected = expect(pending).rejects.toThrow("lock canceled");
            controller.abort(new Error("lock canceled"));
            await rejected;
            expect(cache.loadCache().pages["https://example.test"]).toBeUndefined();
          },
        );
      } finally {
        release();
      }
    });
  });
});
