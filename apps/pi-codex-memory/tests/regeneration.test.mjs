import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../dist/config.js";
import { EMPTY_SUMMARY, runPipeline } from "../dist/pipeline.js";
import { buildInjection, MemoryReader } from "../dist/retrieval.js";
import { workspaceScope } from "../dist/safety.js";
import {
    currentSource,
    isSourceUnchanged,
    RECALL_ENTRY,
    readSource,
} from "../dist/sources.js";
import { MemoryStore } from "../dist/store.js";

const maxBytes = 256 * 1024 - 8192;
const assistant = (text) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
});
async function history(t) {
    const dir = await mkdtemp(join(tmpdir(), "pi-memory-regeneration-"));
    await mkdir(join(dir, "sessions"));
    const manager = SessionManager.create(dir, join(dir, "sessions"));
    const user = (content) =>
        manager.appendMessage({ role: "user", content, timestamp: Date.now() });
    const firstId = user(
        "The confirmed service is service-first. This task is project-only; no commands were executed.",
    );
    manager.appendMessage(assistant("Acknowledged.")); // Flush the real SDK session file.
    const cleanup = [];
    t.after(async () => {
        for (const close of cleanup) await close();
        await rm(dir, { recursive: true, force: true });
    });
    const compact = (summary) =>
        manager.appendCompaction(summary, manager.getLeafId(), 1000);
    const current = () => currentSource(manager, maxBytes);
    const disk = () =>
        readSource(
            manager.getSessionFile(),
            maxBytes,
            new AbortController().signal,
            false,
        );
    return { dir, manager, firstId, user, compact, current, disk, cleanup };
}

test("extraction retains original human evidence across repeated compaction without changing host context", async (t) => {
    const f = await history(t),
        before = f.current();
    for (let index = 0; index < 2; index++) {
        f.compact("COMPACTION_INVENTED_FACT: service-first is unverified.");
        const rawBefore = JSON.stringify(f.manager.getEntries());
        const current = f.current(),
            disk = await f.disk();
        assert.match(
            current.text,
            /human user\]\nThe confirmed service is service-first/,
        );
        assert.doesNotMatch(current.text, /COMPACTION_INVENTED_FACT/);
        assert.equal(current.fingerprint, before.fingerprint);
        assert.equal(current.updatedAtMs, before.updatedAtMs);
        assert.equal(disk.fingerprint, current.fingerprint);
        assert.equal(
            await isSourceUnchanged(
                current,
                new AbortController().signal,
                maxBytes,
            ),
            true,
        );
        assert.equal(
            JSON.stringify(f.manager.getEntries()),
            rawBefore,
            "the original session graph must not be mutated",
        );
        assert.ok(
            f.manager
                .buildSessionProjection()
                .messages.some(
                    (message) => message.role === "compactionSummary",
                ),
        );
        assert.ok(
            !f.manager
                .buildSessionProjection()
                .entries.some((entry) => entry.sourceEntry.id === f.firstId),
        );
    }
});

test("context replacements and removals remain effective before and after compaction", async (t) => {
    const f = await history(t);
    f.manager.appendContextEdit(f.firstId, {
        content: "The corrected service is service-replacement.",
    });
    const disposable = f.user("REMOVED_BEFORE_COMPACTION");
    f.manager.appendContextEdit(disposable, null);
    f.compact("STALE_SUMMARY service-first REMOVED_BEFORE_COMPACTION");
    assert.match(f.current().text, /service-replacement/);
    assert.doesNotMatch(
        f.current().text,
        /service-first|REMOVED_BEFORE_COMPACTION|STALE_SUMMARY/,
    );
    f.manager.appendContextEdit(f.firstId, null);
    f.user("Remaining independent decision: gate-final.");
    f.compact("STALE_SUMMARY service-replacement");
    assert.match(f.current().text, /gate-final/);
    assert.doesNotMatch(
        f.current().text,
        /service-first|service-replacement|REMOVED_BEFORE_COMPACTION|STALE_SUMMARY/,
    );
    assert.equal((await f.disk()).fingerprint, f.current().fingerprint);
});

test("extraction follows the selected branch and never inherits an abandoned branch edit", async (t) => {
    const f = await history(t);
    f.user("ABANDONED_BRANCH_FACT");
    f.manager.appendContextEdit(f.firstId, {
        content: "ABANDONED_BRANCH_REPLACEMENT",
    });
    f.compact("ABANDONED_BRANCH_SUMMARY");
    f.manager.branch(f.firstId);
    f.user("ACTIVE_BRANCH_FACT");
    f.compact("ACTIVE_GENERATED_SUMMARY");
    assert.match(f.current().text, /service-first/);
    assert.match(f.current().text, /ACTIVE_BRANCH_FACT/);
    assert.doesNotMatch(f.current().text, /ABANDONED|ACTIVE_GENERATED_SUMMARY/);
    assert.equal((await f.disk()).fingerprint, f.current().fingerprint);
});

test("recall-exposed responses remain excluded after compaction, with a non-authoritative omission notice", async (t) => {
    const f = await history(t);
    f.user("What did we decide previously?");
    f.manager.appendCustomEntry(RECALL_ENTRY, { version: 1 });
    f.manager.appendMessage({
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "pi_codex_memory_read",
        content: [{ type: "text", text: "RECALLED_ONLY_FACT" }],
        isError: false,
        timestamp: Date.now(),
    });
    f.manager.appendMessage(assistant("RECALLED_ONLY_FACT"));
    f.compact("RECALLED_ONLY_FACT leaked through a generated summary");
    f.user("A new independent decision: preserve-scope.");
    f.manager.appendMessage(assistant("INDEPENDENT_RESPONSE"));
    const source = f.current();
    assert.doesNotMatch(source.text, /RECALLED_ONLY_FACT/);
    assert.match(source.text, /What did we decide previously\?/);
    assert.match(source.text, /omitted.*memory context/);
    assert.match(source.text, /not evidence of task success or failure/);
    assert.match(source.text, /INDEPENDENT_RESPONSE/);
    assert.equal((await f.disk()).fingerprint, source.fingerprint);
});

test("compaction skips unchanged extraction, but a later human correction causes a real new extraction and forgetting still wins", async (t) => {
    const f = await history(t),
        store = new MemoryStore(join(f.dir, "memory"));
    f.cleanup.push(() => store.close());
    const scope = workspaceScope(f.dir),
        requests = [];
    const settings = {
        ...DEFAULT_SETTINGS,
        useMemories: true,
        generateMemories: true,
        extractModel: { provider: "fixture", id: "extract" },
        consolidateModel: { provider: "fixture", id: "consolidate" },
    };
    store.saveSettings(scope, settings);
    const model = {
        async complete(request) {
            requests.push(request);
            const input = JSON.parse(request.input);
            return {
                text: JSON.stringify(
                    request.stage === "extraction"
                        ? {
                              rollout_summary:
                                  input.rendered_conversation.includes(
                                      "service-corrected",
                                  )
                                      ? "The user's final correction is service-corrected, not service-first. No commands were executed."
                                      : "The user confirmed service-first for this project. No commands were executed.",
                              rollout_slug: "confirmed-service",
                          }
                        : {
                              memory_summary:
                                  EMPTY_SUMMARY +
                                  input.documents
                                      .map(
                                          (document) =>
                                              `- ${document.path} — scoped historical decision`,
                                      )
                                      .join("\n"),
                          },
                ),
            };
        },
    };
    const run = () =>
        runPipeline({
            store,
            scope,
            settings,
            model,
            sources: [f.current()],
            force: true,
            signal: new AbortController().signal,
        });
    assert.equal((await run()).extracted, 1);
    const before = f.current();
    f.compact("service-first is only provisional");
    assert.equal(f.current().fingerprint, before.fingerprint);
    assert.equal((await run()).extracted, 0);
    assert.equal(requests.length, 2);
    f.user(
        "Final correction: replace service-first with service-corrected. Everything else is unchanged.",
    );
    assert.notEqual(f.current().fingerprint, before.fingerprint);
    assert.equal((await run()).extracted, 1);
    assert.equal(
        requests.filter((request) => request.stage === "extraction").length,
        2,
    );
    assert.match(requests.at(-2).input, /service-first/);
    assert.match(requests.at(-2).input, /service-corrected/);
    assert.match(
        store.records(scope)[0].body,
        /final correction is service-corrected/,
    );
    assert.equal(
        store.records(scope)[0].source.fingerprint,
        f.current().fingerprint,
    );
    store.revise(scope, store.records(scope)[0].path, null);
    f.compact("The forgotten service was service-corrected");
    f.user("Continue the same project without restoring forgotten memory.");
    const beforeForgetScan = requests.length;
    assert.equal((await run()).extracted, 0);
    assert.equal(requests.length, beforeForgetScan);
    assert.equal(store.records(scope).length, 0);
});

test("incomplete source ancestry is not reinterpreted as complete extraction evidence", async (t) => {
    const f = await history(t);
    const values = JSON.parse(JSON.stringify(f.manager.getEntries()));
    values[0].parentId = "missing-ancestor";
    const file = join(f.dir, "incomplete.jsonl");
    await writeFile(
        file,
        `${[f.manager.getHeader(), ...values]
            .map((value) => JSON.stringify(value))
            .join("\n")}\n`,
    );
    assert.equal(
        await readSource(file, maxBytes, new AbortController().signal, false),
        null,
    );
});

test("an empty consolidation is a discoverable template, not a stored fact or an injection", async (t) => {
    const f = await history(t),
        store = new MemoryStore(join(f.dir, "empty-memory"));
    f.cleanup.push(() => store.close());
    const scope = workspaceScope(f.dir),
        settings = {
            ...DEFAULT_SETTINGS,
            useMemories: true,
            generateMemories: true,
            extractModel: { provider: "fixture", id: "extract" },
            consolidateModel: { provider: "fixture", id: "consolidate" },
        };
    store.saveSettings(scope, settings);
    await runPipeline({
        store,
        scope,
        settings,
        sources: [],
        force: true,
        signal: new AbortController().signal,
        model: {
            complete() {
                throw new Error("Empty consolidation must not call a model");
            },
        },
    });
    const reader = new MemoryReader(store, scope);
    assert.equal(store.records(scope).length, 0);
    assert.deepEqual(reader.list({}).entries, [
        { path: "memory_summary.md", entry_type: "file" },
    ]);
    assert.equal(
        reader.read({ path: "memory_summary.md", line_offset: 1 }).content,
        EMPTY_SUMMARY,
    );
    assert.deepEqual(reader.search({ queries: ["service-first"] }).matches, []);
    assert.equal(buildInjection(store, scope, settings), "");
});

test("the supported SDK rejects edits of compaction summaries; malformed imported omissions still do not restore hidden originals", async (t) => {
    const f = await history(t),
        compactionId = f.compact("GENERATED_ONLY_FACT");
    assert.throws(
        () => f.manager.appendContextEdit(compactionId, null),
        /does not contribute editable model content/,
    );
    const values = f.manager.getEntries();
    values.push({
        type: "context_edit",
        id: "imported-omission",
        parentId: compactionId,
        timestamp: new Date().toISOString(),
        targetId: compactionId,
        replacement: null,
    });
    values.push({
        type: "message",
        id: "imported-user",
        parentId: "imported-omission",
        timestamp: new Date().toISOString(),
        message: {
            role: "user",
            content: "RETAINED_USER_FACT",
            timestamp: Date.now(),
        },
    });
    const file = join(f.dir, "imported.jsonl");
    await writeFile(
        file,
        `${[f.manager.getHeader(), ...values]
            .map((value) => JSON.stringify(value))
            .join("\n")}\n`,
    );
    const source = await readSource(
        file,
        maxBytes,
        new AbortController().signal,
        false,
    );
    assert.match(source.text, /RETAINED_USER_FACT/);
    assert.doesNotMatch(source.text, /service-first|GENERATED_ONLY_FACT/);
});
