// Offline evidence analysis. Never invokes a model or modifies original result.json files.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { renderProjection } from "../../dist/sources.js";
import { memoryFailureCode } from "../../dist/failure.js";
import { privateJSON } from "../live/runtime.mjs";
import { LENGTHS, MODELS, sha256 } from "./fixtures.mjs";

const root = resolve(process.argv[2]), load = async path => JSON.parse(await readFile(path, "utf8"));
const manifest = await load(join(root, "manifest.json"));
const cases = [], identifierChecks = [], boundaryChecks = [], allCalls = [];
const scopeEquivalents = ["this_project_only", "project-only", "project_only", "this project only", "이 프로젝트에만 적용"];
for (const model of MODELS) for (const length of LENGTHS) {
    const directory = join(root, `${model.key}-${length.key}`), result = await load(join(directory, "result.json"));
    const fixture = await load(join(root, `${length.key}-fixture.json`));
    const revised = await load(join(directory, "re-audit.json"));
    allCalls.push(...result.calls);
    let recheck;
    try { recheck = await load(join(root, `${model.key}-${length.key}-recall-recheck`, "result.json")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    let fresh = revised.recalls["fresh-session-recall"];
    let control = revised.recalls["empty-memory-control"];
    let isCopiedMemoryUnchanged = null;
    if (recheck) {
        allCalls.push(...recheck.calls);
        const copyAudit = await load(join(root, `${model.key}-${length.key}-recall-recheck`, "re-audit.json"));
        fresh = copyAudit.recalls["fresh-session-recall"]; control = copyAudit.recalls["empty-memory-control"];
        isCopiedMemoryUnchanged = JSON.stringify(result.finalMemory.records.map(row => [row.id, sha256(row.body)])) ===
            JSON.stringify(recheck.finalMemory.records.map(row => [row.id, sha256(row.body)]));
    }
    // Keep the requested-format failure. Inspect a separately fenced JSON only as supplementary semantic evidence.
    let supplementary = null;
    const answer = result.recalls["fresh-session-recall"]?.answer ?? "";
    if (!result.recalls["fresh-session-recall"]?.audit.facts) {
        const blocks = [...answer.matchAll(/```json\s*([\s\S]*?)\s*```/g)];
        if (blocks.length === 1) {
            try {
                const value = JSON.parse(blocks[0][1]);
                const checks = Object.fromEntries(Object.entries(fixture.expected).map(([key, expected]) => [key, key === "decision_scope" ? scopeEquivalents.includes(value[key]) : value[key] === expected]));
                supplementary = { requestedFormatPassed: false, method: "one JSON fence outside the requested facts wrapper", facts: value, checks, semanticFactsMatch: Object.values(checks).every(Boolean) };
            } catch {}
        }
    }
    if (length.key === "long") {
        const rows = (await readFile(result.sourceSessionFile, "utf8")).trim().split("\n").map(JSON.parse);
        const original = result.generation.find(item => item.label === "before-compaction-generation");
        const projection = buildSessionProjection(rows.slice(1), original.source.leafId);
        let errorCode = null;
        try { renderProjection(projection, 256 * 1024 - 8192); } catch (error) { errorCode = memoryFailureCode(error); }
        boundaryChecks.push({ case: `${model.key}-${length.key}`, inputBytes: fixture.actualInputBytes, defaultBytes: 256 * 1024, errorCode,
            initialHostCalls: original.callIds.length, expandedAttempt: result.generation.find(item => item.label === original.label && item.settings.maxInputBytes === 512 * 1024)?.hasFullMemory ?? false });
    }
    for (const call of result.calls.filter(item => item.kind === "compaction")) {
        const request = await readFile(join(directory, `request-${call.id}.json`), "utf8");
        const response = await load(join(directory, `response-${call.id}.json`));
        for (const identifier of new Set(response.text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) ?? [])) {
            identifierChecks.push({ case: `${model.key}-${length.key}`, call: call.id, identifierSHA256: sha256(identifier),
                presentInHostRequest: request.includes(identifier), presentInFixture: JSON.stringify(fixture).includes(identifier),
                presentInInitialMemory: result.generation[0].snapshot.records.some(row => row.body.includes(identifier)),
                presentInFinalMemory: result.finalMemory.records.some(row => row.body.includes(identifier)) });
        }
    }
    cases.push({ case: `${model.key}-${length.key}`, turns: fixture.turns, inputBytes: fixture.actualInputBytes, originalStatus: result.status,
        checks: result.checks, compaction: result.compaction ? { tokensBefore: result.compaction.tokensBefore, estimatedTokensAfter: result.compaction.estimatedTokensAfter } : result.autoThreshold,
        beforePassed: revised.recalls["before-compaction-recall"]?.passed ?? false, afterPassed: revised.recalls["after-compaction-recall"]?.passed ?? false,
        fresh, control: control ?? null, usedRecheck: !!recheck, isCopiedMemoryUnchanged, supplementary,
        recordTruncations: result.generation.map(item => ({ label: item.label, attempt: item.attempt, truncatedBytes: item.snapshot.records.map(row => row.truncatedBytes ?? 0) })) });
}
const database = new DatabaseSync(join(root, "model-budget.sqlite"), { readOnly: true });
const budget = database.prepare("SELECT used,maximum FROM budget WHERE id=1").get();
const models = database.prepare("SELECT provider,model,COUNT(*) calls FROM calls GROUP BY provider,model").all(); database.close();
const kinds = {};
for (const call of allCalls) kinds[call.kind] = (kinds[call.kind] ?? 0) + 1;
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const fingerprintChecks = {};
for (const [name, expected] of Object.entries(manifest.fingerprints)) fingerprintChecks[name] = sha256(await readFile(join(packageRoot, name))) === expected;
const analysis = { budget, recordedCalls: allCalls.length, countsAgree: allCalls.length === budget.used, models, kinds, fingerprintChecks, cases, boundaryChecks, identifierChecks,
    conclusion: "Existing-memory recall after real compaction passed all six cases. Regeneration after compaction degraded factual confidence in both medium cases; no release-ready verdict.",
    identifierLimit: "Only the host streamSimple request boundary was observed. Provider-internal context and the origin of an added identifier remain unconfirmed. Identifier values are not disclosed here." };
await privateJSON(join(root, "analysis.json"), analysis);
console.log(JSON.stringify({ budget, countsAgree: analysis.countsAgree, models, kinds, unchangedRuntime: Object.values(fingerprintChecks).every(Boolean),
    cases: cases.map(item => ({ case: item.case, before: item.beforePassed, after: item.afterPassed, fresh: item.fresh.passed, factChecks: item.fresh.factChecks,
        usedRecheck: item.usedRecheck, copiedMemoryUnchanged: item.isCopiedMemoryUnchanged, supplementary: item.supplementary })), boundaryChecks, identifierChecks }));
