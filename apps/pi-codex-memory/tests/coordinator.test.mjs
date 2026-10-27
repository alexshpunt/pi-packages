import assert from "node:assert/strict";
import {
    appendFile,
    chmod,
    mkdir,
    mkdtemp,
    rm,
    utimes,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { memoryCommand } from "../dist/commands.js";
import { DEFAULT_SETTINGS } from "../dist/config.js";
import { WORKER_LIMIT } from "../dist/coordinator.js";
import { EMPTY_SUMMARY } from "../dist/pipeline.js";
import { MemoryRuntime } from "../dist/runtime.js";
import { ACTIVITY_TTL_MS } from "../dist/store.js";
import { pickRow, terminalPicker } from "./ui.mjs";

const HOUR = 3_600_000;
const START = Date.parse("2026-10-27T09:00:00Z");
const ENABLED = {
    ...DEFAULT_SETTINGS,
    useMemories: true,
    generateMemories: true,
    extractModel: { provider: "fixture", id: "extract" },
    consolidateModel: { provider: "fixture", id: "consolidate" },
};

const reply = (value) => ({
    stopReason: "stop",
    content: [{ type: "text", text: JSON.stringify(value) }],
});
/**
 * A model that records each call. While `hold` is set, extraction waits for it or for
 * cancellation, and `holdSummary` does the same for the summary; `ignoreCancel` makes extraction
 * wait forever, as a provider that ignores abort would.
 */
function fakeModel() {
    const state = {
        extractions: [],
        consolidations: 0,
        inFlight: 0,
        maxInFlight: 0,
        hold: undefined,
        holdSummary: undefined,
        ignoreCancel: false,
        /** Conversations whose extraction returns output that is not JSON. */
        failIds: new Set(),
    };
    const registry = {
        getAvailable: () => [],
        // A model with the ID "missing" is not available.
        find: (provider, id) =>
            id === "missing" ? undefined : { provider, id },
        streamSimple(_model, context, options) {
            const input = JSON.parse(context.messages[0].content[0].text);
            return {
                async result() {
                    if (!("rendered_conversation" in input)) {
                        state.consolidations++;
                        if (state.holdSummary)
                            await new Promise((resolve, reject) => {
                                state.holdSummary.then(resolve);
                                options.signal.addEventListener(
                                    "abort",
                                    () => reject(options.signal.reason),
                                    { once: true },
                                );
                            });
                        return reply({
                            memory_summary:
                                EMPTY_SUMMARY +
                                input.documents
                                    .map(
                                        (document) =>
                                            `- ${document.path} — earlier work; thread_id=${document.thread_id}`,
                                    )
                                    .join("\n"),
                        });
                    }
                    state.extractions.push(input.source_thread_id);
                    state.inFlight++;
                    state.maxInFlight = Math.max(
                        state.maxInFlight,
                        state.inFlight,
                    );
                    try {
                        if (state.ignoreCancel) await new Promise(() => {});
                        if (state.hold)
                            await new Promise((resolve, reject) => {
                                state.hold.then(resolve);
                                options.signal.addEventListener(
                                    "abort",
                                    () => reject(options.signal.reason),
                                    { once: true },
                                );
                            });
                    } finally {
                        state.inFlight--;
                    }
                    if (state.failIds.has(input.source_thread_id))
                        return {
                            stopReason: "stop",
                            content: [{ type: "text", text: "not JSON" }],
                        };
                    return reply({
                        rollout_summary: `Earlier work in ${input.source_thread_id}.`,
                        rollout_slug: input.source_thread_id,
                    });
                },
            };
        },
    };
    return { state, registry };
}
async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), "pi-memory-coordinator-"));
    const agentDir = join(root, "agent"),
        cwd = join(root, "work"),
        sessions = join(root, "sessions");
    await Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(sessions)]);
    const clock = { now: START };
    const runtimes = [];
    t.after(async () => {
        for (const runtime of runtimes) await runtime.dispose().catch(() => {});
        await rm(root, { recursive: true, force: true });
    });
    /**
     * One Pi session: its own database connection, session and model, like a separate process.
     * Passing `ui` gives it a terminal. Waits advance the fake clock at once.
     */
    const advance = async (ms, signal) => {
        signal.throwIfAborted();
        clock.now += ms;
    };
    const open = (
        model = fakeModel(),
        folder = cwd,
        ui = undefined,
        sleep = advance,
    ) => {
        const ctx = {
            cwd: folder,
            mode: "tui",
            hasUI: !!ui,
            ui: { notify() {}, ...ui },
            sessionManager: SessionManager.create(folder, sessions),
            modelRegistry: model.registry,
            isIdle: () => true,
            waitForIdle: async () => {},
        };
        const runtime = new MemoryRuntime(ctx, agentDir, {
            now: () => clock.now,
            sleep,
        });
        runtimes.push(runtime);
        return { runtime, model: model.state, ctx };
    };
    const writeSession = async (id, atMs, folder = cwd) => {
        const iso = new Date(atMs).toISOString();
        const entries = [
            { type: "session", version: 3, id, cwd: folder, timestamp: iso },
            {
                type: "custom",
                id: "origin",
                parentId: null,
                timestamp: iso,
                customType: "pi-codex-memory.origin",
                data: { isInteractiveRoot: true },
            },
            {
                type: "message",
                id: "user",
                parentId: "origin",
                timestamp: iso,
                message: {
                    role: "user",
                    content: `Remember the plan for ${id}.`,
                    timestamp: atMs,
                },
            },
        ];
        const path = join(sessions, `${iso.replace(/[:.]/g, "-")}_${id}.jsonl`);
        await writeFile(
            path,
            `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        );
        await utimes(path, atMs / 1000, atMs / 1000);
        return path;
    };
    /** Adds a later message to a session file and dates the file to it. */
    const continueSession = async (path, atMs) => {
        await appendFile(
            path,
            `${JSON.stringify({
                type: "message",
                id: `user-${atMs}`,
                parentId: "user",
                timestamp: new Date(atMs).toISOString(),
                message: {
                    role: "user",
                    content: "Also keep the release gate amber.",
                    timestamp: atMs,
                },
            })}\n`,
        );
        await utimes(path, atMs / 1000, atMs / 1000);
    };
    /** Moves the clock and lets the given sessions run one heartbeat each. */
    const step = async (ms, ...active) => {
        clock.now += ms;
        await Promise.all(active.map((runtime) => runtime.tick()));
    };
    const inspect = (query, ...values) => {
        const database = new DatabaseSync(
            join(agentDir, "pi-codex-memory", "state.sqlite"),
            { readOnly: true },
        );
        try {
            return database.prepare(query).all(...values);
        } finally {
            database.close();
        }
    };
    return {
        root,
        agentDir,
        cwd,
        sessions,
        clock,
        open,
        writeSession,
        continueSession,
        step,
        inspect,
    };
}
async function until(condition, message) {
    const deadline = Date.now() + 5000;
    while (!condition() && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(condition(), message);
}
/** Fails instead of hanging when a promise never settles. */
function within(promise, ms = 3000) {
    return Promise.race([
        promise,
        new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error("did not settle")), ms).unref(),
        ),
    ]);
}
const settled = (runtime) =>
    until(() => !runtime.isRunning, "memory jobs settled");
const isLeader = (runtime) => runtime.status().coordinator.isLeader;

test("the heartbeat marks a session open only while memory is on", async (t) => {
    const f = await fixture(t);
    const { runtime } = f.open();
    const isOpen = () =>
        runtime.store.isSessionOpen(runtime.sessionId, f.clock.now);
    await runtime.tick();
    assert.equal(isOpen(), false, "memory off records nothing");
    await runtime.saveSettings(ENABLED);
    assert.equal(isOpen(), true);
    await f.step(45_000, runtime);
    await f.step(45_000, runtime);
    assert.equal(isOpen(), true, "each heartbeat renews it");
    await runtime.saveSettings({ ...ENABLED, generateMemories: false });
    assert.equal(isOpen(), false, "turning memory off removes it at once");
    await f.step(30_000, runtime);
    assert.equal(isOpen(), false);
    assert.equal(isLeader(runtime), false);
});

test("one session per scope coordinates; only closed, idle conversations become memory, after one heartbeat period", async (t) => {
    const f = await fixture(t);
    const a = f.open(),
        b = f.open();
    a.runtime.store.saveSettings(a.runtime.scope, ENABLED);
    await f.writeSession("closed-1", START - 3 * HOUR);
    await f.writeSession("open-1", START - 3 * HOUR);
    await f.writeSession("recent-1", START - HOUR / 2);
    // Another Pi process keeps open-1 open; its heartbeat is renewed every step.
    const keepOpen = () =>
        a.runtime.store.activity(
            a.runtime.scope,
            "open-1",
            "another-process",
            false,
            f.clock.now,
        );
    keepOpen();
    await f.step(0, a.runtime, b.runtime);
    assert.equal(isLeader(a.runtime), true);
    assert.equal(isLeader(b.runtime), false);
    assert.deepEqual(a.model.extractions, [], "waits one heartbeat period");
    keepOpen();
    await f.step(45_000, a.runtime, b.runtime);
    assert.deepEqual(a.model.extractions, []);
    keepOpen();
    await f.step(45_000, a.runtime, b.runtime);
    await settled(a.runtime);
    assert.deepEqual(a.model.extractions, ["closed-1"]);
    assert.equal(a.model.consolidations, 0, "the summary waits for the round");
    keepOpen();
    await f.step(30_000, a.runtime, b.runtime);
    keepOpen();
    await f.step(30_000, a.runtime, b.runtime);
    assert.equal(a.model.consolidations, 1);
    assert.deepEqual(b.model.extractions, []);
    assert.equal(b.model.consolidations, 0);
    const records = a.runtime.store.records(a.runtime.scope);
    assert.deepEqual(
        records.map((record) => record.source.id),
        ["closed-1"],
    );
    assert.match(a.runtime.store.state(a.runtime.scope).summary, /closed-1/);
});

test("at most eight conversations run at once, and the summary waits until none is left", async (t) => {
    const f = await fixture(t);
    const a = f.open();
    a.runtime.store.saveSettings(a.runtime.scope, ENABLED);
    const ids = Array.from({ length: 12 }, (_, index) => `closed-${index}`);
    for (const [index, id] of ids.entries())
        await f.writeSession(id, START - 3 * HOUR - index * 60_000);
    let release;
    a.model.hold = new Promise((resolve) => {
        release = resolve;
    });
    await f.step(0, a.runtime);
    await f.step(45_000, a.runtime);
    await f.step(45_000, a.runtime);
    await until(() => a.model.inFlight === WORKER_LIMIT, "eight jobs run");
    assert.equal(a.runtime.status().coordinator.workers, WORKER_LIMIT);
    await f.step(30_000, a.runtime);
    assert.equal(a.model.extractions.length, WORKER_LIMIT, "no ninth job");
    release();
    await settled(a.runtime);
    // A backlog fills the freed slots at the next heartbeat.
    await f.step(1000, a.runtime);
    await settled(a.runtime);
    assert.deepEqual([...a.model.extractions].sort(), [...ids].sort());
    assert.equal(a.model.maxInFlight, WORKER_LIMIT);
    assert.equal(a.model.consolidations, 0);
    await f.step(30_000, a.runtime);
    await f.step(30_000, a.runtime);
    assert.equal(a.model.consolidations, 1);
    assert.equal(a.runtime.store.records(a.runtime.scope).length, 12);
});

test("when the coordinating session freezes, another takes over and the conversation becomes memory once", async (t) => {
    const f = await fixture(t);
    const a = f.open(),
        b = f.open();
    a.runtime.store.saveSettings(a.runtime.scope, ENABLED);
    await f.writeSession("closed-1", START - 3 * HOUR);
    a.model.hold = new Promise(() => {});
    await f.step(0, a.runtime, b.runtime);
    await f.step(45_000, a.runtime, b.runtime);
    await f.step(45_000, a.runtime, b.runtime);
    await until(() => a.model.inFlight === 1, "A's job runs");
    // A freezes: it stops renewing its lease while its job still holds the conversation.
    await f.step(45_000, b.runtime);
    assert.equal(isLeader(b.runtime), false);
    await f.step(50_000, b.runtime);
    assert.equal(isLeader(b.runtime), true, "B takes over a lapsed lease");
    // A wakes, sees it slept and lost the lease, and stops its job.
    await f.step(5000, a.runtime);
    assert.equal(isLeader(a.runtime), false);
    await settled(a.runtime);
    assert.equal(a.model.inFlight, 0);
    const [job] = f.inspect(
        "SELECT owner, status, attempts FROM jobs WHERE key = 'extract:closed-1'",
    );
    assert.deepEqual(
        { ...job },
        { owner: null, status: "cancelled", attempts: 0 },
        "a stopped job keeps its attempts",
    );
    await f.step(45_000, b.runtime);
    await f.step(45_000, b.runtime);
    await settled(b.runtime);
    assert.deepEqual(b.model.extractions, ["closed-1"]);
    assert.deepEqual(
        b.runtime.store
            .records(b.runtime.scope)
            .map((record) => record.source.id),
        ["closed-1"],
    );
});

test("after a long gap the coordinator waits for open sessions to renew their heartbeat", async (t) => {
    const f = await fixture(t);
    const a = f.open();
    a.runtime.store.saveSettings(a.runtime.scope, ENABLED);
    await f.writeSession("open-1", START - 3 * HOUR);
    const keepOpen = () =>
        a.runtime.store.activity(
            a.runtime.scope,
            "open-1",
            "another-process",
            false,
            f.clock.now,
        );
    keepOpen();
    await f.step(0, a.runtime);
    keepOpen();
    await f.step(45_000, a.runtime);
    keepOpen();
    await f.step(45_000, a.runtime);
    await settled(a.runtime);
    assert.deepEqual(a.model.extractions, []);
    // The computer sleeps for ten minutes; open-1's heartbeat lapses before its process runs again.
    await f.step(10 * 60_000, a.runtime);
    await settled(a.runtime);
    assert.deepEqual(a.model.extractions, [], "no dispatch right after waking");
    await f.step(20_000);
    keepOpen();
    await f.step(25_000, a.runtime);
    keepOpen();
    await f.step(45_000, a.runtime);
    await settled(a.runtime);
    assert.deepEqual(a.model.extractions, [], "open-1 stays open");
});

test("typing stops only the current conversation's job; Stop and shutdown stop every job and release the lease", async (t) => {
    const f = await fixture(t);
    const a = f.open();
    a.runtime.store.saveSettings(a.runtime.scope, ENABLED);
    await f.writeSession("closed-1", START - 3 * HOUR);
    await f.writeSession("closed-2", START - 3 * HOUR);
    a.model.hold = new Promise(() => {});
    await f.step(0, a.runtime);
    await f.step(45_000, a.runtime);
    await f.step(45_000, a.runtime);
    await until(() => a.model.inFlight === 2, "two jobs run");
    await a.runtime.cancelCurrent();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(a.model.inFlight, 2, "background jobs keep running");
    await a.runtime.cancel();
    assert.equal(a.model.inFlight, 0);
    assert.equal(a.runtime.isRunning, false);
    // A provider that ignores cancellation cannot keep shutdown or the database waiting.
    a.model.hold = undefined;
    a.model.ignoreCancel = true;
    await f.step(30_000, a.runtime);
    await f.step(30_000, a.runtime);
    await until(() => a.model.inFlight === 2, "the jobs start again");
    const closed = a.runtime.dispose();
    const timeout = new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("dispose hung")), 2000),
    );
    await Promise.race([closed, timeout]);
    assert.deepEqual(
        f
            .inspect(
                "SELECT key, owner, status, attempts FROM jobs ORDER BY key",
            )
            .map((row) => ({ ...row })),
        [
            {
                key: "extract:closed-1",
                owner: null,
                status: "cancelled",
                attempts: 0,
            },
            {
                key: "extract:closed-2",
                owner: null,
                status: "cancelled",
                attempts: 0,
            },
        ],
    );
    assert.deepEqual(f.inspect("SELECT * FROM coordinators"), []);
    assert.deepEqual(f.inspect("SELECT * FROM activity"), []);
});

test("a killed session's expired heartbeat and lease are removed at the next heartbeat, even with memory off", async (t) => {
    const f = await fixture(t);
    const a = f.open(),
        b = f.open();
    a.runtime.store.saveSettings(a.runtime.scope, ENABLED);
    await f.step(0, a.runtime, b.runtime);
    assert.equal(isLeader(a.runtime), true);
    // A is killed: it never renews or releases its rows. Then B turns memory off.
    await b.runtime.saveSettings({ ...ENABLED, generateMemories: false });
    assert.equal(f.inspect("SELECT * FROM activity").length, 1, "A's row");
    assert.equal(
        f.inspect("SELECT * FROM coordinators").length,
        1,
        "A's lease",
    );
    await f.step(45_000, b.runtime);
    assert.equal(
        f.inspect("SELECT * FROM activity").length,
        1,
        "not expired yet",
    );
    await f.step(50_000, b.runtime);
    assert.deepEqual(f.inspect("SELECT * FROM activity"), []);
    assert.deepEqual(f.inspect("SELECT * FROM coordinators"), []);
});
test("turning memory off in any session stops coordination and releases the lease", async (t) => {
    const f = await fixture(t);
    const a = f.open(),
        b = f.open();
    a.runtime.store.saveSettings(a.runtime.scope, ENABLED);
    await f.step(0, a.runtime, b.runtime);
    assert.equal(isLeader(a.runtime), true);
    assert.equal(f.inspect("SELECT * FROM activity").length, 2);
    await b.runtime.saveSettings({ ...ENABLED, generateMemories: false });
    await f.step(30_000, a.runtime);
    assert.equal(isLeader(a.runtime), false);
    assert.deepEqual(f.inspect("SELECT * FROM coordinators"), []);
    assert.deepEqual(f.inspect("SELECT * FROM activity"), []);
});

test("a finished conversation is not reread until its file changes, and a change makes memory again", async (t) => {
    const f = await fixture(t);
    const a = f.open();
    a.runtime.store.saveSettings(a.runtime.scope, ENABLED);
    const first = await f.writeSession("closed-1", START - 3 * HOUR);
    const second = await f.writeSession("closed-2", START - 3 * HOUR);
    await f.step(0, a.runtime);
    await f.step(45_000, a.runtime);
    await f.step(45_000, a.runtime);
    await settled(a.runtime);
    assert.deepEqual([...a.model.extractions].sort(), ["closed-1", "closed-2"]);
    // An unreadable file fails the scan if it is read; a finished, unchanged one is not read.
    await chmod(second, 0o000);
    t.after(() => chmod(second, 0o600).catch(() => {}));
    await f.step(30_000, a.runtime);
    await f.step(30_000, a.runtime);
    await settled(a.runtime);
    assert.equal(a.runtime.failure, undefined);
    assert.equal(a.model.consolidations, 1, "the scan ran");
    f.clock.now += 3 * HOUR;
    const later = START + 20 * 60_000;
    await appendFile(
        first,
        `${JSON.stringify({
            type: "message",
            id: "user-2",
            parentId: "user",
            timestamp: new Date(later).toISOString(),
            message: {
                role: "user",
                content: "Also keep the release gate amber.",
                timestamp: later,
            },
        })}\n`,
    );
    await utimes(first, later / 1000, later / 1000);
    // The clock jumped three hours, so the coordinator first waits one heartbeat period.
    await f.step(45_000, a.runtime);
    await f.step(45_000, a.runtime);
    await f.step(45_000, a.runtime);
    await settled(a.runtime);
    assert.deepEqual([...a.model.extractions].sort(), [
        "closed-1",
        "closed-1",
        "closed-2",
    ]);
});

test("the timer starts the heartbeat with the session and shutdown removes it", async (t) => {
    const f = await fixture(t);
    const a = f.open();
    a.runtime.store.saveSettings(a.runtime.scope, {
        ...ENABLED,
        pollIntervalMs: 1000,
    });
    a.runtime.start();
    assert.equal(
        a.runtime.store.isSessionOpen(a.runtime.sessionId, f.clock.now),
        true,
    );
    await until(() => isLeader(a.runtime), "the timer runs the coordinator");
    await a.runtime.dispose();
    assert.deepEqual(f.inspect("SELECT * FROM activity"), []);
    assert.deepEqual(f.inspect("SELECT * FROM coordinators"), []);
});

test("parallel jobs that update existing memories do not void each other", async (t) => {
    const f = await fixture(t);
    const a = f.open();
    a.runtime.store.saveSettings(a.runtime.scope, ENABLED);
    const paths = [
        await f.writeSession("closed-1", START - 3 * HOUR),
        await f.writeSession("closed-2", START - 3 * HOUR),
    ];
    await f.step(0, a.runtime);
    await f.step(45_000, a.runtime);
    await f.step(45_000, a.runtime);
    await settled(a.runtime);
    assert.equal(a.model.extractions.length, 2);
    // Both conversations were reopened, continued and closed again.
    f.clock.now += 3 * HOUR;
    for (const path of paths)
        await f.continueSession(path, START + 10 * 60_000);
    let release;
    a.model.hold = new Promise((resolve) => {
        release = resolve;
    });
    await f.step(45_000, a.runtime);
    await f.step(45_000, a.runtime);
    await f.step(45_000, a.runtime);
    await until(() => a.model.inFlight === 2, "both run at once");
    release();
    await settled(a.runtime);
    for (let index = 0; index < 4; index++) await f.step(30_000, a.runtime);
    await settled(a.runtime);
    assert.equal(a.model.extractions.length, 4, "no job was repeated");
    assert.deepEqual(
        f
            .inspect(
                "SELECT key, status FROM jobs WHERE key LIKE 'extract:%' ORDER BY key",
            )
            .map((row) => ({ ...row })),
        [
            { key: "extract:closed-1", status: "succeeded" },
            { key: "extract:closed-2", status: "succeeded" },
        ],
    );
});

test("an empty summary at start does not delay the first real summary", async (t) => {
    const f = await fixture(t);
    const a = f.open();
    a.runtime.store.saveSettings(a.runtime.scope, ENABLED);
    await f.step(0, a.runtime);
    await f.step(45_000, a.runtime);
    await f.step(45_000, a.runtime);
    await settled(a.runtime);
    assert.equal(a.runtime.store.state(a.runtime.scope).consolidatedAtMs, 0);
    // Later a conversation qualifies.
    await f.writeSession("closed-1", f.clock.now - 3 * HOUR);
    for (let index = 0; index < 4; index++) await f.step(30_000, a.runtime);
    await settled(a.runtime);
    assert.deepEqual(a.model.extractions, ["closed-1"]);
    await f.step(30_000, a.runtime);
    await f.step(30_000, a.runtime);
    assert.equal(a.model.consolidations, 1, "no two-hour wait");
});

test("a session marks itself open when Personal memory is on or its folder moved to Personal elsewhere", async (t) => {
    const f = await fixture(t);
    const other = join(f.root, "other");
    await mkdir(other);
    const b = f.open(fakeModel(), other);
    const isOpen = () =>
        b.runtime.store.isSessionOpen(b.runtime.sessionId, f.clock.now);
    await f.step(0, b.runtime);
    assert.equal(isOpen(), false, "every scope is off");
    // Personal collects every folder, so its memory being on is enough.
    b.runtime.store.saveSettings("global", ENABLED);
    await f.step(1000, b.runtime);
    assert.equal(isOpen(), true);
    b.runtime.store.saveSettings("global", {
        ...ENABLED,
        generateMemories: false,
    });
    await f.step(1000, b.runtime);
    assert.equal(isOpen(), false);
    // Another session moves this folder to Personal while this session's runtime is idle.
    const c = f.open(fakeModel(), other);
    c.runtime.store.selectScope(other, "global");
    c.runtime.store.saveSettings("global", ENABLED);
    assert.equal(b.runtime.scope.startsWith("workspace-"), true, "old scope");
    await f.step(1000, b.runtime);
    assert.equal(isOpen(), true);
});

test("turning memory off and on between two heartbeats restarts the coordinator's wait", async (t) => {
    const f = await fixture(t);
    const a = f.open(),
        b = f.open();
    a.runtime.store.saveSettings(a.runtime.scope, ENABLED);
    await f.writeSession("open-1", START - 3 * HOUR);
    const keepOpen = () =>
        a.runtime.store.activity(
            a.runtime.scope,
            "open-1",
            "another-process",
            false,
            f.clock.now,
        );
    keepOpen();
    await f.step(0, a.runtime);
    keepOpen();
    await f.step(45_000, a.runtime);
    keepOpen();
    await f.step(45_000, a.runtime);
    await settled(a.runtime);
    keepOpen();
    await f.step(30_000, a.runtime);
    // Memory goes off and on; meanwhile open-1's process saw it off and dropped its mark.
    await b.runtime.saveSettings({ ...ENABLED, generateMemories: false });
    a.runtime.store.releaseActivity("another-process");
    await b.runtime.saveSettings(ENABLED);
    await f.step(30_000, a.runtime);
    await settled(a.runtime);
    assert.deepEqual(a.model.extractions, [], "waits for open sessions again");
    keepOpen();
    await f.step(45_000, a.runtime);
    keepOpen();
    await f.step(45_000, a.runtime);
    await settled(a.runtime);
    assert.deepEqual(a.model.extractions, []);
});

test("an unavailable memory model keeps the summary waiting and the failure visible", async (t) => {
    const f = await fixture(t);
    const a = f.open();
    a.runtime.store.saveSettings(a.runtime.scope, {
        ...ENABLED,
        extractModel: { provider: "fixture", id: "missing" },
    });
    a.runtime.store.addNote(a.runtime.scope, "Deploys need a second reviewer.");
    await f.writeSession("closed-1", START - 3 * HOUR);
    await f.step(0, a.runtime);
    await f.step(45_000, a.runtime);
    await f.step(45_000, a.runtime);
    await settled(a.runtime);
    assert.deepEqual(a.model.extractions, []);
    assert.equal(a.model.consolidations, 0, "the summary waits");
    assert.match(a.runtime.failure ?? "", /Some memory jobs failed/);
});

test("a database error while scheduling does not stop the heartbeat timer", async (t) => {
    const f = await fixture(t);
    const a = f.open();
    a.runtime.store.saveSettings(a.runtime.scope, {
        ...ENABLED,
        pollIntervalMs: 1000,
    });
    const errors = [];
    const onError = (error) => errors.push(error);
    process.on("uncaughtException", onError);
    t.after(() => process.off("uncaughtException", onError));
    a.runtime.start();
    const getSettings = a.runtime.store.getSettings.bind(a.runtime.store);
    a.runtime.store.getSettings = () => {
        throw new Error("database is locked");
    };
    await new Promise((resolve) => setTimeout(resolve, 1500));
    a.runtime.store.getSettings = getSettings;
    assert.deepEqual(errors, []);
    assert.ok(a.runtime.failure, "the error is reported instead");
    await a.runtime.tick();
    assert.equal(a.runtime.failure, undefined, "a clean heartbeat clears it");
});

test("every session in the scope shows what memory jobs are doing, wherever they run", async (t) => {
    const f = await fixture(t);
    const a = f.open(),
        b = f.open();
    a.runtime.store.saveSettings(a.runtime.scope, ENABLED, f.clock.now);
    await f.writeSession("closed-1", START - 3 * HOUR);
    await f.writeSession("closed-2", START - 3 * HOUR);
    let release;
    a.model.hold = new Promise((resolve) => {
        release = resolve;
    });
    let releaseSummary;
    a.model.holdSummary = new Promise((resolve) => {
        releaseSummary = resolve;
    });
    await f.step(0, a.runtime, b.runtime);
    assert.equal(b.runtime.activityText(), undefined);
    await f.step(45_000, a.runtime, b.runtime);
    await f.step(45_000, a.runtime, b.runtime);
    await until(() => a.model.inFlight === 2, "A creates two memories");
    assert.equal(isLeader(b.runtime), false);
    let refreshes = 0;
    b.runtime.onChange = () => refreshes++;
    await b.runtime.tick();
    assert.equal(refreshes, 1, "each heartbeat refreshes the status");
    assert.equal(b.runtime.activityText(), "creating 2 memories…");
    assert.equal(a.runtime.activityText(), "creating 2 memories…");
    release();
    await settled(a.runtime);
    assert.equal(b.runtime.activityText(), undefined);
    await f.step(30_000, a.runtime, b.runtime);
    const summary = f.step(30_000, a.runtime, b.runtime);
    await until(() => a.model.consolidations === 1, "A updates the summary");
    assert.equal(b.runtime.activityText(), "updating summary…");
    releaseSummary();
    await summary;
    assert.equal(b.runtime.activityText(), undefined);
    // A failure in A's session shows in B's.
    await f.writeSession("closed-3", START - 3 * HOUR);
    a.runtime.store.saveSettings(
        a.runtime.scope,
        { ...ENABLED, extractModel: { provider: "fixture", id: "missing" } },
        f.clock.now,
    );
    for (let index = 0; index < 4; index++)
        await f.step(30_000, a.runtime, b.runtime);
    await settled(a.runtime);
    assert.equal(b.runtime.activityText(), "update failed");
    assert.match(b.runtime.failure ?? "", /Some memory jobs failed/);
});

test("Create memories now turns closed conversations into memory without the wait and updates the summary at once", async (t) => {
    const f = await fixture(t);
    const a = f.open();
    a.runtime.store.saveSettings(a.runtime.scope, ENABLED, f.clock.now);
    await f.writeSession("closed-0", START - 3 * HOUR);
    await f.step(0, a.runtime);
    await f.step(45_000, a.runtime);
    await f.step(45_000, a.runtime);
    await settled(a.runtime);
    await f.step(30_000, a.runtime);
    await f.step(30_000, a.runtime);
    assert.equal(a.model.consolidations, 1, "a summary exists");
    // Closed ten minutes ago: the automatic run would wait two hours.
    await f.writeSession("closed-1", f.clock.now - 10 * 60_000);
    await f.writeSession("open-1", f.clock.now - 10 * 60_000);
    a.runtime.store.activity(
        a.runtime.scope,
        "open-1",
        "another-process",
        false,
        f.clock.now,
    );
    let waited;
    const tally = await a.runtime.createNow((ms) => {
        waited = ms;
    });
    assert.equal(waited, undefined, "memory has been on for a while");
    assert.deepEqual(tally, { extracted: 1, failed: 0 });
    assert.deepEqual(a.model.extractions, ["closed-0", "closed-1"]);
    assert.equal(a.model.consolidations, 2, "the summary is updated at once");
    assert.match(a.runtime.store.state(a.runtime.scope).summary, /closed-1/);
});

test("Create memories now waits one heartbeat period after memory was turned on, and Stop ends it", async (t) => {
    const f = await fixture(t);
    const a = f.open();
    await a.runtime.saveSettings(ENABLED);
    await f.writeSession("closed-1", START - 3 * HOUR);
    let waited;
    let release;
    a.model.hold = new Promise((resolve) => {
        release = resolve;
    });
    const run = a.runtime.createNow((ms) => {
        waited = ms;
    });
    assert.equal(waited, ACTIVITY_TTL_MS);
    await until(() => a.model.inFlight === 1, "the job runs after the wait");
    assert.equal(a.runtime.isRunning, true);
    await a.runtime.cancel();
    await assert.rejects(run, (error) => error.name === "AbortError");
    release();
    const [job] = f.inspect(
        "SELECT status, attempts FROM jobs WHERE key = 'extract:closed-1'",
    );
    assert.deepEqual({ ...job }, { status: "cancelled", attempts: 0 });
});

test("/codex-memory offers Create memories now while memory is on, and Stop current job while it runs", async (t) => {
    const f = await fixture(t);
    const notices = [],
        screens = [];
    const a = f.open(fakeModel(), f.cwd, {
        notify: (message) => notices.push(message),
    });
    const options = () => ({
        ctx: a.ctx,
        runtime: a.runtime,
        repositories: {
            store: a.runtime.store,
            scope: a.runtime.scope,
            cwd: a.runtime.cwd,
            signal: a.runtime.signal,
        },
        show() {},
        changeScope: async () => {},
    });
    a.ctx.ui.custom = terminalPicker([undefined], screens);
    await memoryCommand(options());
    assert.doesNotMatch(screens.at(-1), /Create memories now/, "memory off");
    await a.runtime.saveSettings(ENABLED);
    f.clock.now += ACTIVITY_TTL_MS;
    await f.writeSession("closed-1", f.clock.now - 10 * 60_000);
    let release;
    a.model.hold = new Promise((resolve) => {
        release = resolve;
    });
    a.ctx.ui.custom = terminalPicker(
        ["Create memories now", "Last 7 days"],
        screens,
    );
    await memoryCommand(options());
    assert.match(screens.at(-1), /Create memories now/);
    assert.equal(
        notices.at(-1),
        "Creating memories from closed conversations.",
    );
    await until(() => a.model.inFlight === 1, "the job runs");
    a.ctx.ui.custom = terminalPicker([undefined], screens);
    await memoryCommand(options());
    assert.match(screens.at(-1), /Stop current job\s+running/);
    release();
    await until(
        () => notices.at(-1) === "Created memories from 1 conversation(s).",
        "the result is reported",
    );
});

for (const range of ["recent", "all"]) {
    test(`Create memories now ${range} applies only the selected age range and keeps session exclusions`, async (t) => {
        const f = await fixture(t);
        const a = f.open();
        const settings = { ...ENABLED, maxRolloutAgeDays: 3 };
        a.runtime.store.saveSettings(
            a.runtime.scope,
            settings,
            f.clock.now - ACTIVITY_TTL_MS,
        );
        const day = 24 * HOUR;
        await f.writeSession("recent", START - 10 * 60_000);
        await f.writeSession("boundary", START - 3 * day);
        await f.writeSession("outside", START - 3 * day - 1000);
        const oldIds = Array.from(
            { length: WORKER_LIMIT + 1 },
            (_, index) => `old-${index}`,
        );
        for (const id of oldIds) await f.writeSession(id, START - 365 * day);
        await f.writeSession("open", START - 365 * day);
        await f.writeSession(a.runtime.sessionId, START - 365 * day);
        const other = join(f.root, "other");
        await mkdir(other);
        await f.writeSession("foreign", START - day, other);
        await f.step(0, a.runtime);
        a.runtime.store.activity(
            a.runtime.scope,
            "open",
            "another-process",
            false,
            f.clock.now,
        );
        const expected = ["recent", "boundary"];
        if (range === "all") expected.push("outside", ...oldIds);
        assert.deepEqual(await a.runtime.createNow(undefined, range), {
            extracted: expected.length,
            failed: 0,
        });
        assert.deepEqual([...a.model.extractions].sort(), expected.sort());
        assert.ok(a.model.maxInFlight <= WORKER_LIMIT);
        assert.equal(a.model.consolidations, 1);
        assert.deepEqual(a.runtime.settings(), settings);
        assert.deepEqual(await a.runtime.createNow(undefined, range), {
            extracted: 0,
            failed: 0,
        });
        const record = a.runtime.store.records(a.runtime.scope)[0];
        a.runtime.store.revise(a.runtime.scope, record.path, null, f.clock.now);
        assert.deepEqual(await a.runtime.createNow(undefined, range), {
            extracted: 0,
            failed: 0,
        });
        assert.equal(a.model.extractions.length, expected.length);
        await f.writeSession("later-old", START - 365 * day);
        assert.deepEqual(
            await a.runtime.createNow(),
            {
                extracted: 0,
                failed: 0,
            },
            "a later default run still uses the configured period",
        );
        assert.deepEqual(a.runtime.settings(), settings);
    });
}

for (const mode of ["tui", "rpc"]) {
    for (const label of ["All closed conversations", "Last 14 days"]) {
        test(`/codex-memory ${mode} creates memories for ${label}`, async (t) => {
            const f = await fixture(t);
            const screens = [];
            const a = f.open(fakeModel(), f.cwd, {});
            a.ctx.mode = mode;
            a.runtime.store.saveSettings(
                a.runtime.scope,
                { ...ENABLED, maxRolloutAgeDays: 14 },
                f.clock.now - ACTIVITY_TTL_MS,
            );
            await f.writeSession("recent", START - 10 * 60_000);
            await f.writeSession("old", START - 365 * 24 * HOUR);
            const choices = ["Create memories now", label];
            a.ctx.ui.custom = terminalPicker(choices, screens);
            a.ctx.ui.select = async (title, rows) => {
                screens.push([title, ...rows].join("\n"));
                if (title === "Create memories now")
                    assert.deepEqual(rows, [
                        "Last 14 days",
                        "All closed conversations",
                    ]);
                return pickRow(rows, choices.shift());
            };
            await memoryCommand({
                ctx: a.ctx,
                runtime: a.runtime,
                repositories: {},
                show() {},
                changeScope: async () => {},
            });
            await settled(a.runtime);
            assert.match(screens.at(-1), /All closed conversations/);
            assert.match(screens.at(-1), /Last 14 days/);
            if (mode === "tui") assert.match(screens.at(-1), /→ Last 14 days/);
            assert.deepEqual(
                [...a.model.extractions].sort(),
                label === "All closed conversations"
                    ? ["old", "recent"]
                    : ["recent"],
            );
        });
    }
    test(`/codex-memory ${mode} range selection can be cancelled without creating memories`, async (t) => {
        const f = await fixture(t);
        const screens = [],
            notices = [];
        const a = f.open(fakeModel(), f.cwd, {
            notify: (message) => notices.push(message),
        });
        a.ctx.mode = mode;
        a.runtime.store.saveSettings(a.runtime.scope, ENABLED, START);
        await f.writeSession("closed", START - 3 * HOUR);
        const choices = ["Create memories now", undefined, undefined];
        a.ctx.ui.custom = terminalPicker(choices, screens);
        a.ctx.ui.select = async (title, rows) => {
            screens.push([title, ...rows].join("\n"));
            return pickRow(rows, choices.shift());
        };
        await within(
            memoryCommand({
                ctx: a.ctx,
                runtime: a.runtime,
                repositories: {},
                show() {},
                changeScope: async () => {},
            }),
        );
        assert.match(screens.at(-1), /Memory scope/);
        assert.equal(a.runtime.isRunning, false);
        assert.deepEqual(a.model.extractions, []);
        assert.equal(a.model.consolidations, 0);
        assert.deepEqual(notices, []);
    });
}

/** A wait the test ends by hand, so heartbeats can run during it. */
function manualSleep(clock) {
    const waits = [];
    const sleep = (ms, signal) =>
        new Promise((resolve, reject) => {
            signal.throwIfAborted();
            waits.push(() => {
                clock.now += ms;
                resolve();
            });
            signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
            });
        });
    return { sleep, waits };
}

test("a failed job stays visible in every session until it succeeds, whatever finishes after it", async (t) => {
    const f = await fixture(t);
    const a = f.open(),
        b = f.open();
    a.runtime.store.saveSettings(a.runtime.scope, ENABLED, f.clock.now);
    a.model.failIds.add("bad-1");
    await f.writeSession("bad-1", START - 3 * HOUR);
    await f.writeSession("good-1", START - 3 * HOUR);
    await f.step(0, a.runtime, b.runtime);
    await f.step(45_000, a.runtime, b.runtime);
    await f.step(45_000, a.runtime, b.runtime);
    await settled(a.runtime);
    // good-1 succeeded and the summary was updated after bad-1 failed.
    await f.step(30_000, a.runtime, b.runtime);
    await f.step(30_000, a.runtime, b.runtime);
    assert.equal(a.model.consolidations, 1);
    assert.equal(b.runtime.activityText(), "update failed");
    assert.match(b.runtime.failure ?? "", /Some memory jobs failed/);
    // The retry succeeds, so the failure clears in both sessions.
    a.model.failIds.clear();
    for (
        let waited = 0;
        waited <= DEFAULT_SETTINGS.retryDelayMs;
        waited += 30_000
    )
        await f.step(30_000, a.runtime, b.runtime);
    await settled(a.runtime);
    assert.deepEqual(a.model.extractions.sort(), ["bad-1", "bad-1", "good-1"]);
    assert.equal(b.runtime.failure, undefined);
    assert.equal(a.runtime.activityText(), undefined);
});

test("a failed job stays visible after an empty summary is written", async (t) => {
    const f = await fixture(t);
    const a = f.open();
    a.runtime.store.saveSettings(a.runtime.scope, ENABLED, f.clock.now);
    a.model.failIds.add("bad-1");
    await f.writeSession("bad-1", START - 3 * HOUR);
    await f.step(0, a.runtime);
    await f.step(45_000, a.runtime);
    await f.step(45_000, a.runtime);
    await settled(a.runtime);
    await f.step(30_000, a.runtime);
    await f.step(30_000, a.runtime);
    assert.equal(
        a.runtime.store.state(a.runtime.scope).summary.startsWith("v1"),
        true,
    );
    assert.equal(a.model.consolidations, 0, "an empty template needs no model");
    assert.equal(a.runtime.activityText(), "update failed");
});

test("turning memory off for a while and on again does not stop Create memories now", async (t) => {
    const f = await fixture(t);
    const { sleep, waits } = manualSleep(f.clock);
    const a = f.open(fakeModel(), f.cwd, undefined, sleep),
        b = f.open();
    a.runtime.store.saveSettings(a.runtime.scope, ENABLED, f.clock.now);
    await f.step(0, a.runtime);
    await b.runtime.saveSettings({ ...ENABLED, generateMemories: false });
    for (let index = 0; index < 4; index++) await f.step(30_000, a.runtime);
    await b.runtime.saveSettings(ENABLED);
    await f.writeSession("closed-1", f.clock.now - 10 * 60_000);
    const run = a.runtime.createNow();
    await until(() => waits.length === 1, "it waits for open sessions");
    await f.step(30_000, a.runtime);
    waits[0]();
    assert.deepEqual(await run, { extracted: 1, failed: 0 });
});

test("Create memories now right after the computer wakes waits for open sessions", async (t) => {
    const f = await fixture(t);
    const a = f.open();
    a.runtime.store.saveSettings(a.runtime.scope, ENABLED, f.clock.now);
    f.clock.now += 10 * 60_000;
    await f.step(0, a.runtime);
    // The computer sleeps for ten minutes; Create memories now runs before the next heartbeat.
    f.clock.now += 10 * 60_000;
    let waited;
    await a.runtime.createNow((ms) => {
        waited = ms;
    });
    assert.equal(waited, ACTIVITY_TTL_MS);
});

test("Create memories now reports a failed summary, and retries a waiting conversation once", async (t) => {
    const f = await fixture(t);
    const a = f.open();
    a.runtime.store.saveSettings(a.runtime.scope, ENABLED, f.clock.now);
    a.model.failIds.add("bad-1");
    await f.writeSession("bad-1", START - 3 * HOUR);
    await f.step(0, a.runtime);
    await f.step(45_000, a.runtime);
    await f.step(45_000, a.runtime);
    await settled(a.runtime);
    assert.deepEqual(
        a.model.extractions,
        ["bad-1"],
        "bad-1 now waits to retry",
    );
    // Still failing: one more attempt, not a loop.
    assert.deepEqual(await a.runtime.createNow(), { extracted: 0, failed: 1 });
    assert.deepEqual(a.model.extractions, ["bad-1", "bad-1"]);
    // Fixed: the retry succeeds, but the summary model is missing.
    a.model.failIds.clear();
    a.runtime.store.saveSettings(
        a.runtime.scope,
        {
            ...ENABLED,
            consolidateModel: { provider: "fixture", id: "missing" },
        },
        f.clock.now - ACTIVITY_TTL_MS,
    );
    assert.deepEqual(await a.runtime.createNow(), { extracted: 1, failed: 1 });
});

test("Create memories now counts jobs that a scheduled round started, and memory off ends its wait", async (t) => {
    const f = await fixture(t);
    const { sleep, waits } = manualSleep(f.clock);
    const a = f.open(fakeModel(), f.cwd, undefined, sleep),
        b = f.open();
    a.runtime.store.saveSettings(a.runtime.scope, ENABLED, f.clock.now);
    await f.writeSession("closed-1", START - 3 * HOUR);
    let release;
    a.model.hold = new Promise((resolve) => {
        release = resolve;
    });
    await f.step(0, a.runtime);
    await f.step(45_000, a.runtime);
    await f.step(45_000, a.runtime);
    await until(() => a.model.inFlight === 1, "a scheduled job runs");
    const run = a.runtime.createNow();
    release();
    assert.deepEqual(await run, { extracted: 1, failed: 0 });
    // Memory goes off while Create memories now waits for open sessions.
    await b.runtime.saveSettings({ ...ENABLED, minIdleMs: HOUR });
    const waiting = a.runtime.createNow();
    await until(() => waits.length === 1, "it waits after the settings change");
    await b.runtime.saveSettings({ ...ENABLED, generateMemories: false });
    await f.step(30_000, a.runtime);
    await assert.rejects(
        within(waiting),
        (error) => error.name === "AbortError",
    );
});

test("a settings change elsewhere ends running jobs at once; an edit does not delay Create memories now", async (t) => {
    const f = await fixture(t);
    const a = f.open(),
        b = f.open();
    a.runtime.store.saveSettings(a.runtime.scope, ENABLED, f.clock.now);
    await f.writeSession("closed-1", START - 3 * HOUR);
    a.model.hold = new Promise(() => {});
    await f.step(0, a.runtime);
    await f.step(45_000, a.runtime);
    await f.step(45_000, a.runtime);
    await until(() => a.model.inFlight === 1, "A's job runs");
    assert.equal(b.runtime.activityText(), "creating 1 memory…");
    await b.runtime.saveSettings({ ...ENABLED, maxUnusedDays: 90 });
    assert.equal(b.runtime.activityText(), undefined, "the job is voided");
    const [job] = f.inspect(
        "SELECT owner, status, attempts FROM jobs WHERE key = 'extract:closed-1'",
    );
    assert.deepEqual(
        { ...job },
        { owner: null, status: "cancelled", attempts: 0 },
    );
    await f.step(30_000, a.runtime);
    await settled(a.runtime);
    // The next scheduled round makes closed-1 memory.
    a.model.hold = undefined;
    await f.step(45_000, a.runtime);
    await f.step(45_000, a.runtime);
    await settled(a.runtime);
    assert.deepEqual(a.model.extractions, ["closed-1", "closed-1"]);
    // Forgetting a note bumps the epoch but not the heartbeat period.
    const note = b.runtime.store.addNote(b.runtime.scope, "A note to forget.");
    b.runtime.store.revise(b.runtime.scope, note.path, null, f.clock.now);
    let waited;
    await a.runtime.createNow((ms) => {
        waited = ms;
    });
    assert.equal(waited, undefined);
});

test("turning memory off ends Create memories now in a session that does not coordinate", async (t) => {
    const f = await fixture(t);
    const { sleep, waits } = manualSleep(f.clock);
    const leader = f.open(),
        a = f.open(fakeModel(), f.cwd, undefined, sleep);
    leader.runtime.store.saveSettings(
        leader.runtime.scope,
        ENABLED,
        f.clock.now,
    );
    await f.step(0, leader.runtime, a.runtime);
    assert.equal(isLeader(a.runtime), false);
    await leader.runtime.saveSettings({ ...ENABLED, minIdleMs: HOUR });
    const waiting = a.runtime.createNow();
    await until(() => waits.length === 1, "it waits after the settings change");
    await leader.runtime.saveSettings({ ...ENABLED, generateMemories: false });
    await f.step(30_000, a.runtime);
    await assert.rejects(
        within(waiting),
        (error) => error.name === "AbortError",
    );
});
