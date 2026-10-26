import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DEFAULT_SETTINGS, parseSettings } from "../../dist/config.js";
import { piMemoryModel, runPipeline } from "../../dist/pipeline.js";
import {
    createMemoryMasker,
    digest,
    workspaceScope,
} from "../../dist/safety.js";
import { MemoryStore } from "../../dist/store.js";
import {
    disposeSession,
    liveSession,
    privateJSON,
    TARGETS,
} from "./runtime.mjs";

const root = resolve(process.argv[2]);
const target = TARGETS.find((item) => item.key === process.argv[3]);
if (!target) throw new Error("Unknown benchmark target.");
let execution = {};
try {
    execution = JSON.parse(
        await readFile(join(root, "execution.json"), "utf8"),
    );
} catch (error) {
    if (error.code !== "ENOENT") throw error;
}
const directory = join(root, target.key);
await mkdir(directory, { recursive: true, mode: 0o700 });
const memoryAgentDir = join(directory, "memory-agent");
const cwd = join(
    execution.reuseGenerationFrom
        ? resolve(execution.reuseGenerationFrom, target.key)
        : directory,
    "workspace",
);
if (execution.reuseGenerationFrom)
    await cp(
        join(
            resolve(execution.reuseGenerationFrom),
            target.key,
            "memory-agent",
        ),
        memoryAgentDir,
        { recursive: true, errorOnExist: true, force: false },
    );
const providerPaths = JSON.parse(
    await readFile(join(root, "provider-paths.json"), "utf8"),
);
const source = JSON.parse(await readFile(join(root, "source.json"), "utf8"));
const mask = createMemoryMasker();
const now = () => new Date().toISOString();
function outputForLog(text) {
    try {
        const body = text
            .trim()
            .replace(/^```(?:json)?\s*\n?/, "")
            .replace(/\s*```$/, "");
        return JSON.stringify(
            JSON.parse(body),
            (_key, value) => (typeof value === "string" ? mask(value) : value),
            2,
        );
    } catch {
        return mask(text);
    }
}
const report = {
    target,
    startedAt: now(),
    status: "running",
    calls: [],
    errors: [],
    recall: null,
    caveats: [
        "One shared real conversation; one measured run per model.",
        "Reported usage/cost is not a verified bill or subscription-quota delta.",
    ],
};
let store, active;
async function checkpoint() {
    await privateJSON(join(directory, "result.json"), report);
}
const sanitizeError = (error) => ({
    name: error?.name ?? "Error",
    message: mask(String(error?.message ?? error)).slice(0, 2500),
});
const onError = (error) => {
    report.errors.push({ source: "extension", ...sanitizeError(error) });
};
const deadline = AbortSignal.timeout(8 * 60_000);
try {
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    store = new MemoryStore(join(memoryAgentDir, "pi-codex-memory"));
    const scope = store.scopeFor(cwd);
    if (
        !execution.reuseGenerationFrom &&
        scope.startsWith("repository-") &&
        source.repository?.scope !== scope
    )
        throw new Error(
            "SOURCE_SCOPE_FIXTURE_MISMATCH: prepare a repository-aware source before requesting models.",
        );
    if (execution.reuseGenerationFrom) {
        const previous = JSON.parse(
            await readFile(
                join(
                    resolve(execution.reuseGenerationFrom),
                    target.key,
                    "result.json",
                ),
                "utf8",
            ),
        );
        if ((previous.storageStatus?.scope ?? workspaceScope(cwd)) !== scope)
            throw new Error(
                "REUSED_MEMORY_SCOPE_MISMATCH: historical stores must not be silently reinterpreted.",
            );
    }
    report.scope = scope;
    active = await liveSession({ cwd, providerPaths, target, onError });
    const choice = {
        provider: target.provider,
        id: target.id,
        ...(target.reasoning ? { reasoning: target.reasoning } : {}),
    };
    const settings = parseSettings({
        ...DEFAULT_SETTINGS,
        extractModel: choice,
        consolidateModel: choice,
        generateMemories: true,
        maxAttempts: 1,
        maxRolloutsPerRun: 1,
        maxCallsPerDay: 6,
        ...(execution.overrides?.[target.key] ?? {}),
    });
    if (!execution.reuseGenerationFrom) store.saveSettings(scope, settings);
    report.settings = settings;
    let currentCall;
    const registry = active.ctx.modelRegistry;
    // Transparent observation around the real Pi stream. No synthetic responses or credentials.
    const observedRegistry = {
        find: registry.find.bind(registry),
        hasConfiguredAuth: registry.hasConfiguredAuth.bind(registry),
        getApiKeyAndHeaders: registry.getApiKeyAndHeaders.bind(registry),
        streamSimple(model, context, options) {
            const call = currentCall;
            call.finalOptions = {
                provider: model.provider,
                model: model.id,
                reasoning: options.reasoning,
                maxTokens: options.maxTokens,
                hasSignal: !!options.signal,
                toolCount: context.tools?.length ?? 0,
                cacheRetention: options.cacheRetention ?? "default",
                hasSessionId: !!options.sessionId,
            };
            const stream = registry.streamSimple(model, context, options);
            return {
                async result() {
                    const response = await stream.result();
                    call.stopReason = response.stopReason;
                    call.reportedModel = response.model;
                    call.reportedProvider = response.provider;
                    call.reportedNativeReasoning =
                        response.providerThinkingLevel ?? null;
                    call.usage = response.usage;
                    const output = response.content
                        .filter((part) => part.type === "text")
                        .map((part) => part.text)
                        .join("\n");
                    call.outputBytes = Buffer.byteLength(output);
                    call.outputHash = digest(output);
                    try {
                        const parsed = JSON.parse(
                            output
                                .trim()
                                .replace(/^```(?:json)?\s*\n?/, "")
                                .replace(/\s*```$/, ""),
                        );
                        call.rawJSONFields = Object.keys(parsed);
                        call.rawSummaryHeadings =
                            typeof parsed.memory_summary === "string"
                                ? parsed.memory_summary
                                      .split("\n")
                                      .filter((line) => line.startsWith("#"))
                                : null;
                    } catch {
                        call.rawJSONFields = null;
                    }
                    await writeFile(
                        join(directory, `${call.stage}-output.txt`),
                        outputForLog(output),
                        { mode: 0o600 },
                    );
                    if (response.errorMessage)
                        call.providerError = mask(response.errorMessage).slice(
                            0,
                            2500,
                        );
                    return response;
                },
            };
        },
    };
    const productionModel = piMemoryModel({
        ...active.ctx,
        modelRegistry: observedRegistry,
    });
    const measuredModel = {
        validate: productionModel.validate,
        async complete(request) {
            const started = performance.now();
            const call = {
                stage: request.stage,
                startedAt: now(),
                inputBytes: Buffer.byteLength(request.input),
                inputHash: digest(request.input),
                systemHash: digest(request.system),
                requestedReasoning:
                    request.model.reasoning ??
                    (request.stage === "extraction" ? "low" : "medium"),
            };
            report.calls.push(call);
            currentCall = call;
            await privateJSON(
                join(directory, `${request.stage}-input.json`),
                JSON.parse(request.input),
            );
            await checkpoint();
            try {
                const response = await productionModel.complete(request);
                call.outputBytes = Buffer.byteLength(response.text);
                await writeFile(
                    join(directory, `${request.stage}-output.txt`),
                    outputForLog(response.text),
                    { mode: 0o600 },
                );
                return response;
            } catch (error) {
                call.error = sanitizeError(error);
                throw error;
            } finally {
                call.elapsedMs = Math.round(performance.now() - started);
                call.finishedAt = now();
                await checkpoint();
            }
        },
    };
    const generationStarted = performance.now();
    if (execution.reuseGenerationFrom) {
        const previous = JSON.parse(
            await readFile(
                join(
                    resolve(execution.reuseGenerationFrom),
                    target.key,
                    "result.json",
                ),
                "utf8",
            ),
        );
        report.generation = previous.generation;
        report.generationReusedFrom = execution.reuseGenerationFrom;
    } else
        report.generation = await runPipeline({
            store,
            scope,
            settings,
            model: measuredModel,
            sources: [source],
            signal: deadline,
            force: true,
        });
    report.generationElapsedMs = Math.round(
        performance.now() - generationStarted,
    );
    report.records = store.records(scope);
    report.summary = store.state(scope).summary;
    report.storageStatus = store.status(scope);
    await checkpoint();
    await disposeSession(active.session);
    active = undefined;
    store.close();
    store = undefined;
    const hasMemory =
        report.records.some((record) => record.kind === "rollout") &&
        report.summary;
    if (!hasMemory || report.generation.failed) {
        report.status = report.calls.some(
            (call) => call.error || call.stopReason === "error",
        )
            ? "generation_failed"
            : "no_usable_memory";
    } else {
        // A new Pi session loads only persisted memory, not the original conversation.
        active = await liveSession({
            cwd,
            providerPaths,
            target,
            memoryAgentDir,
            includeMemory: true,
            onError,
        });
        if (
            !active.session
                .getActiveToolNames()
                .includes("pi_codex_memory_read")
        )
            throw new Error("Recall tool exposure missing.");
        report.recall = {
            startedAt: now(),
            requests: [],
            toolResults: [],
            contextContainsMemory: false,
        };
        const recall = report.recall;
        const originalStream = active.session.agent.streamFunction;
        active.session.agent.streamFunction = async (
            model,
            context,
            options,
        ) => {
            if (recall.requests.length >= 3)
                throw new Error("Benchmark recall model-request cap reached.");
            const content = JSON.stringify(context.messages);
            const memoryMessages = context.messages.filter((message) =>
                JSON.stringify(message.content).includes("CODEX_MEMORY_V2"),
            );
            recall.contextContainsMemory ||= memoryMessages.length > 0;
            await privateJSON(
                join(
                    directory,
                    `recall-request-${recall.requests.length + 1}.json`,
                ),
                JSON.parse(mask(JSON.stringify(context))),
            );
            recall.requests.push({
                provider: model.provider,
                model: model.id,
                reasoning: options?.reasoning ?? null,
                inputBytes: Buffer.byteLength(content),
                memoryMessageCount: memoryMessages.length,
                startedAt: now(),
            });
            return originalStream(model, context, {
                ...options,
                maxTokens: 4096,
                maxRetries: 0,
                signal: AbortSignal.any([
                    deadline,
                    AbortSignal.timeout(120000),
                    ...(options?.signal ? [options.signal] : []),
                ]),
            });
        };
        const toolInputs = new Map();
        active.session.subscribe((event) => {
            if (event.type === "tool_execution_start")
                toolInputs.set(event.toolCallId, event.args);
            if (event.type === "tool_execution_end")
                recall.toolResults.push({
                    toolName: event.toolName,
                    isError: event.isError,
                    args: toolInputs.get(event.toolCallId),
                    result: event.result,
                });
            if (
                event.type === "message_end" &&
                event.message.role === "assistant"
            ) {
                const call = recall.requests.at(-1);
                if (call)
                    Object.assign(call, {
                        stopReason: event.message.stopReason,
                        usage: event.message.usage,
                        reportedNativeReasoning:
                            event.message.providerThinkingLevel ?? null,
                        finishedAt: now(),
                    });
            }
        });
        const prompt =
            "이전 pi-codex-memory 작업을 이어받았다고 생각하고 기억을 조회해 한국어로 답하세요. 현재 저장소를 읽거나 추측하지 말고 기억에 없는 것은 모른다고 하세요. 필요하면 메모리 도구만 사용하세요.\n" +
            "1. 최종 패키지명과 관리 명령은 무엇이며 처음 제안과 어떻게 달라졌나요?\n" +
            "2. 사용자가 최종적으로 요구한 구현 범위와 번들 포함 여부는 무엇인가요? memory_version은 요약 파일 첫 줄의 형식 번호가 아니라 구현 대상 Codex memory 워크플로의 버전입니다.\n" +
            "3. 어떤 검증을 실제로 완료했고 무엇이 아직 미검증인가요? 나중의 실모델 벤치마크 요청도 완료 사실과 구분하세요.\n" +
            "4. 선택한 추출·통합 시간과 Codex의 6시간은 각각 무엇을 뜻하나요? 실사용 최적값으로 입증됐나요?\n" +
            "5. worktree, 브랜치, 커밋·게시·개인 설정 변경 여부를 기억에 있는 범위에서 알려주세요.\n" +
            "6. 이 작업에서의 검증 선택이나 승인을 향후 모든 작업의 선호·실행 권한으로 일반화할 수 있나요?\n" +
            "출처를 실제로 조회해 사용했다면 제공된 메모리 인용 형식을 지키세요. 간결하되 상태와 불확실성을 생략하지 마세요.\n" +
            "답변에 <fact_check>JSON</fact_check>를 추가하세요. 다음 키에 기억 근거에 따른 값만 넣으세요(알 수 없으면 null): command(string), command_requested_by_user(boolean), memory_version(number), bundle_requested(boolean), codex_six_hours_is_cache_ttl(boolean), extraction_idle_minutes(number), consolidation_cooldown_minutes(number), timing_proven_optimal(boolean), live_verification_done_at_source_cutoff(boolean), cross_task_authorization(boolean), benchmark_provider_for_astra(string).";
        await writeFile(join(directory, "recall-prompt.txt"), prompt, {
            mode: 0o600,
        });
        const started = performance.now();
        await active.session.prompt(prompt);
        recall.elapsedMs = Math.round(performance.now() - started);
        recall.answer = active.session.getLastAssistantText() ?? "";
        const assistants = active.session.messages.filter(
            (message) => message.role === "assistant",
        );
        recall.finalStopReason = assistants.at(-1)?.stopReason;
        recall.finishedAt = now();
        await writeFile(
            join(directory, "recall-answer.md"),
            mask(recall.answer),
            { mode: 0o600 },
        );
        // Without a UI, /codex-memory prints the status JSON.
        await active.session.prompt("/codex-memory");
        const statusMessage = active.session.messages
            .filter(
                (message) => message.customType === "pi-codex-memory.status",
            )
            .at(-1);
        recall.evidence = statusMessage
            ? JSON.parse(statusMessage.content).recall
            : null;
        const expected = {
            command: "/codex-memory",
            command_requested_by_user: true,
            memory_version: 2,
            bundle_requested: true,
            codex_six_hours_is_cache_ttl: false,
            extraction_idle_minutes: 30,
            consolidation_cooldown_minutes: 60,
            timing_proven_optimal: false,
            live_verification_done_at_source_cutoff: false,
            cross_task_authorization: false,
            benchmark_provider_for_astra: "openai-codex",
        };
        try {
            recall.facts = JSON.parse(
                /<fact_check>([\s\S]*?)<\/fact_check>/.exec(
                    recall.answer,
                )?.[1] ?? "null",
            );
        } catch {
            recall.facts = null;
        }
        recall.factChecks = Object.fromEntries(
            Object.entries(expected).map(([key, value]) => [
                key,
                recall.facts?.[key] === value,
            ]),
        );
        recall.factsPassed = Object.values(recall.factChecks).every(Boolean);
        recall.citationsPassed =
            !!recall.evidence &&
            recall.evidence.citations.valid > 0 &&
            recall.evidence.citations.invalid === 0;
        report.status =
            recall.answer &&
            recall.contextContainsMemory &&
            recall.finalStopReason === "stop"
                ? "completed"
                : "recall_failed";
        report.semanticStatus =
            recall.factsPassed && recall.citationsPassed ? "pass" : "fail";
    }
} catch (error) {
    report.status = "failed";
    report.errors.push(sanitizeError(error));
} finally {
    if (active) {
        try {
            await disposeSession(active.session);
        } catch (error) {
            report.errors.push({ source: "cleanup", ...sanitizeError(error) });
        }
    }
    if (store) store.close();
    report.finishedAt = now();
    await checkpoint();
}
console.log(
    JSON.stringify({
        target: target.key,
        status: report.status,
        generation: report.generation,
        calls: report.calls.map((call) => ({
            stage: call.stage,
            elapsedMs: call.elapsedMs,
            stopReason: call.stopReason,
        })),
        recallRequests: report.recall?.requests.length ?? 0,
    }),
);
