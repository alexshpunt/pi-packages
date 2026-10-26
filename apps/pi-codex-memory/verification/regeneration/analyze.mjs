import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EMPTY_SUMMARY } from "../../dist/pipeline.js";
import { buildInjection, MemoryReader } from "../../dist/retrieval.js";
import { workspaceScope } from "../../dist/safety.js";
import { MemoryStore } from "../../dist/store.js";
import { auditRecall } from "../compaction/audit.mjs";
import { sha256 } from "../compaction/fixtures.mjs";

const root = resolve(process.argv[2]);
const load = async (path) => JSON.parse(await readFile(path, "utf8"));
const manifest = await load(join(root, "manifest.json"));
const textOf = (content) =>
    typeof content === "string"
        ? content
        : (content ?? [])
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
const emailHashes = (text) =>
    new Set(
        [...text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map(
            (match) => sha256(match[0]),
        ),
    );
const result = {
    analyzedAt: new Date().toISOString(),
    matrix: [],
    mutations: [],
    requests: [],
    newIdentifierObservations: [],
    limitations: [
        "The original failed live reports remain unchanged.",
        "One known unsupported identifier was removed only from the shared verification copy.",
        "The final post-forget question incorrectly assumed that an empty store has no summary-template file; its live answer check failed and was not rerun.",
        "Korean project-only scope is evaluated separately from the preserved original spelling checks.",
        "These are SDK/RPC live checks, not a newly repeated interactive terminal test or a statistical model comparison.",
    ],
};
for (const { key } of manifest.models) {
    const initial = await load(join(root, key, "result.json"));
    const recheckDirectory = join(root, `${key}-recall-recheck`),
        recheck = await load(join(recheckDirectory, "result.json"));
    const finishDirectory = join(root, `${key}-forgetting-finish`),
        finish = await load(join(finishDirectory, "result.json"));
    const input = manifest.cases[key];
    const seedLines = (await readFile(input.source, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const originalIds = seedLines
        .filter(
            (entry) =>
                entry.type === "message" &&
                entry.message.role === "user" &&
                textOf(entry.message.content).startsWith("검증 대화 "),
        )
        .map((entry) => entry.id);
    assert.equal(originalIds.length, 16);
    for (const variant of ["disabled", "previous", "current"]) {
        const sourceReport = variant === "disabled" ? initial : recheck;
        const directory =
            variant === "disabled" ? join(root, key) : recheckDirectory;
        const row = sourceReport.cases[variant],
            recall = row.recall ?? row;
        const firstContext = (
            await load(join(directory, `request-${recall.callIds[0]}.json`))
        ).context;
        const events = sourceReport.events.filter(
            (event) => event.phase === `${variant}-recall`,
        );
        const audit = auditRecall({
            answer: recall.answer,
            events,
            expected: input.expected,
            obsoleteGate: input.obsoleteGate,
            usageDelta: recall.audit.usageDelta,
            isFresh: true,
            isEmptyControl: variant === "disabled",
            firstContext,
        });
        const semanticFactChecks = { ...audit.factChecks };
        const scopeEquivalent =
            variant !== "disabled" &&
            audit.facts?.decision_scope === "이 프로젝트에만 적용";
        if (scopeEquivalent) semanticFactChecks.decision_scope = true;
        const hasEvidence =
            variant === "disabled"
                ? recall.injectedBytes === 0 && audit.usageDelta === 0
                : audit.referenceCount > 0 &&
                  audit.invalidReferences.length === 0 &&
                  audit.hasMatchingSourceIds &&
                  audit.hasCitedOpaqueFacts &&
                  audit.usageDelta > 0;
        const item = {
            model: key,
            variant,
            originalAuditPassed: audit.passed,
            exactFactChecks: audit.exactFactChecks,
            semanticFactChecks,
            scopeEquivalent,
            semanticPassed:
                Object.values(semanticFactChecks).every(Boolean) &&
                hasEvidence &&
                !recall.hasOutsideMemoryLeak,
            injectedBytes: recall.injectedBytes,
            actualReadCount: audit.actualReadCount,
            actualSearchCount: audit.actualSearchCount,
            citationCount: audit.referenceCount,
            sourceIdsValid: audit.referenceCount
                ? audit.hasMatchingSourceIds
                : null,
            sourceReport: join(directory, "result.json"),
        };
        if (variant !== "disabled") {
            const generation = initial.cases[variant].generation;
            assert.ok(generation.passed && generation.actualExtraction);
            const extract = initial.calls.find(
                (call) =>
                    generation.callIds.includes(call.id) &&
                    call.kind === "extraction",
            );
            const request = await load(
                join(root, key, `request-${extract.id}.json`),
            );
            const envelope = JSON.parse(
                textOf(
                    request.context.messages.find(
                        (message) => message.role === "user",
                    ).content,
                ),
            );
            item.originalHumanEntriesInActualExtraction = originalIds.filter(
                (id) =>
                    envelope.rendered_conversation.includes(
                        `[entry=${id}; human user]`,
                    ),
            ).length;
            assert.deepEqual(
                generation.records.map((record) => sha256(record.body)),
                row.generation.records.map((record) => sha256(record.body)),
            );
            item.reusedGenerationUnchanged = true;
            if (variant === "current")
                assert.equal(item.originalHumanEntriesInActualExtraction, 16);
        }
        result.matrix.push(item);
    }
    const store = new MemoryStore(
        join(finishDirectory, "current-agent/pi-codex-memory"),
    );
    const scope = workspaceScope(input.cwd),
        reader = new MemoryReader(store, scope);
    try {
        const records = store.records(scope),
            state = store.state(scope),
            values = [
                ...Object.values(input.expected).filter(
                    (value) => typeof value === "string",
                ),
                input.obsoleteGate,
                finish.mutation.expected.release_gate,
            ];
        const read = reader.read({ path: "memory_summary.md", line_offset: 1 });
        const published = await readFile(
            join(store.artifactRoot(scope), "memory_summary.md"),
            "utf8",
        );
        const searches = reader.search({ queries: values });
        const absence = {
            records: records.length,
            templateOnly:
                read.content === EMPTY_SUMMARY &&
                published === EMPTY_SUMMARY &&
                state.summary === EMPTY_SUMMARY,
            searchMatchCount: searches.matches.length,
            injectedBytes: Buffer.byteLength(
                buildInjection(store, scope, store.getSettings(scope)),
            ),
            forgotten: store.isForgotten(scope, input.sourceSessionId),
            containsDeletedValues: values.some(
                (value) =>
                    read.content.includes(value) || published.includes(value),
            ),
        };
        assert.equal(absence.records, 0);
        assert.ok(absence.templateOnly && absence.forgotten);
        assert.equal(absence.searchMatchCount, 0);
        assert.equal(absence.injectedBytes, 0);
        assert.equal(absence.containsDeletedValues, false);
        result.mutations.push({
            model: key,
            correctionPassed:
                recheck.mutation.generation.passed &&
                recheck.mutation.correctionRecall.passed,
            realCompactionAfterForget:
                recheck.mutation.realCompactionAfterForget,
            eligibleForgottenSourceObserved:
                finish.mutation.scanEligibility.sourceIds.includes(
                    input.sourceSessionId,
                ),
            regeneratedRecords:
                finish.mutation.forgottenRescan.pipelineResult.extracted,
            failedRescans:
                finish.mutation.forgottenRescan.pipelineResult.failed,
            stayedAbsent: finish.mutation.forgottenStayedAbsent,
            offlineAbsence: absence,
            originalFinalAnswerCheckPassed:
                finish.mutation.forgottenRecall.passed,
            finalAnswerLimitation:
                "The model correctly reported the template file instead of entering the question's empty-list branch; no revised live query was run.",
        });
    } finally {
        store.close();
    }
    for (const [directory, report] of [
        [join(root, key), initial],
        [recheckDirectory, recheck],
        [finishDirectory, finish],
    ]) {
        for (const call of report.calls) {
            const request = await load(
                join(directory, `request-${call.id}.json`),
            );
            assert.equal(
                sha256(JSON.stringify(request.context)),
                call.inputSHA256,
            );
            const response = await load(
                join(directory, `response-${call.id}.json`),
            );
            const inputEmails = emailHashes(JSON.stringify(request.context));
            const newHashes = [...emailHashes(response.text)].filter(
                (hash) => !inputEmails.has(hash),
            );
            if (newHashes.length)
                result.newIdentifierObservations.push({
                    model: key,
                    phase: call.phase,
                    kind: call.kind,
                    hashes: newHashes,
                });
            result.requests.push({
                model: key,
                directory,
                id: call.id,
                kind: call.kind,
                status: call.status,
                stopReason: call.stopReason,
            });
        }
    }
}
const database = new DatabaseSync(join(root, "model-budget.sqlite"), {
    readOnly: true,
});
result.budget = database.prepare("SELECT used,maximum FROM budget").get();
result.byModel = database
    .prepare(
        "SELECT provider,model,count(*) AS calls FROM calls GROUP BY provider,model",
    )
    .all();
database.close();
assert.equal(result.requests.length, result.budget.used);
assert.ok(result.budget.used <= result.budget.maximum);
result.runtimeEquality = [];
for (const [path, expected] of Object.entries(manifest.runtimeFiles)) {
    for (const directory of [manifest.currentPackage, manifest.bundlePackage])
        assert.equal(sha256(await readFile(join(directory, path))), expected);
    result.runtimeEquality.push(path);
}
result.comparisonSmokePassed = result.matrix.every((row) => row.semanticPassed);
result.postForgetLiveAnswerRecheck = "not_run_budget_exhausted";
await writeFile(
    join(root, "analysis.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    { mode: 0o600 },
);
console.log(
    JSON.stringify(
        {
            budget: result.budget,
            matrix: result.matrix.map((row) => ({
                model: row.model,
                variant: row.variant,
                semanticPassed: row.semanticPassed,
                correctFacts: Object.values(row.semanticFactChecks).filter(
                    Boolean,
                ).length,
                originalHumanEntries:
                    row.originalHumanEntriesInActualExtraction,
                scopeEquivalent: row.scopeEquivalent,
            })),
            mutations: result.mutations.map((row) => ({
                model: row.model,
                correction: row.correctionPassed,
                realCompaction: row.realCompactionAfterForget,
                stayedAbsent: row.stayedAbsent,
                templateOnly: row.offlineAbsence.templateOnly,
                originalFinalAnswerCheckPassed:
                    row.originalFinalAnswerCheckPassed,
            })),
            matchingInstalledFiles: result.runtimeEquality.length,
            newIdentifierObservations: result.newIdentifierObservations,
            postForgetLiveAnswerRecheck: result.postForgetLiveAnswerRecheck,
        },
        null,
        2,
    ),
);
