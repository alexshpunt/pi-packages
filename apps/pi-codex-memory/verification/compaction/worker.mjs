import { cp, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../../dist/config.js";
import { createMemoryMasker, workspaceScope } from "../../dist/safety.js";
import { currentSource } from "../../dist/sources.js";
import { MemoryStore } from "../../dist/store.js";
import { disposeSession, liveSession, privateJSON } from "../live/runtime.mjs";
import { auditRecall } from "./audit.mjs";
import { MODELS, QUERY, sha256 } from "./fixtures.mjs";

const root = resolve(process.argv[2]),
    key = process.argv[3],
    length = process.argv[4];
const target = MODELS.find((model) => model.key === key);
if (!target) throw new Error("Unknown compaction verification model.");
const manifest = JSON.parse(
    await readFile(join(root, "manifest.json"), "utf8"),
);
const fixture = JSON.parse(
    await readFile(join(root, `${length}-fixture.json`), "utf8"),
);
const isRecallRecheck = process.argv[5] === "recall-recheck";
const directory = join(
    root,
    `${key}-${length}${isRecallRecheck ? "-recall-recheck" : ""}`,
);
await mkdir(directory, { recursive: true, mode: 0o700 });
if (isRecallRecheck)
    await cp(
        join(root, `${key}-${length}`, "agent"),
        join(directory, "agent"),
        { recursive: true, force: false, errorOnExist: true },
    );
const cwd = manifest.workspaces[`${key}-${length}`],
    agentDir = join(directory, "agent"),
    sessionDir = join(agentDir, "sessions");
await mkdir(sessionDir, { recursive: true, mode: 0o700 });
await mkdir(cwd, { recursive: true, mode: 0o700 });
const mask = createMemoryMasker();
const settings = {
    ...DEFAULT_SETTINGS,
    extractModel: {
        provider: target.provider,
        id: target.id,
        ...(key === "luna" ? { reasoning: "high" } : {}),
    },
    consolidateModel: {
        provider: target.provider,
        id: target.id,
        ...(key === "luna" ? { reasoning: "high" } : {}),
    },
    maxAttempts: 1,
};
const report = {
    target,
    length,
    nodeVersion: process.version,
    startedAt: new Date().toISOString(),
    status: "running",
    fixture: {
        turns: fixture.turns,
        actualInputBytes: fixture.actualInputBytes,
        inputSHA256: fixture.inputSHA256,
    },
    query: { revision: 2, text: QUERY },
    reusedGenerationFrom: isRecallRecheck
        ? join(root, `${key}-${length}`)
        : null,
    calls: [],
    events: [],
    checks: {},
    generation: [],
    recalls: {},
    errors: [],
};
let phase = "startup",
    phaseCalls = 0,
    phaseLimit = 8,
    isCompacting = false,
    active;
const lifetime = new AbortController();
const deadline = AbortSignal.any([
    lifetime.signal,
    AbortSignal.timeout(30 * 60_000),
]);
for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
        lifetime.abort();
        active?.session.abortCompaction();
        void active?.session.abort().catch(() => {});
    });
const checkpoint = () => privateJSON(join(directory, "result.json"), report);
const store = new MemoryStore(join(agentDir, "pi-codex-memory"));
const scope = store.scopeFor(cwd);
report.scope = scope;
store.saveSettings(scope, settings);
const records = () => store.records(scope);
const snapshot = () => ({
    records: records(),
    state: store.state(scope),
    status: store.status(scope),
});
const begin = (name, limit = 8) => {
    phase = name;
    phaseCalls = 0;
    phaseLimit = limit;
};
const textOf = (content) =>
    typeof content === "string"
        ? content
        : (content ?? [])
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
const onError = (error) =>
    report.errors.push({ phase, message: mask(String(error.error ?? error)) });

async function openSession(manager, memoryAgentDir = agentDir) {
    const observe = (pi) => {
        pi.on("session_before_compact", (event) => {
            isCompacting = true;
            report.events.push({
                event: "before_compact",
                phase,
                reason: event.reason,
                tokensBefore: event.preparation.tokensBefore,
                settings: event.preparation.settings,
                isSplitTurn: event.preparation.isSplitTurn,
                firstKeptEntryId: event.preparation.firstKeptEntryId,
            });
        });
        pi.on("session_compact", (event) => {
            report.events.push({
                event: "compacted",
                phase,
                reason: event.reason,
                fromExtension: event.fromExtension,
                entry: event.compactionEntry,
            });
            isCompacting = false;
        });
        pi.on("session_compact_failed", (event) => {
            report.events.push({ event: "compact_failed", phase, ...event });
            isCompacting = false;
        });
        pi.on("tool_execution_end", (event) =>
            report.events.push({
                event: "tool_end",
                phase,
                name: event.toolName,
                isError: event.isError,
                result: event.result,
            }),
        );
        pi.on("message_end", (event) => {
            if (event.message.role === "assistant")
                report.events.push({
                    event: "assistant",
                    phase,
                    stopReason: event.message.stopReason,
                    text: textOf(event.message.content),
                    error: event.message.errorMessage
                        ? mask(event.message.errorMessage)
                        : undefined,
                });
        });
    };
    const value = await liveSession({
        cwd,
        providerPaths: manifest.providerPaths,
        target,
        memoryAgentDir,
        includeMemory: true,
        sessionManager: manager,
        extensionFactories: [observe],
        budgetMaximum: manifest.maximumRequests,
        onError,
        settingsOverrides: {
            retry: {
                enabled: false,
                maxRetries: 0,
                provider: { maxRetries: 0, timeoutMs: 180000 },
            },
            compaction: {
                enabled: false,
                keepRecentTokens: fixture.keepRecentTokens,
            },
        },
    });
    const original = value.modelRuntime.streamSimple.bind(value.modelRuntime);
    value.modelRuntime.streamSimple = (model, context, options = {}) => {
        if (++phaseCalls > phaseLimit) {
            report.errors.push({
                phase,
                code: "verification_request_limit",
                maximum: phaseLimit,
            });
            throw new Error(`Verification phase request limit: ${phase}`);
        }
        if (
            !MODELS.some(
                (item) =>
                    item.provider === model.provider && item.id === model.id,
            )
        )
            throw new Error("UNAPPROVED_VERIFICATION_MODEL");
        const system = context.systemPrompt ?? "";
        const kind = system.startsWith("You are part of an agent memory")
            ? "extraction"
            : system.startsWith("Consolidate")
              ? "consolidation"
              : isCompacting
                ? "compaction"
                : "foreground";
        const id = report.calls.length + 1,
            input = JSON.stringify(context);
        const call = {
            id,
            phase,
            kind,
            model: `${model.provider}/${model.id}`,
            inputBytes: Buffer.byteLength(input),
            inputSHA256: sha256(input),
            reasoning: options.reasoning,
            maxTokens: options.maxTokens ?? 8192,
            startedAt: new Date().toISOString(),
            status: "started",
        };
        report.calls.push(call);
        const requestPath = join(directory, `request-${id}.json`);
        // Credentials/headers are deliberately excluded; context contains the approved synthetic conversation.
        const saved = privateJSON(requestPath, { ...call, context });
        const stream = original(model, context, {
            ...options,
            maxTokens: options.maxTokens ?? 8192,
            signal: AbortSignal.any([
                deadline,
                ...(options.signal ? [options.signal] : []),
                AbortSignal.timeout(180000),
            ]),
        });
        const result = stream.result.bind(stream);
        let finished;
        stream.result = () =>
            (finished ??= (async () => {
                try {
                    const response = await result();
                    await saved;
                    const text = textOf(response.content);
                    Object.assign(call, {
                        status: "returned",
                        stopReason: response.stopReason,
                        usage: response.usage,
                        outputBytes: Buffer.byteLength(text),
                        outputSHA256: sha256(text),
                        finishedAt: new Date().toISOString(),
                    });
                    if (response.errorMessage)
                        call.error = mask(response.errorMessage);
                    await privateJSON(join(directory, `response-${id}.json`), {
                        stopReason: response.stopReason,
                        text: mask(text),
                        usage: response.usage,
                    });
                    await checkpoint();
                    return response;
                } catch (error) {
                    call.status = "failed";
                    call.error = mask(String(error));
                    await checkpoint();
                    throw error;
                }
            })());
        return stream;
    };
    await value.session.bindExtensions({
        mode: "rpc",
        onError,
        uiContext: {
            notify(message, level) {
                report.events.push({
                    event: "ui_notice",
                    phase,
                    level,
                    message: mask(message),
                });
            },
            setStatus() {},
            setWidget() {},
            select: async (_title, rows) =>
                rows.find((row) =>
                    row.startsWith("Remember this conversation now"),
                ),
            confirm: async (title, text) => {
                report.events.push({
                    event: "verification_consent",
                    phase,
                    title,
                    text,
                });
                return true;
            },
        },
    });
    return {
        ...value,
        verificationStore:
            memoryAgentDir === agentDir
                ? store
                : new MemoryStore(join(memoryAgentDir, "pi-codex-memory")),
    };
}
async function generate(label) {
    const attempts = [];
    for (let attempt = 0; attempt < 3; attempt++) {
        begin(`${label}-${attempt + 1}`, 2);
        const before = report.calls.length,
            eventStart = report.events.length,
            entryStart = active.session.sessionManager.getEntries().length;
        store.saveSettings(scope, {
            ...settings,
            useMemories: true,
            generateMemories: true,
        });
        await active.session.prompt("/codex-memory-settings");
        const state = snapshot(),
            source = currentSource(
                active.session.sessionManager,
                2 * 1024 * 1024,
            );
        const commandEntries = active.session.sessionManager
            .getEntries()
            .slice(entryStart)
            .filter((entry) => entry.type === "custom_message");
        // The extraction result arrives as a notification sentence.
        let pipelineResult = null;
        for (const event of report.events.slice(eventStart)) {
            if (event.event !== "ui_notice") continue;
            const created = /^Created memories from (\d+)/.exec(event.message),
                failed = /^Memory creation failed for (\d+)/.exec(
                    event.message,
                );
            if (created)
                pipelineResult = { extracted: Number(created[1]), failed: 0 };
            else if (failed)
                pipelineResult = { extracted: 0, failed: Number(failed[1]) };
            else if (event.message === "No new memories were created.")
                pipelineResult = { extracted: 0, failed: 0 };
        }
        const commandErrors = [
            ...commandEntries
                .filter((entry) => entry.customType === "pi-codex-memory.error")
                .map((entry) => textOf(entry.content)),
            ...report.events
                .slice(eventStart)
                .filter(
                    (event) =>
                        event.event === "ui_notice" && event.level === "error",
                )
                .map((event) => event.message),
        ];
        const storedSource = state.records.find(
            (row) => row.source?.id === source?.id,
        )?.source;
        const hasCurrentSource =
            !!storedSource && storedSource.fingerprint === source.fingerprint;
        const hasFullMemory =
            hasCurrentSource &&
            !!state.state.summary &&
            pipelineResult?.failed === 0 &&
            commandErrors.length === 0;
        const result = {
            label,
            attempt: attempt + 1,
            settings: {
                maxInputBytes: settings.maxInputBytes,
                maxOutputTokens: settings.maxOutputTokens,
            },
            hasFullMemory,
            hasCurrentSource,
            pipelineResult,
            commandErrors,
            source,
            snapshot: state,
            callIds: report.calls.slice(before).map((call) => call.id),
        };
        attempts.push(result);
        report.generation.push(result);
        store.saveSettings(scope, { ...settings, generateMemories: false });
        await checkpoint();
        if (hasFullMemory) return result;
        // Preserve the default failure, then change only the applicable declared budget.
        if (
            fixture.actualInputBytes > settings.maxInputBytes &&
            settings.maxInputBytes < 512 * 1024
        )
            settings.maxInputBytes = 512 * 1024;
        else if (settings.maxOutputTokens < 8192)
            settings.maxOutputTokens = 8192;
        else break;
    }
    return attempts.at(-1);
}
async function recall(
    label,
    { isFresh = false, isEmptyControl = false, requestLimit = 8 } = {},
) {
    begin(label, requestLimit);
    active.session.setActiveToolsByName([
        "pi_codex_memory_list",
        "pi_codex_memory_search",
        "pi_codex_memory_read",
    ]);
    const observedUsage = () =>
        active.verificationStore
            .records(scope)
            .reduce((sum, row) => sum + row.usageCount, 0);
    const eventStart = report.events.length,
        callStart = report.calls.length,
        beforeUsage = observedUsage();
    await active.session.prompt(QUERY);
    const events = report.events.slice(eventStart);
    const answer =
        events
            .filter(
                (event) =>
                    event.event === "assistant" && event.stopReason === "stop",
            )
            .at(-1)?.text ?? "";
    const first = report.calls
        .slice(callStart)
        .find((call) => call.kind === "foreground");
    const firstContext = first
        ? JSON.parse(
              await readFile(
                  join(directory, `request-${first.id}.json`),
                  "utf8",
              ),
          ).context
        : undefined;
    const result = {
        answer,
        finalStopReason: events
            .filter((event) => event.event === "assistant")
            .at(-1)?.stopReason,
        sessionId: active.session.sessionManager.getSessionId(),
        eventStart,
        callIds: report.calls.slice(callStart).map((call) => call.id),
        audit: auditRecall({
            answer,
            events,
            expected: fixture.expected,
            obsoleteGate: fixture.obsoleteGate,
            usageDelta: observedUsage() - beforeUsage,
            isFresh,
            isEmptyControl,
            firstContext,
        }),
    };
    report.recalls[label] = result;
    await checkpoint();
    return result;
}

try {
    if (isRecallRecheck) {
        const previous = JSON.parse(
            await readFile(
                join(root, `${key}-${length}`, "result.json"),
                "utf8",
            ),
        );
        const previousScope =
            previous.scope ??
            previous.generation?.at(-1)?.snapshot?.status?.scope ??
            workspaceScope(cwd);
        if (previousScope !== scope)
            throw new Error(
                "RECALL_RECHECK_SCOPE_MISMATCH: use a matching saved scope, not an implicit migration.",
            );
    }
    if (!isRecallRecheck) {
        active = await openSession(SessionManager.create(cwd, sessionDir));
        active.session.setActiveToolsByName([]);
        report.modelLimits = {
            contextWindow: active.model.contextWindow,
            maxTokens: active.model.maxTokens,
            supportedReasoning: active.levels,
        };
        report.sourceSessionId = active.session.sessionManager.getSessionId();
        report.sourceSessionFile =
            active.session.sessionManager.getSessionFile();
        for (let index = 0; index < fixture.prompts.length; index++) {
            begin(`dialogue-${index + 1}`, 1);
            await active.session.prompt(fixture.prompts[index]);
            const last = report.events
                .filter((event) => event.event === "assistant")
                .at(-1);
            if (last?.stopReason !== "stop")
                throw new Error(`Dialogue turn ${index + 1} did not finish.`);
        }
        const originalUser = active.session.sessionManager
            .getEntries()
            .find(
                (entry) =>
                    entry.type === "message" && entry.message.role === "user",
            );
        report.checks.realDialogueTurns =
            report.events.filter(
                (event) =>
                    event.event === "assistant" &&
                    event.phase.startsWith("dialogue-"),
            ).length === fixture.turns;
        const firstGeneration = await generate("before-compaction-generation");
        report.checks.generationBeforeCompaction =
            firstGeneration.hasFullMemory;
        if (records().length) await recall("before-compaction-recall");
        const beforeBodies = records().map((row) => ({
            id: row.id,
            hash: sha256(row.body),
        }));
        const entriesBefore = active.session.sessionManager
            .getEntries()
            .filter((entry) => entry.type === "compaction").length;
        if (length === "long") {
            const tokens = active.session.getContextUsage()?.tokens ?? 16000;
            const threshold = Math.max(1024, Math.floor(tokens * 0.8));
            active.settingsManager.applyOverrides({
                compaction: {
                    enabled: true,
                    reserveTokens: Math.max(
                        0,
                        active.model.contextWindow - threshold,
                    ),
                    keepRecentTokens: fixture.keepRecentTokens,
                },
            });
            report.autoThreshold = {
                observedTokens: tokens,
                thresholdTokens: threshold,
                effectiveSettings: active.settingsManager.getCompactionSettings(
                    active.model,
                ),
            };
            // The real prompt preflight selects and performs automatic threshold compaction.
            await recall("after-compaction-recall", { requestLimit: 10 });
            active.session.setAutoCompactionEnabled(false);
        } else {
            begin("manual-compaction", 2);
            report.compaction = await active.session.compact();
        }
        const compactions = active.session.sessionManager
            .getEntries()
            .filter((entry) => entry.type === "compaction");
        report.checks.realCompaction =
            compactions.length > entriesBefore &&
            !compactions.at(-1)?.fromHook &&
            report.calls.some(
                (call) =>
                    call.kind === "compaction" && call.stopReason === "stop",
            );
        const projection =
            active.session.sessionManager.buildSessionProjection();
        report.projectionAfter = {
            entryIds: projection.entries
                .filter((entry) => entry.messages.length)
                .map((entry) => entry.sourceEntry.id),
            roles: projection.messages.map((message) => message.role),
            bytes: Buffer.byteLength(JSON.stringify(projection.messages)),
        };
        report.checks.originalUserReplacedInContext =
            !report.projectionAfter.entryIds.includes(originalUser.id);
        report.checks.memorySurvivedCompaction =
            JSON.stringify(beforeBodies) ===
            JSON.stringify(
                records().map((row) => ({
                    id: row.id,
                    hash: sha256(row.body),
                })),
            );
        report.compactionSummaryContainsFacts = Object.fromEntries(
            Object.entries(fixture.expected)
                .filter(([, value]) => typeof value === "string")
                .map(([name, value]) => [
                    name,
                    compactions.at(-1)?.summary.includes(value) ?? false,
                ]),
        );
        if (length !== "long" && records().length)
            await recall("after-compaction-recall");
        const secondGeneration = await generate("after-compaction-generation");
        report.checks.generationAfterCompaction =
            secondGeneration.hasFullMemory &&
            secondGeneration.callIds.length > 0;
        report.finalMemory = snapshot();
        report.finalSource = currentSource(
            active.session.sessionManager,
            2 * 1024 * 1024,
        );
        await disposeSession(active.session);
        active = undefined;
    } else {
        report.checks.reusedStoredMemory = records().length > 0;
        report.finalMemory = snapshot();
    }
    active = await openSession(SessionManager.create(cwd, sessionDir));
    if (records().length)
        await recall("fresh-session-recall", { isFresh: true });
    if (length === "short") {
        await disposeSession(active.session);
        active = undefined;
        const controlDir = join(directory, "control-agent");
        await mkdir(join(controlDir, "sessions"), {
            recursive: true,
            mode: 0o700,
        });
        active = await openSession(
            SessionManager.create(cwd, join(controlDir, "sessions")),
            controlDir,
        );
        await recall("empty-memory-control", {
            isFresh: true,
            isEmptyControl: true,
        });
    }
    report.status =
        Object.values(report.checks).every(Boolean) &&
        (isRecallRecheck
            ? ["fresh-session-recall"]
            : [
                  "before-compaction-recall",
                  "after-compaction-recall",
                  "fresh-session-recall",
              ]
        ).every((name) => report.recalls[name]?.audit.passed) &&
        (length !== "short" ||
            report.recalls["empty-memory-control"]?.audit.passed)
            ? "pass"
            : "fail";
} catch (error) {
    report.status = "fail";
    report.errors.push({ phase, message: mask(String(error)) });
} finally {
    if (active) {
        await disposeSession(active.session);
        if (active.verificationStore !== store)
            active.verificationStore.close();
    }
    store.close();
    report.finishedAt = new Date().toISOString();
    await checkpoint();
}
console.log(
    JSON.stringify({
        key,
        length,
        status: report.status,
        calls: report.calls.length,
        checks: report.checks,
        recalls: Object.fromEntries(
            Object.entries(report.recalls).map(([name, value]) => [
                name,
                value.audit,
            ]),
        ),
        errors: report.errors,
        directory,
    }),
);
if (report.status !== "pass") process.exitCode = 1;
