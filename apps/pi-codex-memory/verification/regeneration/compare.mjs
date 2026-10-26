import assert from "node:assert/strict";
import { cp, mkdir, readFile, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join, resolve, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { workspaceScope, createMemoryMasker } from "../../dist/safety.js";
import { RECALL_ENTRY } from "../../dist/sources.js";
import { liveSession, disposeSession, privateJSON } from "../live/runtime.mjs";
import { auditRecall } from "../compaction/audit.mjs";
import { sha256 } from "../compaction/fixtures.mjs";
import { loadPackage } from "./load-package.mjs";

const root = resolve(process.argv[2]), key = process.argv[3];
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const target = manifest.models.find(item => item.key === key), input = manifest.cases[key];
assert.ok(target && input, "Unapproved verification model");
process.env.PI_MEMORY_BUDGET = join(root, "model-budget.sqlite");
const isRecallRecheck = process.argv[4] === "recall-recheck";
const isForgettingFinish = process.argv[4] === "finish-forgetting";
const directory = join(root, `${key}${isRecallRecheck ? "-recall-recheck" : isForgettingFinish ? "-forgetting-finish" : ""}`); await mkdir(directory, { mode: 0o700 });
const mask = createMemoryMasker(), scope = workspaceScope(input.cwd);
const textOf = content => typeof content === "string" ? content : (content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
const report = { version: 1, target, startedAt: new Date().toISOString(), status: "running", calls: [], events: [], cases: {}, mutation: {}, errors: [] };
const checkpoint = () => privateJSON(join(directory, "result.json"), report);
let phase = "startup", phaseCalls = 0, phaseLimit = 8, active, isCompacting = false;
let menuSelections = [];
const lifetime = new AbortController(), deadline = AbortSignal.any([lifetime.signal, AbortSignal.timeout(30 * 60_000)]);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { lifetime.abort(); void active?.session.abort().catch(() => {}); });
const begin = (value, limit = 8) => { phase = value; phaseCalls = 0; phaseLimit = limit; console.log(`${key}: ${value}`); };
const onError = error => report.errors.push({ phase, message: mask(String(error.error ?? error)) });
const currentPath = key === "luna" ? manifest.bundlePackage : manifest.currentPackage;
const kits = { previous: await loadPackage(manifest.previousPackage), current: await loadPackage(currentPath) };
// This historical comparison restores cwd-scoped snapshots. Refuse a different
// scope contract before even its preparation request, rather than silently moving data.
for (const [name, kit] of Object.entries(kits)) {
    const probe = new kit.MemoryStore(join(directory, `scope-probe-${name}`));
    try { assert.equal(probe.scopeFor(input.cwd), scope, "HISTORICAL_CWD_FIXTURE_REQUIRED: prepare a separate repository-scope experiment."); }
    finally { probe.close(); }
}
const settingsFor = kit => ({ ...kit.DEFAULT_SETTINGS, generateMemories: false, maxAttempts: 1,
    extractModel: { provider: target.provider, id: target.id, ...(key === "luna" ? { reasoning: "high" } : {}) },
    consolidateModel: { provider: target.provider, id: target.id, ...(key === "luna" ? { reasoning: "high" } : {}) } });
const tools = ["pi_codex_memory_list", "pi_codex_memory_search", "pi_codex_memory_read"];
async function open(manager, kit, agentDir, seed = false) {
    const observe = pi => {
        // The resumed history already includes recall outputs; its acknowledgement
        // is not independent evidence, even though this preparation loads no memory.
        if (seed) pi.on("before_agent_start", () => pi.appendEntry(RECALL_ENTRY, { verification: "resumed-memory-exposed-history" }));
        pi.on("session_before_compact", event => { isCompacting = true; report.events.push({ event: "before_compact", phase, reason: event.reason }); });
        pi.on("session_compact", event => { isCompacting = false; report.events.push({ event: "compacted", phase, reason: event.reason, fromExtension: event.fromExtension, entryId: event.compactionEntry.id }); });
        pi.on("session_compact_failed", () => { isCompacting = false; });
        pi.on("tool_execution_end", event => report.events.push({ event: "tool_end", phase, name: event.toolName, isError: event.isError, result: event.result }));
        pi.on("message_end", event => { if (event.message.role === "assistant") report.events.push({ event: "assistant", phase,
            stopReason: event.message.stopReason, text: textOf(event.message.content), error: event.message.errorMessage ? mask(event.message.errorMessage) : undefined }); });
    };
    const value = await liveSession({ cwd: input.cwd, providerPaths: manifest.providerPaths, target,
        sessionManager: manager, includeMemory: !!kit, memoryAgentDir: agentDir, memoryFactory: kit?.default,
        extensionFactories: [observe],
        budgetMaximum: manifest.maximumRequests, onError,
        settingsOverrides: { retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, timeoutMs: 180000 } }, compaction: { enabled: false } } });
    const original = value.modelRuntime.streamSimple.bind(value.modelRuntime);
    value.modelRuntime.streamSimple = (model, context, options = {}) => {
        if (++phaseCalls > phaseLimit) throw new Error(`VERIFICATION_PHASE_LIMIT: ${phase}`);
        if (model.provider !== target.provider || model.id !== target.id) throw new Error("UNAPPROVED_VERIFICATION_MODEL");
        const system = context.systemPrompt ?? "";
        const kind = system.startsWith("You are part of an agent memory") ? "extraction" : system.startsWith("Consolidate") ? "consolidation" : isCompacting ? "compaction" : "foreground";
        const id = report.calls.length + 1;
        const call = { id, phase, kind, model: `${model.provider}/${model.id}`, reasoning: options.reasoning, maxTokens: options.maxTokens ?? 8192,
            inputSHA256: sha256(JSON.stringify(context)), startedAt: new Date().toISOString(), status: "started" };
        report.calls.push(call);
        const saved = privateJSON(join(directory, `request-${id}.json`), { ...call, context });
        let stream;
        try { stream = original(model, context, { ...options, maxTokens: options.maxTokens ?? 8192,
            signal: AbortSignal.any([deadline, ...(options.signal ? [options.signal] : []), AbortSignal.timeout(180000)]) }); }
        catch (error) { call.status = "rejected-before-stream"; call.error = mask(String(error)); throw error; }
        const result = stream.result.bind(stream); let finished;
        stream.result = () => finished ??= (async () => {
            try {
                const response = await result(); await saved;
                Object.assign(call, { status: "returned", stopReason: response.stopReason, usage: response.usage,
                    outputSHA256: sha256(textOf(response.content)), finishedAt: new Date().toISOString() });
                await privateJSON(join(directory, `response-${id}.json`), { stopReason: response.stopReason, text: mask(textOf(response.content)), usage: response.usage });
                await checkpoint(); return response;
            } catch (error) { call.status = "failed"; call.error = mask(String(error)); await checkpoint(); throw error; }
        })();
        return stream;
    };
    await value.session.bindExtensions({ mode: "rpc", onError, uiContext: {
        notify(message, level) { report.events.push({ event: "ui_notice", phase, level, message: mask(message) }); }, setStatus() {}, setWidget() {},
        input: async () => "",
        select: async (title, options) => { const choice = menuSelections.shift(); if (choice === undefined) return undefined;
            assert.ok(options.includes(choice), `Unexpected management menu: ${title}`);
            report.events.push({ event: "management_selection", phase, title, choice }); return choice; },
        confirm: async (title, message) => { report.events.push({ event: "verification_consent", phase, title, message }); return true; } } });
    value.session.setActiveToolsByName(kit ? tools : []);
    assert.deepEqual([...value.session.getActiveToolNames()].sort(), kit ? [...tools].sort() : [], "The session must expose the intended tool set before any request");
    return value;
}
async function close() { if (active) { const session = active.session; active = undefined; await disposeSession(session); } }
async function recall(name, kit, agentDir, store, expected = input.expected, empty = false, limits = {}) {
    begin(name, limits.maximum ?? 8);
    active = await open(SessionManager.create(input.cwd, join(agentDir, "sessions")), kit, agentDir);
    const beforeUsage = store?.records(scope).reduce((sum, row) => sum + row.usageCount, 0) ?? 0;
    const eventStart = report.events.length, callStart = report.calls.length;
    try {
        await active.session.prompt(limits.query ?? manifest.query);
        const events = report.events.slice(eventStart), answer = events.filter(event => event.event === "assistant" && event.stopReason === "stop").at(-1)?.text ?? "";
        const first = report.calls[callStart];
        const firstContext = first ? JSON.parse(await readFile(join(directory, `request-${first.id}.json`), "utf8")).context : undefined;
        const injection = (firstContext?.messages ?? []).filter(message => JSON.stringify(message.content).includes("CODEX_MEMORY_V2"));
        const ordinary = JSON.stringify({ systemPrompt: firstContext?.systemPrompt, tools: firstContext?.tools,
            messages: (firstContext?.messages ?? []).filter(message => !JSON.stringify(message.content).includes("CODEX_MEMORY_V2")) });
        const hasOutsideMemoryLeak = ["service", "region", "verify_command", "release_gate"].some(field => ordinary.includes(expected[field]));
        const audit = auditRecall({ answer, events, expected, obsoleteGate: input.obsoleteGate,
            usageDelta: (store?.records(scope).reduce((sum, row) => sum + row.usageCount, 0) ?? 0) - beforeUsage,
            isFresh: true, isEmptyControl: empty, firstContext });
        return { answer, query: limits.query ?? manifest.query,
            sessionId: active.session.sessionManager.getSessionId(), activeTools: active.session.getActiveToolNames(),
            injectedBytes: injection.reduce((sum, message) => sum + Buffer.byteLength(textOf(message.content)), 0),
            hasOutsideMemoryLeak, callIds: report.calls.slice(callStart).map(call => call.id), audit,
            passed: audit.passed && !hasOutsideMemoryLeak && (empty ? injection.length === 0 : injection.length > 0) };
    } finally { await close(); }
}
async function generate(name, kit, store, settings, command = "extract") {
    begin(name, 2);
    const callStart = report.calls.length, eventStart = report.events.length, entryStart = active.session.sessionManager.getEntries().length;
    const before = store.records(scope).map(row => ({ id: row.id, fingerprint: row.source?.fingerprint, bodySHA256: sha256(row.body) }));
    store.saveSettings(scope, { ...settings, generateMemories: true });
    try { await active.session.prompt(`/codex-memory ${command}`); }
    finally { store.saveSettings(scope, settings); }
    const entries = active.session.sessionManager.getEntries().slice(entryStart).filter(entry => entry.type === "custom_message");
    let pipelineResult = null;
    for (const entry of entries.filter(entry => entry.customType === "pi-codex-memory.status")) { try { pipelineResult = JSON.parse(textOf(entry.content)); } catch {} }
    const errors = [...entries.filter(entry => entry.customType === "pi-codex-memory.error").map(entry => textOf(entry.content)),
        ...report.events.slice(eventStart).filter(event => event.event === "ui_notice" && event.level === "error").map(event => event.message)];
    const source = kit.currentSource(active.session.sessionManager, settings.maxInputBytes - 8192);
    const records = store.records(scope), calls = report.calls.slice(callStart), state = store.state(scope);
    const actualExtraction = calls.filter(call => call.kind === "extraction" && call.stopReason === "stop").length === 1 && pipelineResult?.extracted === 1;
    return { before, source, records, state, pipelineResult, errors, actualExtraction,
        callIds: calls.map(call => call.id), passed: actualExtraction && pipelineResult.failed === 0 && !!state.summary && errors.length === 0 &&
            records.some(record => record.source?.id === source?.id && record.source.fingerprint === source.fingerprint) };
}
function restoreVerifiedMemory(kit, store, settings, prior) {
    const first = prior.generation.find(item => item.label === "before-compaction-generation" && item.hasFullMemory);
    assert.ok(first, "No previously verified generation to restore");
    const now = Date.now(); store.saveSettings(scope, settings);
    for (const record of first.snapshot.records) {
        const lease = store.claim(scope, `extract:${record.source.id}`, record.source.fingerprint, now, settings, true);
        assert.ok(lease);
        const slug = basename(record.path, ".md").replace(/^[a-f0-9]+-/, "");
        assert.ok(store.completeExtraction(lease, { ...record.source, text: "" }, record.body, slug, now));
        assert.equal(store.records(scope).find(item => item.id === record.id)?.body, record.body);
    }
    const lease = store.claim(scope, "consolidate", `verified-fixture:${sha256(first.snapshot.state.summary)}`, now, settings, true);
    assert.ok(store.completeConsolidation(lease, store.state(scope).revision, first.snapshot.state.inputs, first.snapshot.state.summary, now));
    return { kind: "restored-prior-verified-model-output", originalSourceFingerprint: first.source.fingerprint,
        bodyHashes: first.snapshot.records.map(record => sha256(record.body)), newModelCalls: 0 };
}

async function finishForgetting(kit, store, settings, agentDir, expected) {
    begin("current-forgotten-idle", 2);
    const sourceFile = active.session.sessionManager.getSessionFile();
    const minimumIdleMs = 60000;
    const waitMs = Math.max(0, (await stat(sourceFile)).mtimeMs + minimumIdleMs + 1000 - Date.now());
    if (waitMs) await delay(waitMs, undefined, { signal: deadline });
    const scanSettings = { ...settings, minIdleMs: minimumIdleMs };
    const eligible = await kit.scanSources({ agentDir, cwd: input.cwd, sessionDir: active.session.sessionManager.getSessionDir(),
        scope, settings: scanSettings, signal: deadline, nowMs: Date.now() });
    report.mutation.scanEligibility = { minimumIdleMs, waitMs, sourceIds: eligible.map(source => source.id) };
    assert.ok(eligible.some(source => source.id === input.sourceSessionId), "The forgotten source must be eligible, not merely skipped by age");
    const callsBefore = report.calls.length;
    report.mutation.forgottenRescan = await generate("current-forgotten-scan", kit, store, scanSettings, "run");
    report.mutation.forgottenStayedAbsent = store.records(scope).length === 0 && report.calls.length === callsBefore &&
        report.mutation.forgottenRegeneration.pipelineResult?.skipped >= 1 && report.mutation.forgottenRescan.pipelineResult?.skipped >= 1 &&
        store.isForgotten(scope, input.sourceSessionId);
    await close(); await checkpoint();
    report.mutation.forgottenRecall = await recall("current-forgotten-recall", kit, agentDir, store, expected, true, { maximum: 8,
        query: manifest.query + "\n목록의 memory_summary.md는 빈 요약 서식일 수 있습니다. 파일 이름만으로 기억한 사실이 있다고 판단하지 말고 필요한 본문을 확인하세요." });
    report.mutation.passed = report.mutation.generation.passed && report.mutation.correctionRecall.passed &&
        report.mutation.realCompactionAfterForget && report.mutation.forgottenStayedAbsent && report.mutation.forgottenRecall.passed;
}

try {
    if (isForgettingFinish) {
        const priorDirectory = join(root, `${key}-recall-recheck`);
        const prior = JSON.parse(await readFile(join(priorDirectory, "result.json"), "utf8"));
        assert.ok(prior.cases.current.passed && prior.mutation.correctionRecall.passed && prior.mutation.realCompactionAfterForget);
        report.reusedFrom = join(priorDirectory, "result.json");
        report.mutation = { ...prior.mutation, reusedEarlierEvidence: report.reusedFrom };
        const kit = kits.current, agentDir = join(directory, "current-agent"), settings = settingsFor(kit);
        await cp(join(priorDirectory, "current-agent"), agentDir, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
        const store = new kit.MemoryStore(join(agentDir, "pi-codex-memory"));
        try {
            assert.equal(store.records(scope).length, 0); assert.ok(store.isForgotten(scope, input.sourceSessionId));
            active = await open(SessionManager.open(join(agentDir, "source.jsonl"), agentDir), kit, agentDir);
            await finishForgetting(kit, store, settings, agentDir, prior.mutation.expected);
            report.status = report.mutation.passed ? "passed" : "failed";
        } finally { await close(); store.close(); }
    } else {
    const continued = join(isRecallRecheck ? join(root, key) : directory, "continued-source.jsonl");
    const originalReport = isRecallRecheck ? JSON.parse(await readFile(join(root, key, "result.json"), "utf8")) : null;
    if (!isRecallRecheck) {
        await cp(input.source, continued, { errorOnExist: true, force: false });
        begin("post-compaction-real-turn", 1);
        active = await open(SessionManager.open(continued, directory), null, join(directory, "preparation"), true);
        active.session.setActiveToolsByName([]);
        await active.session.prompt("이 메시지는 진행 확인용이며 기존 확정 결정을 변경하지 않습니다. 새 행동을 실행하지 말고 '확인했습니다.'만 답하세요.");
        assert.equal(report.events.filter(event => event.event === "assistant").at(-1)?.stopReason, "stop");
        await close();
        report.cases.disabled = await recall("disabled-recall", null, join(directory, "disabled-agent"), null, input.expected, true);
    } else {
        report.reusedFrom = join(root, key, "result.json");
        report.cases.disabled = { ...originalReport.cases.disabled, reused: true, evidenceDirectory: join(root, key) };
    }
    report.continuedInputSHA256 = sha256(await readFile(continued)); await checkpoint();
    const prior = JSON.parse(await readFile(join(root, "../compaction-verification", `${key}-medium`, "result.json"), "utf8"));
    for (const variant of ["previous", "current"]) {
        const kit = kits[variant], agentDir = join(directory, `${variant}-agent`), settings = settingsFor(kit);
        if (isRecallRecheck) await cp(join(root, key, `${variant}-agent`), agentDir, { recursive: true, errorOnExist: true, force: false });
        else await mkdir(agentDir, { recursive: true, mode: 0o700 });
        const sourceFile = join(agentDir, "source.jsonl");
        if (!isRecallRecheck) await cp(continued, sourceFile, { errorOnExist: true, force: false });
        const store = new kit.MemoryStore(join(agentDir, "pi-codex-memory"));
        const row = report.cases[variant] = { packagePath: variant === "previous" ? manifest.previousPackage : currentPath,
            sourceInputSHA256: isRecallRecheck ? originalReport.cases[variant].sourceInputSHA256 : sha256(await readFile(sourceFile)),
            restoredMemory: isRecallRecheck ? originalReport.cases[variant].restoredMemory : restoreVerifiedMemory(kit, store, settings, prior) };
        if (isRecallRecheck) {
            assert.deepEqual(store.records(scope).map(record => sha256(record.body)), originalReport.cases[variant].generation.records.map(record => sha256(record.body)), "Reuse unchanged generation, not a new model attempt");
            row.generation = { ...originalReport.cases[variant].generation, reused: true, evidenceDirectory: join(root, key) };
        }
        try {
            if (!isRecallRecheck) {
                active = await open(SessionManager.open(sourceFile, agentDir), kit, agentDir);
                row.generation = await generate(`${variant}-generation`, kit, store, settings);
                await close(); await checkpoint();
            }
            row.recall = await recall(`${variant}-recall`, kit, agentDir, store);
            row.passed = row.generation.passed && row.recall.passed;
            await checkpoint();
            if (variant === "current" && row.passed) {
                const corrected = { ...input.expected, release_gate: `cobalt-${randomBytes(4).toString("hex")}` };
                active = await open(SessionManager.open(sourceFile, agentDir), kit, agentDir);
                active.session.setActiveToolsByName([]); begin("current-correction-turn", 1);
                await active.session.prompt(`이 프로젝트의 최종 정정입니다. release_gate=${corrected.release_gate}로 바꾸고 앞선 release_gate 값은 폐기합니다. service, region, verify_command, decision_scope와 당시 미실행 기록은 유지합니다. 어떤 명령도 실행하지 말고 확인했다는 한 문장만 답하세요.`);
                report.mutation.expected = corrected;
                report.mutation.generation = await generate("current-correction-generation", kit, store, settings);
                await close();
                report.mutation.correctionRecall = await recall("current-correction-recall", kit, agentDir, store, corrected);
                active = await open(SessionManager.open(sourceFile, agentDir), kit, agentDir);
                const record = store.records(scope).find(item => item.source?.id === input.sourceSessionId);
                assert.ok(record, "Corrected rollout is missing");
                begin("current-forget-management", 1);
                menuSelections = ["기억 조회·정정·잊기", record.path, "잊기", "닫기"];
                await active.session.prompt("/codex-memory");
                assert.equal(menuSelections.length, 0);
                assert.ok(store.isForgotten(scope, input.sourceSessionId));
                active.session.setActiveToolsByName([]);
                begin("current-after-forget-turn", 1);
                await active.session.prompt("잊기로 삭제한 기억은 복원하지 마세요. 새 실행 요청이나 결정 변경은 없습니다. '확인했습니다.'만 답하세요.");
                begin("current-after-forget-compaction", 2);
                active.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 512 } });
                const compactionStart = report.calls.length, eventStart = report.events.length;
                await active.session.compact();
                report.mutation.realCompactionAfterForget = report.calls.slice(compactionStart).some(call => call.kind === "compaction" && call.stopReason === "stop") &&
                    report.events.slice(eventStart).some(event => event.event === "compacted" && !event.fromExtension);
                report.mutation.forgottenRegeneration = await generate("current-forgotten-extract", kit, store, settings);
                await finishForgetting(kit, store, settings, agentDir, corrected);
            }
        } finally { await close(); store.close(); }
    }
    report.status = report.cases.disabled.passed && report.cases.current.passed && report.mutation.passed ? "passed" : "failed";
    }
} catch (error) { report.status = "failed"; report.errors.push({ phase, message: mask(String(error.stack ?? error)) }); }
finally { await close(); report.finishedAt = new Date().toISOString(); await checkpoint(); }
console.log(JSON.stringify({ model: key, status: report.status, calls: report.calls.length,
    variants: Object.fromEntries(Object.entries(report.cases).map(([name, row]) => [name, { passed: row.passed, facts: (row.recall ?? row).audit?.facts }])),
    mutation: report.mutation.passed, errors: report.errors.map(error => ({ phase: error.phase, message: error.message.slice(0,500) })) }));
process.exitCode = report.status === "passed" ? 0 : 1;
