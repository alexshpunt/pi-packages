import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { auditRecall } from "./audit.mjs";
import { privateJSON } from "../live/runtime.mjs";

const root = resolve(process.argv[2]), results = [];
for (const item of await readdir(root, { withFileTypes: true })) {
    if (!item.isDirectory() || !/^(haiku|luna)-(short|medium|long)(?:-recall-recheck)?$/.test(item.name)) continue;
    const directory = join(root, item.name);
    let report;
    try { report = JSON.parse(await readFile(join(directory, "result.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const fixture = JSON.parse(await readFile(join(root, `${report.length}-fixture.json`), "utf8"));
    const recalls = {};
    for (const [phase, result] of Object.entries(report.recalls)) {
        const first = report.calls.find(call => call.phase === phase && call.kind === "foreground");
        const firstContext = first ? JSON.parse(await readFile(join(directory, `request-${first.id}.json`), "utf8")).context : undefined;
        recalls[phase] = auditRecall({ answer: result.answer, events: report.events.filter(event => event.phase === phase), expected: fixture.expected,
            obsoleteGate: fixture.obsoleteGate, usageDelta: result.audit.usageDelta, isFresh: result.audit.isFresh,
            isEmptyControl: result.audit.isEmptyControl, firstContext });
    }
    const audit = { criterionRevision: 3, source: "result.json", originalStatus: report.status,
        note: "Original observations and verdicts are retained. This audit includes actual search-returned lines and distinguishes exact text from unambiguous scope equivalence.", recalls };
    await privateJSON(join(directory, "re-audit.json"), audit);
    results.push({ case: item.name, originalStatus: report.status,
        recalls: Object.fromEntries(Object.entries(recalls).map(([name, value]) => [name, { passed: value.passed, exact: value.exactFactChecks, facts: value.factChecks }])) });
}
console.log(JSON.stringify(results));
