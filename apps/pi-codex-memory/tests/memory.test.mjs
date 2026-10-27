import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    mkdtemp,
    readdir,
    readFile,
    rm,
    stat,
    symlink,
    utimes,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import {
    DEFAULT_SETTINGS,
    isSourceEligible,
    parseSettings,
} from "../dist/config.js";
import { MemoryFailure, memoryFailureCode } from "../dist/failure.js";
import {
    createStages,
    EMPTY_SUMMARY,
    parseConsolidation,
    parseExtraction,
    piMemoryModel,
    runPipeline,
} from "../dist/pipeline.js";
import { buildInjection, MemoryReader } from "../dist/retrieval.js";
import {
    createMemoryGroundingGuard,
    fitJSONString,
    jsonStringBytes,
    truncateBytes,
    truncateMiddleBytes,
    workspaceScope,
} from "../dist/safety.js";
import { readSource, renderProjection, scanSources } from "../dist/sources.js";
import { MemoryStore } from "../dist/store.js";

async function fixture(t) {
    const dir = await mkdtemp(join(tmpdir(), "pi-memory-test-"));
    const store = new MemoryStore(join(dir, "memory"));
    const scope = workspaceScope(dir);
    const settings = parseSettings({
        ...DEFAULT_SETTINGS,
        useMemories: true,
        generateMemories: true,
        extractModel: { provider: "fixture", id: "extract" },
        consolidateModel: { provider: "fixture", id: "consolidate" },
    });
    store.saveSettings(scope, settings);
    t.after(async () => {
        store.close();
        await rm(dir, { recursive: true, force: true });
    });
    const calls = [];
    const model = {
        async complete(request) {
            calls.push(request);
            if (request.stage === "extraction")
                return {
                    text: JSON.stringify({
                        rollout_summary:
                            "# Task\n사용자는 이 작업에서 검증을 요청했다.\n상태: 완료, 배포는 미확인.\napi_key=MODEL_SECRET_123456",
                        rollout_slug: "test-task",
                    }),
                    usage: { input: 10, output: 20, cost: { total: 0.001 } },
                };
            const documents = JSON.parse(request.input).documents;
            return {
                text: JSON.stringify({
                    memory_summary:
                        EMPTY_SUMMARY +
                        documents
                            .map(
                                (document) =>
                                    `- ${document.path} — task history; thread_id=${document.thread_id}`,
                            )
                            .join("\n"),
                }),
            };
        },
    };
    const source = {
        id: "session-1",
        cwd: dir,
        file: "",
        leafId: "last",
        updatedAtMs: Date.now() - 3_600_000,
        fingerprint: "first",
        text: "human user: verify this task\npassword=INPUT_SECRET_123456",
    };
    const run = (options = {}) =>
        runPipeline({
            store,
            scope,
            settings,
            model,
            sources: [source],
            signal: new AbortController().signal,
            ...options,
        });
    return { dir, store, scope, settings, calls, model, source, run };
}
test("v2 extraction -> incremental consolidation -> files, recall, citations and restart", async (t) => {
    const f = await fixture(t);
    assert.deepEqual(await f.run(), {
        extracted: 1,
        consolidated: true,
        failed: 0,
        skipped: 0,
    });
    assert.equal(f.calls.length, 2);
    assert.ok(
        f.calls.every((call) => !call.input.includes("INPUT_SECRET_123456")),
    );
    assert.equal(f.calls[0].maxOutputTokens, DEFAULT_SETTINGS.maxOutputTokens);
    assert.equal(f.calls[0].model.id, "extract");
    assert.equal(f.calls[1].model.id, "consolidate");
    const record = f.store.records(f.scope)[0];
    assert.ok(!record.body.includes("MODEL_SECRET_123456"));
    assert.ok(!("raw_memory" in record));
    assert.equal(
        (await stat(join(f.store.root, "state.sqlite"))).mode & 0o777,
        0o600,
    );
    assert.equal(
        await readFile(
            join(f.store.artifactRoot(f.scope), record.path),
            "utf8",
        ),
        f.store.document(record),
    );
    const reader = new MemoryReader(f.store, f.scope);
    assert.equal(reader.list({}).entries[0].entry_type, "file");
    assert.equal(
        reader.search({ queries: ["검증"] }).matches[0].path,
        record.path,
    );
    const read = reader.read({ path: record.path, line_offset: 1 });
    assert.equal(
        read.end_line_number,
        f.store.document(record).split("\n").length,
    );
    assert.equal(
        read.citation,
        `${record.path}:1-${read.end_line_number}|note=[read evidence]`,
    );
    assert.match(read.content, /thread_id: session-1/);
    reader.recordCitations(
        `<oai-mem-citation>\n<citation_entries>\n${record.path}:1-3|note=[used]\n</citation_entries>\n<rollout_ids>\nsession-1\n</rollout_ids>\n</oai-mem-citation>`,
    );
    assert.equal(f.store.records(f.scope)[0].usageCount, 1);
    assert.match(
        buildInjection(f.store, f.scope, f.settings),
        /MEMORY_SUMMARY BEGINS/,
    );
    assert.deepEqual(await f.run(), {
        extracted: 0,
        consolidated: false,
        failed: 0,
        skipped: 1,
    });
    assert.equal(
        f.calls.length,
        2,
        "unchanged input must not call either model again",
    );
    const reopened = new MemoryStore(f.store.root);
    assert.equal(reopened.records(f.scope)[0].body, record.body);
    reopened.close();
    const otherScope = workspaceScope(join(f.dir, "other"));
    f.store.saveSettings(otherScope, {
        ...DEFAULT_SETTINGS,
        useMemories: true,
    });
    assert.equal(
        new MemoryReader(f.store, otherScope).list({}).entries.length,
        0,
    );
});
test("notes, corrections, forgetting and reset invalidate summaries and block resurrection", async (t) => {
    const f = await fixture(t);
    await f.run();
    const path = f.store.records(f.scope)[0].path;
    f.store.revise(f.scope, path, "사용자의 정정: 검증은 로컬에서만 수행한다.");
    assert.equal(f.store.state(f.scope).summary, "");
    assert.equal(f.store.isForgotten(f.scope, f.source.id), true);
    assert.ok(!f.store.records(f.scope).some((record) => record.path === path));
    assert.equal((await f.run({ force: true })).extracted, 0);
    assert.match(f.store.state(f.scope).summary, /extensions\/ad_hoc\/notes/);
    const note = f.store.addNote(f.scope, "개인 전역으로 일반화하지 않는다.");
    assert.match(buildInjection(f.store, f.scope, f.settings), /개인 전역으로/);
    f.store.revise(f.scope, note.path, null);
    assert.throws(
        () => new MemoryReader(f.store, f.scope).read({ path: note.path }),
        /not found/,
    );
    f.store.reset(f.scope);
    assert.equal(f.store.records(f.scope).length, 0);
    assert.equal(
        await readFile(
            join(f.store.artifactRoot(f.scope), "memory_summary.md"),
            "utf8",
        ),
        "",
    );
    assert.equal(
        (
            await readdir(
                join(f.store.artifactRoot(f.scope), "rollout_summaries"),
            )
        ).length,
        0,
    );
    assert.equal(f.store.isForgotten(f.scope, f.source.id), true);
});
test("a whole-response JSON fence is normalized without accepting prose, extra fields or truncated JSON", () => {
    const object = {
        rollout_summary: "verified source",
        rollout_slug: "verified",
    };
    assert.deepEqual(
        parseExtraction(`\`\`\`json\n${JSON.stringify(object)}\n\`\`\``),
        object,
    );
    assert.deepEqual(
        parseExtraction(`\`\`\`\n${JSON.stringify(object)}\n\`\`\``),
        object,
    );
    assert.throws(() =>
        parseExtraction(
            `preface\n\`\`\`json\n${JSON.stringify(object)}\n\`\`\``,
        ),
    );
    assert.throws(() =>
        parseExtraction(`\`\`\`json\n${JSON.stringify(object)}`),
    );
    assert.throws(() =>
        parseExtraction(
            "```json\n" +
                JSON.stringify({ ...object, raw_memory: "unsupported" }) +
                "\n```",
        ),
    );
});
test("strict v2 schema, empty extraction, malformed outputs and bounded retries", async (t) => {
    assert.throws(() =>
        parseExtraction(
            '{"rollout_summary":"x","rollout_slug":"x","raw_memory":"x"}',
        ),
    );
    assert.throws(() =>
        parseConsolidation(
            JSON.stringify({
                memory_summary: `${EMPTY_SUMMARY}rollout_summaries/invented.md`,
            }),
            new Set(),
        ),
    );
    assert.throws(() =>
        parseConsolidation(
            JSON.stringify({
                memory_summary: EMPTY_SUMMARY + "가".repeat(4000),
            }),
            new Set(),
        ),
    );
    const f = await fixture(t);
    let calls = 0;
    const bad = {
        async complete() {
            calls++;
            return { text: "not JSON" };
        },
    };
    assert.equal((await f.run({ model: bad })).failed, 1);
    const previous = calls;
    await f.run({ model: bad });
    assert.equal(calls, previous, "backoff must block immediate repeat");
    const empty = {
        async complete() {
            return { text: '{"rollout_summary":"","rollout_slug":""}' };
        },
    };
    assert.equal((await f.run({ model: empty, force: true })).extracted, 1);
    assert.equal(f.store.records(f.scope).length, 0);
});
test("caller abort reaches final model; ignoring cancellation cannot publish late output", async (t) => {
    const f = await fixture(t);
    const controller = new AbortController();
    let resolve, seen;
    const model = {
        complete(request) {
            seen = request.signal;
            return new Promise((done) => {
                resolve = done;
            });
        },
    };
    const pending = f.run({ model, signal: controller.signal });
    await new Promise((done) => setImmediate(done));
    controller.abort();
    await assert.rejects(pending);
    assert.equal(seen.aborted, true);
    resolve({ text: '{"rollout_summary":"late","rollout_slug":"late"}' });
    await new Promise((done) => setImmediate(done));
    assert.equal(f.store.records(f.scope).length, 0);
    assert.equal(f.store.status(f.scope).jobs[0].status, "cancelled");
});
test("changed source, settings, and deletion generation reject stale completions", async (t) => {
    const f = await fixture(t);
    assert.equal(
        (await f.run({ checkSource: async () => false })).extracted,
        0,
    );
    let release;
    const pending = f.run({
        model: {
            complete() {
                return new Promise((resolve) => {
                    release = resolve;
                });
            },
        },
        force: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    f.store.saveSettings(f.scope, { ...f.settings, generateMemories: false });
    release({ text: '{"rollout_summary":"stale","rollout_slug":"stale"}' });
    await pending;
    assert.equal(f.store.records(f.scope).length, 0);
});
test("cross-process lease exclusion, expiry, and ownership checks", async (t) => {
    const f = await fixture(t);
    const now = Date.now();
    const first = f.store.claim(
        f.scope,
        "extract:session-1",
        "first",
        now,
        f.settings,
    );
    assert.ok(first);
    const script = `import {MemoryStore} from ${JSON.stringify(new URL("../dist/store.js", import.meta.url).href)};
        const store=new MemoryStore(${JSON.stringify(f.store.root)});
        console.log(JSON.stringify(store.claim(${JSON.stringify(f.scope)},'extract:session-1','first',${now},${JSON.stringify(f.settings)})));store.close();`;
    const child = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", script],
        { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), "null");
    const second = f.store.claim(
        f.scope,
        first.key,
        "first",
        now + f.settings.timeoutMs + 10_001,
        f.settings,
    );
    assert.ok(second);
    assert.notEqual(second.owner, first.owner);
    assert.equal(
        f.store.completeExtraction(first, f.source, "old", "old", now),
        false,
    );
});
test("consolidation cooldown applies to actual downstream calls", async (t) => {
    const f = await fixture(t);
    await f.run();
    const firstCalls = f.calls.length;
    const newer = { ...f.source, id: "session-2", fingerprint: "second" };
    await f.run({ sources: [newer] });
    assert.equal(
        f.calls.length,
        firstCalls + 1,
        "one extraction, no early consolidation",
    );
    const now = f.store.state(f.scope).consolidatedAtMs;
    await f.run({
        sources: [],
        now: () => now + DEFAULT_SETTINGS.consolidationCooldownMs - 1,
    });
    assert.equal(f.calls.length, firstCalls + 1);
    await f.run({
        sources: [],
        now: () => now + DEFAULT_SETTINGS.consolidationCooldownMs,
    });
    assert.equal(f.calls.length, firstCalls + 2);
});
test("a timeout that aborts the job uses an attempt; a caller's cancellation does not", async (t) => {
    const f = await fixture(t);
    const hanging = {
        complete: ({ signal }) =>
            new Promise((_resolve, reject) =>
                signal.addEventListener("abort", () => reject(signal.reason), {
                    once: true,
                }),
            ),
    };
    const run = async (id, reason) => {
        const controller = new AbortController();
        const stages = createStages({
            store: f.store,
            scope: f.scope,
            settings: f.settings,
            model: hanging,
            signal: controller.signal,
        });
        const source = { ...f.source, id, fingerprint: id };
        const lease = f.store.claim(
            f.scope,
            `extract:${id}`,
            id,
            Date.now(),
            f.settings,
        );
        const work = stages.extract(source, lease);
        setTimeout(() => controller.abort(reason), 10);
        try {
            return await work;
        } catch (error) {
            return memoryFailureCode(error);
        }
    };
    assert.equal(await run("watchdog", new MemoryFailure("timeout")), "failed");
    assert.equal(await run("cancelled"), "aborted");
    const jobs = Object.fromEntries(
        f.store.status(f.scope).jobs.map((job) => [job.key, job]),
    );
    assert.equal(jobs["extract:watchdog"].status, "failed");
    assert.equal(jobs["extract:watchdog"].attempts, 1);
    assert.ok(jobs["extract:watchdog"].retry_at > Date.now());
    assert.equal(jobs["extract:cancelled"].status, "cancelled");
    assert.equal(jobs["extract:cancelled"].attempts, 0);
});
test("literal/normalized/window search, revision-aware cursors, path traversal and Unicode limits", async (t) => {
    const f = await fixture(t);
    for (let i = 0; i < 12; i++)
        f.store.addNote(f.scope, `API-key ${i}\n한글 검증\n세 번째 줄`);
    const reader = new MemoryReader(f.store, f.scope);
    assert.equal(
        reader.search({ queries: ["apikey"], normalized: true }).matches.length,
        12,
    );
    assert.equal(
        reader.search({
            queries: ["API", "한글"],
            match_mode: { type: "all_on_same_line" },
        }).matches.length,
        0,
    );
    assert.equal(
        reader.search({
            queries: ["API", "한글"],
            match_mode: { type: "all_within_lines", line_count: 2 },
        }).matches.length,
        12,
    );
    const first = reader.search({ queries: ["검증"], max_results: 2 });
    assert.equal(first.matches.length, 2);
    assert.ok(first.next_cursor);
    assert.equal(
        reader.search({
            queries: ["검증"],
            max_results: 2,
            cursor: first.next_cursor,
        }).matches.length,
        2,
    );
    f.store.addNote(f.scope, "새 검증 기록");
    assert.throws(
        () => reader.search({ queries: ["검증"], cursor: first.next_cursor }),
        /changed/,
    );
    assert.throws(() => reader.read({ path: "../../auth.json" }));
    assert.throws(() => reader.list({ path: "/etc/passwd" }));
    assert.throws(() =>
        f.store.addNote(f.scope, "x", Date.now(), "../escape.md"),
    );
    const text = truncateBytes("🙂한글".repeat(5000), 511);
    assert.ok(Buffer.byteLength(text) <= 511);
    assert.ok(!text.includes("�"));
});
test("expiry, pinned retention and disabled reads take effect immediately", async (t) => {
    const f = await fixture(t);
    await f.run();
    const record = f.store.records(f.scope)[0];
    f.store.setRetention(f.scope, record.path, true, null);
    f.store.prune(f.scope, f.settings, Date.now() + 90 * 86_400_000);
    assert.equal(f.store.records(f.scope).length, 1);
    f.store.setRetention(f.scope, record.path, false, Date.now() + 5000);
    f.store.prune(f.scope, f.settings, Date.now() + 6000);
    assert.equal(f.store.records(f.scope).length, 0);
    assert.equal(f.store.state(f.scope).summary, "");
    f.store.saveSettings(f.scope, { ...f.settings, useMemories: false });
    assert.throws(
        () => new MemoryReader(f.store, f.scope).list({}),
        /disabled/,
    );
});
test("projection uses active branch, edits and correctly labels compaction; never recycles memory tools", async () => {
    const timestamp = new Date().toISOString();
    const entry = (id, parentId, message) => ({
        type: "message",
        id,
        parentId,
        timestamp,
        message,
    });
    const entries = [
        entry("u1", null, { role: "user", content: "keep this", timestamp: 1 }),
        entry("discard", "u1", {
            role: "user",
            content: "abandoned branch",
            timestamp: 2,
        }),
        entry("u2", "u1", {
            role: "user",
            content: "old wording",
            timestamp: 3,
        }),
        {
            type: "context_edit",
            id: "edit",
            parentId: "u2",
            timestamp,
            targetId: "u2",
            replacement: { content: "corrected wording" },
        },
        entry("tool", "edit", {
            role: "toolResult",
            toolName: "pi_codex_memory_read",
            toolCallId: "t",
            content: [{ type: "text", text: "do not recycle" }],
            isError: false,
            timestamp: 4,
        }),
    ];
    const text = renderProjection(
        buildSessionProjection(entries, "tool"),
        4096,
    );
    assert.match(text, /corrected wording/);
    assert.doesNotMatch(text, /abandoned|old wording|do not recycle/);
    const summary = {
        type: "compaction",
        id: "compact",
        parentId: "tool",
        timestamp,
        summary: "generated evidence",
        firstKeptEntryId: "compact",
        tokensBefore: 100,
    };
    const compacted = renderProjection(
        buildSessionProjection([...entries, summary], "compact"),
        4096,
    );
    assert.match(compacted, /generated evidence/);
    assert.match(compacted, /NOT direct human/);
});
test("30-minute eligibility is enforced by the session scanner, including exact boundary", async (t) => {
    const f = await fixture(t);
    const sessionDir = join(f.dir, "sessions");
    await import("node:fs/promises").then((fs) => fs.mkdir(sessionDir));
    const updated = Date.now() - 2 * 3_600_000;
    const entries = [
        {
            type: "session",
            id: "scan",
            version: 3,
            timestamp: new Date(updated).toISOString(),
            cwd: f.dir,
        },
        {
            type: "custom",
            id: "origin",
            parentId: null,
            timestamp: new Date(updated).toISOString(),
            customType: "pi-codex-memory.origin",
            data: { isInteractiveRoot: true },
        },
        {
            type: "message",
            id: "user",
            parentId: "origin",
            timestamp: new Date(updated).toISOString(),
            message: {
                role: "user",
                content: "scanner task",
                timestamp: updated,
            },
        },
    ];
    const path = join(sessionDir, "session.jsonl");
    await writeFile(
        path,
        `${entries.map((value) => JSON.stringify(value)).join("\n")}\n`,
    );
    await utimes(path, updated / 1000, updated / 1000);
    const exact = (await stat(path)).mtimeMs;
    const options = {
        agentDir: f.dir,
        cwd: f.dir,
        sessionDir,
        scope: f.scope,
        settings: f.settings,
        signal: new AbortController().signal,
    };
    assert.equal(
        (
            await scanSources({
                ...options,
                nowMs: exact + DEFAULT_SETTINGS.minIdleMs - 1,
            })
        ).length,
        0,
    );
    assert.equal(
        (
            await scanSources({
                ...options,
                nowMs: exact + DEFAULT_SETTINGS.minIdleMs,
            })
        ).length,
        1,
    );
    assert.equal(
        isSourceEligible(exact, exact + DEFAULT_SETTINGS.minIdleMs, f.settings),
        true,
    );
    assert.equal(
        (await readSource(path, 4096, options.signal, true)).id,
        "scan",
    );
    const before = await readSource(path, 4096, options.signal, true);
    entries.push({
        type: "custom_message",
        id: "status-only",
        parentId: "user",
        timestamp: new Date().toISOString(),
        customType: "pi-codex-memory.status",
        content: "metadata only",
        display: true,
    });
    await writeFile(
        path,
        `${entries.map((value) => JSON.stringify(value)).join("\n")}\n`,
    );
    const after = await readSource(path, 4096, options.signal, true);
    assert.equal(
        after.updatedAtMs,
        updated,
        "status writes must not postpone idle eligibility",
    );
    assert.equal(
        after.fingerprint,
        before.fingerprint,
        "status writes must not discard valid generation",
    );
    await symlink(path, join(sessionDir, "link.jsonl"));
    assert.equal(
        await readSource(
            join(sessionDir, "link.jsonl"),
            4096,
            options.signal,
            false,
        ),
        null,
    );
});
test("recall-derived assistant output is not re-extracted as independent evidence", async (t) => {
    const f = await fixture(t),
        timestamp = new Date().toISOString();
    const values = [
        {
            type: "session",
            id: "recall-session",
            version: 3,
            cwd: f.dir,
            timestamp,
        },
        {
            type: "message",
            id: "question",
            parentId: null,
            timestamp,
            message: {
                role: "user",
                content: "What was the old decision?",
                timestamp: 1,
            },
        },
        {
            type: "custom",
            id: "memory-context",
            parentId: "question",
            timestamp,
            customType: "pi-codex-memory.recall",
            data: { version: 1 },
        },
        {
            type: "message",
            id: "recalled",
            parentId: "memory-context",
            timestamp,
            message: {
                role: "assistant",
                content: [
                    { type: "text", text: "FORGOTTEN_CANARY was recalled." },
                ],
                stopReason: "stop",
                timestamp: 2,
            },
        },
        {
            type: "message",
            id: "new-user",
            parentId: "recalled",
            timestamp,
            message: {
                role: "user",
                content: "NEW_INDEPENDENT_FACT",
                timestamp: 3,
            },
        },
    ];
    const path = join(f.dir, "recall.jsonl");
    await writeFile(
        path,
        `${values.map((value) => JSON.stringify(value)).join("\n")}\n`,
    );
    const source = await readSource(
        path,
        8192,
        new AbortController().signal,
        false,
    );
    assert.match(source.text, /NEW_INDEPENDENT_FACT/);
    assert.doesNotMatch(source.text, /FORGOTTEN_CANARY/);
});
test("escaped long inputs retain first and last evidence within the final request byte cap", async (t) => {
    const f = await fixture(t);
    const source = {
        ...f.source,
        text:
            "FIRST_EVIDENCE\\n" +
            '\\"\\n'.repeat(100000) +
            "\\nLAST_CORRECTION",
    };
    const result = await f.run({ sources: [source] });
    assert.equal(result.failed, 0);
    const request = f.calls[0];
    assert.ok(
        Buffer.byteLength(request.input) + Buffer.byteLength(request.system) <=
            f.settings.maxInputBytes,
    );
    assert.match(request.input, /FIRST_EVIDENCE/);
    assert.match(request.input, /LAST_CORRECTION/);
});
test("configured per-model reasoning survives persistence, pipeline selection and final Pi options", async (t) => {
    const f = await fixture(t);
    const settings = parseSettings({
        ...f.settings,
        extractModel: { ...f.settings.extractModel, reasoning: "medium" },
        consolidateModel: { ...f.settings.consolidateModel, reasoning: "high" },
    });
    f.store.saveSettings(f.scope, settings);
    await f.run({ settings: f.store.getSettings(f.scope) });
    assert.deepEqual(
        f.calls.map((call) => call.model.reasoning),
        ["medium", "high"],
    );
    const observed = [];
    const registry = {
        find(provider, id) {
            return { provider, id, api: "openai-responses", reasoning: true };
        },
        streamSimple(_model, _context, options) {
            observed.push(options.reasoning);
            return {
                async result() {
                    return {
                        stopReason: "stop",
                        content: [{ type: "text", text: "{}" }],
                    };
                },
            };
        },
    };
    for (const call of f.calls)
        await piMemoryModel({
            modelRegistry: registry,
            sessionManager: { getSessionId: () => "fixture-session" },
        }).complete(call);
    assert.deepEqual(observed, ["medium", "high"]);
    assert.throws(
        () =>
            parseSettings({
                ...settings,
                extractModel: {
                    provider: "fixture",
                    id: "bad",
                    reasoning: "turbo",
                },
            }),
        /Invalid model/,
    );
    await assert.rejects(
        piMemoryModel({
            modelRegistry: {
                ...registry,
                find: () => ({
                    provider: "fixture",
                    id: "limited",
                    reasoning: false,
                }),
            },
        }).complete(f.calls[1]),
        /unsupported/,
    );
});
test("projection preserves middle user decisions and question answers before bulky tool output", () => {
    const entries = [];
    const at = new Date().toISOString();
    let parentId = null;
    const add = (id, message) => {
        entries.push({ type: "message", id, parentId, timestamp: at, message });
        parentId = id;
    };
    add("first", { role: "user", content: "FIRST", timestamp: 1 });
    for (let i = 0; i < 30; i++) {
        add(`tool-${i}`, {
            role: "toolResult",
            toolName: "read",
            toolCallId: `r${i}`,
            content: [{ type: "text", text: '\\"logs\\n'.repeat(1000) }],
            isError: false,
            timestamp: i + 2,
        });
        if (i === 15) {
            add("decision", {
                role: "user",
                content: "Do not publish. Use /codex-memory.",
                timestamp: 50,
            });
            add("answer", {
                role: "toolResult",
                toolName: "ask_user_question",
                toolCallId: "q",
                content: [
                    { type: "text", text: "Only this project; not global." },
                ],
                isError: false,
                timestamp: 51,
            });
        }
    }
    add("last", {
        role: "assistant",
        content: [{ type: "text", text: "FINAL: not published" }],
        stopReason: "stop",
        timestamp: 99,
    });
    const text = renderProjection(
        buildSessionProjection(entries, parentId),
        8192,
    );
    assert.match(text, /Do not publish/);
    assert.match(text, /Only this project/);
    assert.match(text, /tool=ask_user_question/);
    assert.match(text, /FINAL/);
    assert.ok(jsonStringBytes(text) <= 8192);
});
test("exact escaped budgets and storage truncation retain endpoints without corrupting Unicode", async (t) => {
    for (const budget of [0, 1, 40, 128, 500, 4096]) {
        const value = fitJSONString(
            `FIRST "${"🙂\\\n".repeat(10000)}" LAST`,
            budget,
        );
        assert.ok(jsonStringBytes(value) <= budget);
        assert.ok(!value.includes("�"));
        assert.ok(
            Buffer.byteLength(
                truncateMiddleBytes("한글".repeat(100), budget),
            ) <= budget,
        );
    }
    const f = await fixture(t);
    const summary = `INITIAL_SCOPE\n${"old detail ".repeat(1500)}\nLATEST_APPROVAL`;
    const lease = f.store.claim(
        f.scope,
        "large",
        "large",
        Date.now(),
        f.settings,
    );
    f.store.completeExtraction(lease, f.source, summary, "large", Date.now());
    const record = f.store.records(f.scope)[0];
    assert.match(record.body, /INITIAL_SCOPE/);
    assert.match(record.body, /LATEST_APPROVAL/);
    assert.ok(record.truncatedBytes > 0);
    assert.ok(Buffer.byteLength(record.body) <= 9000);
});
test("unavailable models consume neither attempts nor recorded calls; sent failures are recorded as calls", async (t) => {
    const f = await fixture(t);
    const unavailable = piMemoryModel({
        modelRegistry: { find: () => undefined },
    });
    await f.run({ model: unavailable });
    const job = f.store
        .status(f.scope)
        .jobs.find((item) => item.key.startsWith("extract:"));
    assert.equal(job.status, "blocked");
    assert.equal(job.attempts, 0);
    assert.equal(job.error, "model_unavailable");
    assert.equal(f.store.status(f.scope).usage.length, 0);
    await f.run({
        force: true,
        model: {
            async complete() {
                throw new MemoryFailure("output_length", {
                    input: 20,
                    cacheRead: 30,
                    output: 4096,
                });
            },
        },
    });
    const status = f.store.status(f.scope);
    assert.equal(status.usage[0].calls, 1);
    assert.equal(status.usage[0].input_tokens, 50);
    assert.equal(status.usage[0].output_tokens, 4096);
    assert.equal(
        status.jobs.find((item) => item.key.startsWith("extract:")).error,
        "output_length",
    );
});
test("native credential resolution is authoritative and cached sources do not require a provider", async (t) => {
    const f = await fixture(t);
    const registry = {
        find: (provider, id) => ({ provider, id }),
        hasConfiguredAuth: () => false,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
    };
    const adapter = piMemoryModel({ modelRegistry: registry });
    assert.equal(
        (await f.run({ model: { ...f.model, validate: adapter.validate } }))
            .failed,
        0,
    );
    registry.find = () => undefined;
    assert.equal(
        (await f.run({ model: { ...f.model, validate: adapter.validate } }))
            .failed,
        0,
    );
    assert.equal(f.calls.length, 2);
});
test("timeout is a failed sent request, not a free retry or caller cancellation", async (t) => {
    const f = await fixture(t);
    const settings = { ...f.settings, timeoutMs: 1000 };
    f.store.saveSettings(f.scope, settings);
    const controller = new AbortController();
    const keepAlive = setTimeout(() => {}, 2000);
    try {
        await f.run({
            settings,
            signal: controller.signal,
            model: { complete: () => new Promise(() => {}) },
        });
    } finally {
        clearTimeout(keepAlive);
    }
    assert.equal(controller.signal.aborted, false);
    const status = f.store.status(f.scope);
    assert.equal(status.usage[0].calls, 1);
    assert.equal(
        status.jobs.find((item) => item.key.startsWith("extract:")).error,
        "timeout",
    );
});
test("citations require the actual read ranges and matching source IDs; stale reads are invalid", async (t) => {
    const f = await fixture(t);
    await f.run();
    const record = f.store.records(f.scope)[0],
        reader = new MemoryReader(f.store, f.scope);
    const citation = (id, start = 1, end = 3) =>
        "<oai-mem-citation>\n<citation_entries>\n" +
        record.path +
        ":" +
        start +
        "-" +
        end +
        "|note=[used]\n</citation_entries>\n<rollout_ids>\n" +
        id +
        "\n</rollout_ids>\n</oai-mem-citation>";
    reader.read({ path: record.path, max_lines: 3 });
    reader.recordCitations(citation("example-id"));
    assert.equal(reader.evidence().citations.invalid, 1);
    assert.equal(f.store.records(f.scope)[0].usageCount, 0);
    reader.recordCitations(citation(f.source.id, 1, 8));
    assert.equal(reader.evidence().citations.invalid, 1);
    reader.recordCitations(citation(f.source.id));
    assert.equal(reader.evidence().citations.valid, 1);
    assert.equal(f.store.records(f.scope)[0].usageCount, 1);
    f.store.revise(f.scope, record.path, null);
    reader.recordCitations(citation(f.source.id));
    assert.equal(reader.evidence().citations.invalid, 1);
});
test("consolidation rejects forged thread IDs and generated identifiers not in its own input", () => {
    const path = "rollout_summaries/one.md",
        paths = new Set([path]),
        ids = new Map([[path, "actual-id"]]);
    assert.throws(
        () =>
            parseConsolidation(
                JSON.stringify({
                    memory_summary: `${EMPTY_SUMMARY + path} thread_id=wrong`,
                }),
                paths,
                ids,
            ),
        /ungrounded_pointer/,
    );
    const guard = createMemoryGroundingGuard();
    guard(
        JSON.stringify({ text: "owner@example.com /tmp/known" }),
        "owner@example.com /tmp/known",
    );
    assert.throws(
        () =>
            guard(
                JSON.stringify({ text: "no contact provided" }),
                "invented@example.com",
            ),
        /ungrounded_identifier/,
    );
    assert.throws(
        () =>
            guard(
                JSON.stringify({ text: "/tmp/known" }),
                "/tmp/native-host-workspace",
            ),
        /ungrounded_identifier/,
    );
});
test("invalidated summaries retain current notes and record discovery without bypassing caller cooldown", async (t) => {
    const f = await fixture(t);
    await f.run();
    const first = f.store.addNote(
        f.scope,
        `CURRENT_CORRECTION ${"fact ".repeat(350)}`,
    );
    await f.run({ sources: [], force: true });
    f.store.addNote(f.scope, "LATEST_NOTE");
    const calls = f.calls.length;
    await f.run({ sources: [] });
    assert.equal(f.calls.length, calls, "explicit cooldown remains respected");
    for (const maxInjectionBytes of [1024, 4096, 12288]) {
        const content = buildInjection(f.store, f.scope, {
            ...f.settings,
            generateMemories: false,
            maxInjectionBytes,
        });
        assert.ok(Buffer.byteLength(content) <= maxInjectionBytes);
        assert.match(content, /MEMORY_SUMMARY ENDS/);
        assert.match(content, /LATEST_NOTE/);
    }
    assert.match(
        buildInjection(f.store, f.scope, f.settings),
        /CURRENT_CORRECTION/,
    );
    f.store.revise(f.scope, first.path, null);
    assert.doesNotMatch(
        buildInjection(f.store, f.scope, f.settings),
        /CURRENT_CORRECTION/,
    );
});
test("model adapter sends configured models, prompts, cap and caller cancellation to Pi streamSimple", async () => {
    let captured;
    const signal = new AbortController().signal;
    const registry = {
        find(provider, id) {
            return { provider, id, reasoning: true };
        },
        streamSimple(model, context, options) {
            captured = { model, context, options };
            return {
                async result() {
                    return {
                        stopReason: "stop",
                        content: [{ type: "text", text: "{}" }],
                    };
                },
            };
        },
    };
    await piMemoryModel({
        modelRegistry: registry,
        sessionManager: { getSessionId: () => "fixture-session" },
    }).complete({
        stage: "extraction",
        model: { provider: "fixture", id: "fixed" },
        system: "instructions",
        input: "masked",
        maxOutputTokens: 1234,
        signal,
    });
    assert.equal(captured.model.id, "fixed");
    assert.equal(captured.options.maxTokens, 1234);
    assert.equal(captured.options.signal, signal);
    assert.equal(captured.options.reasoning, "low");
    assert.equal(captured.options.sessionId, "fixture-session");
    assert.equal(captured.options.cacheRetention, "none");
    assert.equal(
        captured.context.tools,
        undefined,
        "consolidation/extraction cannot execute tools",
    );
});
test("each stage asks for the nearest reasoning level the model offers, or none", async () => {
    const models = {
        // Like Devin's swe-2: medium and above only.
        "medium-up": {
            reasoning: true,
            thinkingLevelMap: { minimal: null, low: null },
        },
        // Like some Ollama models: low and high, no medium.
        "no-medium": {
            reasoning: true,
            thinkingLevelMap: { minimal: null, medium: null },
        },
        plain: { reasoning: false },
    };
    const sent = [];
    const adapter = piMemoryModel({
        sessionManager: { getSessionId: () => "fixture-session" },
        modelRegistry: {
            find: (provider, id) => ({ provider, id, ...models[id] }),
            streamSimple(model, _context, options) {
                sent.push(`${model.id} ${options.reasoning}`);
                return {
                    async result() {
                        return {
                            stopReason: "stop",
                            content: [{ type: "text", text: "{}" }],
                        };
                    },
                };
            },
        },
    });
    for (const id of Object.keys(models))
        for (const stage of ["extraction", "consolidation"])
            await adapter.complete({
                stage,
                model: { provider: "fixture", id },
                system: "instructions",
                input: "masked",
                maxOutputTokens: 512,
                signal: new AbortController().signal,
            });
    assert.deepEqual(sent, [
        "medium-up medium",
        "medium-up medium",
        "no-medium low",
        "no-medium high",
        "plain undefined",
        "plain undefined",
    ]);
});
test("model adapter follows the current Pi model for a null choice and fails without one", async () => {
    let captured;
    const ctx = {
        model: { provider: "fixture", id: "main", reasoning: true },
        sessionManager: { getSessionId: () => "fixture-session" },
        modelRegistry: {
            find() {
                throw new Error("a null choice is not looked up");
            },
            streamSimple(model, _context, options) {
                captured = { model, options };
                return {
                    async result() {
                        return {
                            stopReason: "stop",
                            content: [{ type: "text", text: "{}" }],
                        };
                    },
                };
            },
        },
    };
    const adapter = piMemoryModel(ctx);
    await adapter.complete({
        stage: "consolidation",
        model: null,
        system: "instructions",
        input: "masked",
        maxOutputTokens: 512,
        signal: new AbortController().signal,
    });
    assert.equal(captured.model.id, "main");
    assert.equal(captured.options.reasoning, "medium");
    ctx.model = undefined;
    await assert.rejects(
        adapter.validate(null),
        (error) => error.code === "model_unavailable",
    );
});
