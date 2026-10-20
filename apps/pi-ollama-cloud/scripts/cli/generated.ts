import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGenerationSources, fixtureDetails, fixturePricing } from "../../test/fixtures/generation-data.ts";
import type { GenerationSources } from "../lib/generation/catalog.ts";
import { probeMaxTokens } from "../lib/generation/limits.ts";
import { parsePricingRows } from "../lib/generation/parsers.ts";
import { CATALOG_SNAPSHOT_FILE, generateCatalog, generateLimits } from "../lib/generation/pipeline.ts";
import { withMockFetch } from "./mock-transport.ts";
import { runFeature, type VerificationFeature } from "./verification.ts";

const clock = () => "2026-10-18T00:00:00.000Z";
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
export const generatedFeature: VerificationFeature = {
  id: "10-generators",
  cli: "scripts/cli/generated.ts",
  shared: [
    "scripts/lib/generation/catalog.ts",
    "scripts/lib/generation/parsers.ts",
    "scripts/lib/generation/pipeline.ts",
    "scripts/lib/generation/limits.ts",
    "src/models/metadata.ts",
  ],
  consumers: [
    "scripts/generate-models.ts",
    "scripts/generate-pricing.ts",
    "scripts/generate-reasoning.ts",
    "scripts/generate-limits.ts",
  ],
  async verify({ check }) {
    const temp = mkdtempSync(join(tmpdir(), "ollama-generation-"));
    const snapshot = join(temp, CATALOG_SNAPSHOT_FILE);
    writeFileSync(snapshot, "// previous complete snapshot\n");
    try {
      await check("부분/전체 상세 실패·빈 목록·schema 오류는 이전 snapshot을 보존", async () => {
        const cases: Partial<GenerationSources>[] = [
          {
            detail: async (id) => {
              if (id === "fixture-b") throw new Error("fixture partial");
              return fixtureDetails();
            },
          },
          {
            detail: async () => {
              throw new Error("fixture all failed");
            },
          },
          { list: async () => [] },
          { list: async () => ["fixture-a", "fixture-a"] },
          { detail: async () => ({ capabilities: ["tools"], model_info: "invalid" }) },
          { pricing: async () => "<table>changed</table>" },
          { pricing: async () => fixturePricing.replace("<th>Input</th>", "<th>Output</th>") },
          { pricing: async () => fixturePricing.replace("$0.5", "$NaN") },
          { reasoning: async () => ({ changed: true }) },
          { reasoning: async () => ({ "ollama-cloud": { models: {} } }) },
          {
            reasoning: async () => ({
              "ollama-cloud": {
                models: { "fixture-a": { reasoning_options: [{ type: "effort", values: ["unknown"] }] } },
              },
            }),
          },
          { detail: async () => ({ ...fixtureDetails(), thinking: { values: ["unknown"] } }) },
        ];
        const before = hash(snapshot);
        for (const input of cases) {
          await assert.rejects(
            generateCatalog({ outputDir: temp, sources: { ...createGenerationSources(), ...input }, clock }),
          );
          assert.equal(hash(snapshot), before);
        }
      });
      await check("단일 후보 목록·03 해석·별칭 미추정·안정 직렬화·dry-run", async () => {
        const source = createGenerationSources();
        const controller = new AbortController();
        let lists = 0;
        const requested: string[] = [];
        const input: GenerationSources = {
          ...source,
          list: async (signal) => {
            assert.equal(signal, controller.signal);
            lists += 1;
            return ["fixture-b", "fixture-a:cloud", "fixture-a"];
          },
          detail: async (id, signal) => {
            assert.equal(signal, controller.signal);
            requested.push(id);
            return fixtureDetails();
          },
        };
        const before = hash(snapshot);
        const result = await generateCatalog({
          outputDir: temp,
          sources: input,
          limits: { "fixture-a": 65536 },
          clock,
          signal: controller.signal,
          isDryRun: true,
        });
        assert.equal(lists, 1);
        assert.deepEqual(requested.sort(), ["fixture-a", "fixture-a:cloud", "fixture-b"]);
        assert.equal(hash(snapshot), before);
        assert.equal(result.isWritten, false);
        assert.deepEqual(result.catalog.info.unknownPricingIds, ["fixture-a:cloud"]);
        assert.equal(Object.hasOwn(result.catalog.pricing, "fixture-a:cloud"), false);
        assert.equal(result.catalog.models.find((model) => model.id === "fixture-a:cloud")?.maxTokens, 32768);
        assert.equal(result.catalog.models.find((model) => model.id === "fixture-a")?.maxTokens, 65536);
        assert.equal(result.catalog.models.find((model) => model.id === "fixture-a")?.thinkingLevelMap?.max, "max");
        const second = await generateCatalog({
          outputDir: temp,
          sources: { ...input, list: async () => ["fixture-a", "fixture-a:cloud", "fixture-b"] },
          limits: { "fixture-a": 65536 },
          clock,
          signal: controller.signal,
          isDryRun: true,
        });
        assert.equal(result.source, second.source);
        const committed = await generateCatalog({
          outputDir: temp,
          sources: input,
          limits: { "fixture-a": 65536 },
          clock,
          signal: controller.signal,
        });
        assert.equal(readFileSync(snapshot, "utf8"), committed.source);
      });
      await check("표준/Off-Peak·출력 없는 행을 구분하고 모르는 단가를 0으로 생성하지 않음", async () => {
        const extra =
          '<tr><td><a href="/library/fixture-a">fixture-a (Off-Peak)</a></td><td>$0.5</td><td>$0.25</td><td>$1</td></tr><tr><td><a href="/library/decision">decision</a></td><td>$0.2</td><td>-</td><td>-</td></tr>';
        const parsed = parsePricingRows(fixturePricing.replace("</tbody>", `${extra}</tbody>`));
        assert.equal(parsed.prices.get("fixture-a")?.input, 1);
        assert.equal(parsed.prices.has("decision"), false);
        assert.deepEqual(parsed.unpricedRows, ["decision"]);
        assert.equal(parsed.offPeakRows.length, 1);
      });
      await check("쓰기·최종 rename 실패와 commit 전 취소에도 정상 snapshot 해시 유지", async () => {
        const before = hash(snapshot);
        for (const operation of ["write", "rename"] as const) {
          await assert.rejects(
            generateCatalog({
              outputDir: temp,
              sources: createGenerationSources(),
              clock,
              writer: {
                write: (path, source) => {
                  if (operation === "write") throw new Error("fixture write");
                  writeFileSync(path, source);
                },
                replace: () => {
                  throw new Error("fixture rename");
                },
              },
            }),
          );
          assert.equal(hash(snapshot), before);
        }
        const controller = new AbortController();
        await assert.rejects(
          generateCatalog({
            outputDir: temp,
            sources: createGenerationSources(),
            clock,
            signal: controller.signal,
            writer: {
              write: (path, source) => {
                writeFileSync(path, source);
                controller.abort();
              },
              replace: renameSync,
            },
          }),
        );
        assert.equal(hash(snapshot), before);
        assert.equal(
          readdirSync(temp).some((name) => name.endsWith(".tmp")),
          false,
        );
      });
      await check("모의 한도 실패는 기존 측정값 보존·전체 실패/빈 목록은 파일 미교체", async () => {
        const path = join(temp, "limits.generated.ts");
        writeFileSync(path, "// previous limits\n");
        const before = hash(path);
        const existing = { "fixture-a": 32768, "fixture-b": 65536, previous: 4096 };
        for (const ids of [[], ["fixture-a"]]) {
          await assert.rejects(generateLimits({ ids, existing, probe: async () => undefined, outputDir: temp }));
          assert.equal(hash(path), before);
        }
        const result = await generateLimits({
          ids: ["fixture-a", "fixture-b", "unknown"],
          existing,
          outputDir: temp,
          measurementStartedAt: clock(),
          probe: async (id) => (id === "fixture-a" ? { limit: 16384, kind: "exact" } : undefined),
        });
        assert.deepEqual(result.limits, { "fixture-a": 16384, "fixture-b": 65536, previous: 4096 });
        assert.deepEqual(result.info.preservedIds, ["fixture-b"]);
        assert.deepEqual(result.info.unknownIds, ["unknown"]);
      });
      await check("공용 probe의 최종 model·인증·취소 전달과 정확값/하한 구분 — 전부 모의 전송", async () => {
        const controller = new AbortController();
        let calls = 0;
        await withMockFetch(
          async (_url, init) => {
            calls += 1;
            assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture");
            const body = JSON.parse(String(init?.body)) as { model: string; max_tokens: number };
            assert.equal(body.model, "fixture-a:cloud");
            assert.equal(body.max_tokens, 65536);
            assert.equal(init?.signal?.aborted, false);
            return new Response(
              JSON.stringify({ error: { message: "max_tokens exceeds model's maximum output tokens (8192)" } }),
              { status: 400 },
            );
          },
          async () => {
            assert.deepEqual(await probeMaxTokens("fixture-a:cloud", "fixture", controller.signal), {
              limit: 8192,
              kind: "exact",
            });
          },
        );
        assert.equal(calls, 1);
        const tiers: number[] = [];
        await withMockFetch(
          async (_url, init) => {
            tiers.push((JSON.parse(String(init?.body)) as { max_tokens: number }).max_tokens);
            return Response.json({ choices: [{ message: { role: "assistant", content: "" } }] });
          },
          async () => {
            assert.deepEqual(await probeMaxTokens("fixture-a", "fixture"), { limit: 524288, kind: "lower-bound" });
          },
        );
        assert.deepEqual(tiers, [65536, 131072, 262144, 524288]);
        await withMockFetch(
          async () => Response.json({ invalid: true }),
          async () => {
            assert.equal(await probeMaxTokens("fixture-a", "fixture"), undefined);
          },
        );
        controller.abort();
        await assert.rejects(probeMaxTokens("fixture-a", "fixture", controller.signal));
      });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
};
runFeature(import.meta.url, generatedFeature);
