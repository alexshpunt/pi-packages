import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { MAX_CACHE_BYTES } from "../../src/cache/constants.ts";
import {
  createRequestCoordinator,
  createScopedCoordinator,
  type SharedRequestContext,
} from "../../src/cache/coordinator.ts";
import { CACHE_LOCK_STALE_MS, withCacheLock, withCacheLockSync } from "../../src/cache/lock.ts";
import { createCache } from "../../src/cache/storage.ts";
import { executeWebFetch } from "../../src/web/fetch.ts";
import { writeFromTwoProcesses } from "./cache-workers.ts";
import { runDirect } from "./direct.ts";
import { withMockFetch } from "./mock-transport.ts";
import { type VerificationFeature, verifyFeature } from "./verification.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export async function reproduceSharing() {
  const temp = mkdtempSync(join(tmpdir(), "ollama-sharing-"));
  try {
    const path = join(temp, "cache.json");
    await writeFromTwoProcesses(path);
    const keys = Object.keys(createCache({ path }).loadCache().pages).sort();
    const cache = createCache({ path: join(temp, "requests.json") });
    let calls = 0;
    await withMockFetch(
      async () => {
        calls += 1;
        await delay(20);
        return Response.json({ title: "fixture", content: "body", links: [] });
      },
      async () => {
        await Promise.all(
          [1, 2].map(() => executeWebFetch({ url: "https://example.test" }, undefined, async () => "fixture", cache)),
        );
      },
    );
    return { keys, simultaneousTransports: calls };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
export const sharingFeature: VerificationFeature = {
  id: "08-cache-sharing",
  cli: "scripts/cli/sharing.ts",
  shared: ["src/cache/bounded-storage.ts", "src/cache/coordinator.ts", "src/cache/lock.ts", "src/cache/merge.ts"],
  consumers: ["src/web/search.ts", "src/web/fetch.ts", "src/pi/web-tools.ts"],
  async verify({ check }) {
    const temp = mkdtempSync(join(tmpdir(), "ollama-sharing-check-"));
    try {
      await check("두 프로세스의 순차·동시 저장 병합과 07의 예산·권한", async () => {
        for (const isConcurrent of [false, true]) {
          const path = join(temp, `workers-${isConcurrent}.json`);
          await writeFromTwoProcesses(path, isConcurrent);
          assert.deepEqual(Object.keys(createCache({ path }).loadCache().pages).sort(), ["first", "second"]);
          assert.ok(statSync(path).size <= MAX_CACHE_BYTES);
          assert.equal(statSync(path).mode & 0o777, 0o600);
        }
      });
      await check("최신 timestamp 우선·삭제 후 stale snapshot 부활 방지·읽기 갱신", async () => {
        const path = join(temp, "merge.json");
        const first = createCache({ path });
        const second = createCache({ path });
        const a = first.loadCache();
        const b = second.loadCache();
        const ts = Date.now();
        a.pages.same = { ts, title: "new", content: "new" };
        first.saveCache();
        b.pages.same = { ts: ts - 1, title: "old", content: "old" };
        second.saveCache();
        assert.equal(createCache({ path }).loadCache().pages.same.content, "new");
        const stale = createCache({ path });
        const old = stale.loadCache();
        const editedStale = createCache({ path });
        const edited = editedStale.loadCache();
        delete first.loadCache().pages.same;
        first.saveCache();
        old.pages.other = { ts, title: "other", content: "other" };
        stale.saveCache();
        edited.pages.same.content = "old pending edit";
        editedStale.saveCache();
        assert.equal(first.loadCache().pages.same, undefined);
        assert.equal(first.loadCache().pages.other.content, "other");
        first.loadCache().pages.same = { ts: Date.now(), title: "recovered", content: "recovered" };
        first.saveCache();
        assert.equal(second.loadCache().pages.same.content, "recovered");
      });
      await check("메모리 전용 항목은 자체 저장 후 유지하되 외부 파일 세대 변경 시 무효화", async () => {
        const path = join(temp, "memory-only.json");
        const first = createCache({ path, maxPersistedEntryBytes: 128 });
        first.loadCache().pages.large = { ts: Date.now(), title: "fixture", content: "x".repeat(1000) };
        first.saveCache();
        assert.equal(first.loadCache().pages.large.content?.length, 1000);
        const peer = createCache({ path });
        peer.loadCache().pages.peer = { ts: Date.now(), title: "peer", content: "peer" };
        peer.saveCache();
        assert.equal(first.loadCache().pages.large, undefined);
        assert.equal(first.loadCache().pages.peer.content, "peer");
      });
      await check("잠금 만료 복구·동기 제한 시간·비동기 대기 중 취소", async () => {
        const path = join(temp, "lock.json");
        mkdirSync(`${path}.lock`);
        const old = new Date(Date.now() - CACHE_LOCK_STALE_MS - 5000);
        utimesSync(`${path}.lock`, old, old);
        assert.equal((await withCacheLock(path, () => true)).ok, true);
        assert.equal(existsSync(`${path}.lock`), false);
        const release = lockfile.lockSync(path, {
          realpath: false,
          stale: CACHE_LOCK_STALE_MS,
          update: CACHE_LOCK_STALE_MS / 2,
        });
        try {
          assert.equal(
            withCacheLockSync(
              path,
              () => {
                throw new Error("Unexpected lock entry");
              },
              10,
            ).state,
            "timeout",
          );
          const controller = new AbortController();
          const pending = withCacheLock(
            path,
            () => {
              throw new Error("Unexpected lock entry");
            },
            controller.signal,
          );
          const rejection = assert.rejects(pending, /fixture-cancel/);
          controller.abort(new Error("fixture-cancel"));
          await rejection;
          assert.equal((await withCacheLock(path, () => true, undefined, 10)).state, "timeout");
        } finally {
          release();
        }
      });
      await check("동일 요청 공유와 한 대기자만 취소", async () => {
        const coordinator = createRequestCoordinator<number>();
        const gate = deferred<number>();
        const first = new AbortController();
        let calls = 0;
        let sharedSignal: AbortSignal | undefined;
        const work = async ({ signal }: SharedRequestContext) => {
          calls += 1;
          sharedSignal = signal;
          return gate.promise;
        };
        const identity = { key: "fixture", credential: "fixture" };
        const a = coordinator.run(identity, work, first.signal);
        const b = coordinator.run(identity, work);
        await Promise.resolve();
        const rejection = assert.rejects(a, /first-only/);
        first.abort(new Error("first-only"));
        await rejection;
        assert.equal(calls, 1);
        assert.equal(sharedSignal?.aborted, false);
        gate.resolve(42);
        assert.equal(await b, 42);
        assert.deepEqual(coordinator.getDiagnostics(), { inFlight: 0, resources: 0 });
      });
      await check("전체 취소는 underlying 중단·즉시 제거·늦은 완료 게시 차단", async () => {
        const coordinator = createRequestCoordinator<number>();
        const gate = deferred<number>();
        const a = new AbortController();
        const b = new AbortController();
        let context: SharedRequestContext | undefined;
        const work = async (value: SharedRequestContext) => {
          context = value;
          return gate.promise;
        };
        const identity = { key: "fixture", credential: "fixture" };
        const first = coordinator.run(identity, work, a.signal);
        const second = coordinator.run(identity, work, b.signal);
        await Promise.resolve();
        const rejected = Promise.all([assert.rejects(first), assert.rejects(second)]);
        a.abort();
        b.abort();
        await rejected;
        assert.equal(context?.signal.aborted, true);
        assert.equal(context?.canPublish(), false);
        assert.deepEqual(coordinator.getDiagnostics(), { inFlight: 0, resources: 0 });
        assert.equal(await coordinator.run(identity, async () => 2), 2);
        gate.resolve(1);
        await Promise.resolve();
        assert.equal(context?.canPublish(), false);
      });
      await check("refresh 의미 분리와 최신 요청만 게시·인증 분리·오류 후 재시도", async () => {
        const coordinator = createRequestCoordinator<string>();
        const ordinary = deferred<string>();
        const forced = deferred<string>();
        const published: string[] = [];
        const identity = { key: "fixture", credential: "fixture" };
        const work =
          (gate: ReturnType<typeof deferred<string>>) =>
          async ({ canPublish }: SharedRequestContext) => {
            const value = await gate.promise;
            if (canPublish()) published.push(value);
            return value;
          };
        const old = coordinator.run(identity, work(ordinary));
        const fresh = coordinator.run({ ...identity, refresh: true }, work(forced));
        forced.resolve("new");
        await fresh;
        ordinary.resolve("old");
        await old;
        assert.deepEqual(published, ["new"]);
        let calls = 0;
        await Promise.all(
          ["a", "b"].map((credential) =>
            coordinator.run({ key: "fixture", credential }, async () => {
              calls += 1;
              return "ok";
            }),
          ),
        );
        assert.equal(calls, 2);
        const scoped = createScopedCoordinator<number>();
        const cacheScope = {};
        const authScope = {};
        let scopedCalls = 0;
        const scopedWork = async () => ++scopedCalls;
        const values = await Promise.all([
          scoped(cacheScope, authScope, identity, scopedWork),
          scoped(cacheScope, authScope, identity, scopedWork),
          scoped(cacheScope, {}, identity, scopedWork),
          scoped({}, authScope, identity, scopedWork),
        ]);
        assert.deepEqual(values, [1, 1, 2, 3]);
        await assert.rejects(
          coordinator.run(identity, async () => {
            throw new Error("fixture failure");
          }),
        );
        assert.equal(await coordinator.run(identity, async () => "retry"), "retry");
        assert.deepEqual(coordinator.getDiagnostics(), { inFlight: 0, resources: 0 });
      });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
};
runDirect(import.meta.url, async () => {
  if (process.argv.includes("--baseline")) console.log(JSON.stringify(await reproduceSharing()));
  else await verifyFeature(sharingFeature);
});
