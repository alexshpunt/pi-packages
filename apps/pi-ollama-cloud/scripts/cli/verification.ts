import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { runDirect } from "./direct.ts";

export interface Check {
  phase: "baseline" | "cli" | "consumer";
  command: string;
  inputs: string;
  expected: string;
  observed: string;
  result: "pass" | "fail" | "skipped";
}
export interface VerificationContext {
  check: (name: string, run: () => void | Promise<void>, inputs?: string) => Promise<void>;
}
export interface VerificationFeature {
  id: string;
  cli: string;
  shared: string[];
  consumers: string[];
  verify: (context: VerificationContext) => Promise<void>;
}
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const repoRoot = resolve(packageRoot, "../..");

export function collectVerifiedFiles(entrypoints: string[]) {
  const visited = new Set<string>();
  function visit(path: string) {
    const absolute = resolve(packageRoot, path);
    if (visited.has(absolute)) return;
    visited.add(absolute);
    const source = readFileSync(absolute, "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) {
      const dependency = resolve(dirname(absolute), match[1]);
      visit(relative(packageRoot, dependency));
    }
  }
  for (const path of entrypoints) visit(path);
  return [...visited].sort().map((path) => ({
    path: relative(repoRoot, path),
    hash: createHash("sha256").update(readFileSync(path)).digest("hex"),
  }));
}
export async function verifyFeature(
  feature: VerificationFeature,
  args = process.argv.slice(2),
  signal?: AbortSignal,
): Promise<void> {
  const reportIndex = args.indexOf("--report");
  if (
    !args.includes("--offline") ||
    args.some((arg, i) => arg !== "--offline" && arg !== "--report" && i !== reportIndex + 1)
  ) {
    throw new Error("사용법: --offline [--report <path>]. 이 실행기는 실API를 호출하지 않습니다.");
  }
  if (reportIndex >= 0 && !args[reportIndex + 1]) throw new Error("--report 경로가 필요합니다.");
  const checks: Check[] = [];
  const command = `pnpm --filter @buyong/pi-ollama-cloud exec tsx ${feature.cli} --offline`;
  let hasFailed = false;
  let failure: unknown;
  try {
    await feature.verify({
      async check(name, run, inputs = "임시 데이터와 모의 전송") {
        const check: Check = { phase: "cli", command, inputs, expected: name, observed: "", result: "fail" };
        checks.push(check);
        try {
          signal?.throwIfAborted();
          await run();
          signal?.throwIfAborted();
          check.result = "pass";
          check.observed = "검증 조건 충족";
        } catch (error) {
          check.observed = "검증 조건 불일치";
          console.error(`FAIL: ${name}`);
          throw error;
        }
      },
    });
  } catch (error) {
    hasFailed = true;
    failure = error;
  }
  let verifiedFiles: ReturnType<typeof collectVerifiedFiles> = [];
  try {
    verifiedFiles = collectVerifiedFiles([feature.cli, ...feature.shared]);
  } catch (error) {
    hasFailed = true;
    failure ??= error;
    checks.push({
      phase: "cli",
      command,
      inputs: "검증 소스 그래프",
      expected: "모든 소스 해시 수집",
      observed: "파일 누락 또는 읽기 실패",
      result: "fail",
    });
  }
  const report = {
    schemaVersion: 1,
    status: hasFailed ? "fail" : "pass",
    checkedAt: new Date().toISOString(),
    feature: feature.id,
    baselineHead: "827c4e57e21d59215a6b032a6ab1843328a51869",
    branch: execFileSync("git", ["branch", "--show-current"], { cwd: repoRoot, encoding: "utf8" }).trim(),
    versions: { node: process.version, pi: VERSION },
    verifiedFiles,
    moduleReferences: { cli: feature.cli, shared: feature.shared, consumers: feature.consumers },
    checks,
    apiCallCounts: { chat: 0, web_search: 0, web_fetch: 0, usage: 0, limitsProbe: 0 },
    limits: ["모의 검증이며 실서비스 성공을 의미하지 않음", "소비자 검증은 연결 후 별도로 기록"],
  };
  if (reportIndex >= 0) {
    const reportPath = resolve(args[reportIndex + 1]);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (hasFailed) throw failure;
  console.log(`${feature.id}: ${checks.length}개 검증 통과, 실API 호출 0`);
}
export function runFeature(moduleURL: string, feature: VerificationFeature): void {
  runDirect(moduleURL, () => verifyFeature(feature));
}
