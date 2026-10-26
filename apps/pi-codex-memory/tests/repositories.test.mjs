import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    symlink,
    utimes,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
    createAssistantMessageEventStream,
    InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
    buildSessionProjection,
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { manageCommand } from "../dist/commands.js";
import { DEFAULT_SETTINGS } from "../dist/config.js";
import extension from "../dist/index.js";
import { EMPTY_SUMMARY, runPipeline } from "../dist/pipeline.js";
import {
    defaultMemoryScope,
    findRepository,
    observeRepository,
    repositoryPath,
} from "../dist/repositories.js";
import { RepositoryAccess } from "../dist/repository-access.js";
import {
    editRepositoryAccess,
    importLegacyMemories,
} from "../dist/repository-commands.js";
import { buildInjection, MemoryReader } from "../dist/retrieval.js";
import { MemoryRuntime } from "../dist/runtime.js";
import { digest, workspaceScope } from "../dist/safety.js";
import {
    branchExposure,
    currentSource,
    isSourceUnchanged,
    ORIGIN_ENTRY,
    RECALL_ENTRY,
    readSource,
    renderProjection,
    scanSources,
} from "../dist/sources.js";
import { MemoryStore } from "../dist/store.js";

const signal = () => new AbortController().signal;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settings = {
    ...DEFAULT_SETTINGS,
    generateMemories: true,
    minIdleMs: 60_000,
    extractModel: { provider: "fixture", id: "extract" },
    consolidateModel: { provider: "fixture", id: "consolidate" },
};
const assistant = () => ({
    role: "assistant",
    content: [{ type: "text", text: "Acknowledged." }],
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
// Synthetic metadata only: tests do not create or remove actual Git worktrees.
async function repository(root) {
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(
        join(root, ".git", "config"),
        "[core]\nrepositoryformatversion = 0\nbare = false\n",
    );
    return findRepository(root);
}
async function fixture(t) {
    const root = await realpath(
        await mkdtemp(join(tmpdir(), "pi-memory-repositories-")),
    );
    const a = await repository(join(root, "repo-a")),
        b = await repository(join(root, "repo-b"));
    const linked = join(root, "linked"),
        gitDir = join(a.commonDirectory, "worktrees", "feature");
    await mkdir(linked);
    await mkdir(gitDir, { recursive: true });
    await writeFile(
        join(linked, ".git"),
        `gitdir: ${relative(linked, gitDir)}\r\n`,
    );
    await writeFile(join(gitDir, "commondir"), "../..\r\n");
    await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/feature\n");
    const agentDir = join(root, "agent"),
        store = new MemoryStore(join(agentDir, "pi-codex-memory"));
    store.registerRepository(a);
    store.registerRepository(b);
    store.registerRepository(findRepository(linked));
    const cleanup = [];
    t.after(async () => {
        for (const fn of cleanup) await fn();
        store.close();
        await rm(root, { recursive: true, force: true });
    });
    return { root, a, b, linked, gitDir, agentDir, store, cleanup };
}
function source(cwd, text = "The confirmed fixture fact is alpha.") {
    const manager = SessionManager.inMemory(cwd);
    manager.appendCustomEntry(ORIGIN_ENTRY, {
        version: 3,
        isInteractiveRoot: true,
        repository: observeRepository(cwd, "session_start"),
    });
    manager.appendMessage({
        role: "user",
        content: text,
        timestamp: Date.now() - 120_000,
    });
    return currentSource(manager, 256 * 1024);
}
function saveRollout(
    store,
    scope,
    value,
    body = "# Task\nThe fixture fact is alpha.",
) {
    const nowMs = Date.now(),
        lease = store.claim(
            scope,
            `extract:${value.id}`,
            value.fingerprint,
            nowMs,
            settings,
            true,
        );
    assert.ok(lease);
    assert.equal(
        store.completeExtraction(lease, value, body, "fixture", nowMs),
        true,
    );
    return store.records(scope).find((record) => record.id === value.id);
}
function citation(read, id = read.source_id) {
    return `<oai-mem-citation>\n<citation_entries>\n${read.citation}\n</citation_entries>\n<rollout_ids>\n${id ?? ""}\n</rollout_ids>\n</oai-mem-citation>`;
}
function context(cwd, ui = {}) {
    return {
        cwd,
        mode: "rpc",
        hasUI: true,
        signal: signal(),
        sessionManager: SessionManager.inMemory(cwd),
        isIdle: () => true,
        ui: { notify() {}, confirm: async () => true, ...ui },
        modelRegistry: { getAvailable: () => [] },
        waitForIdle: async () => {},
    };
}
function managementContext(runtime) {
    return {
        store: runtime.store,
        scope: runtime.scope,
        cwd: runtime.cwd,
        repositoryScope: runtime.repository?.scope,
        signal: runtime.signal,
        cancel: () => runtime.cancel(),
    };
}
function access(f, scope = f.a.scope) {
    const lifetime = new AbortController(),
        value = new RepositoryAccess(f.store, scope, lifetime.signal);
    return {
        value,
        lifetime,
        reader: new MemoryReader(f.store, scope, (target) =>
            value.canRead(target),
        ),
    };
}

test("Git common directory shares subfolders, aliases and linked worktrees; non-Git and nested repositories stay separate", async (t) => {
    const f = await fixture(t),
        sub = join(f.a.worktreeRoot, "src", "payment"),
        plain = join(f.root, "plain");
    await mkdir(sub, { recursive: true });
    await mkdir(join(plain, "sub"), { recursive: true });
    const alias = join(f.root, "alias");
    await symlink(f.a.worktreeRoot, alias);
    for (const path of [sub, alias, f.linked])
        assert.equal(defaultMemoryScope(path), f.a.scope);
    assert.equal(f.store.resolveRepository(`${alias}/`).scope, f.a.scope);
    assert.notEqual(f.a.scope, f.b.scope);
    assert.notEqual(
        defaultMemoryScope(plain),
        defaultMemoryScope(join(plain, "sub")),
    );
    const nested = await repository(join(sub, "nested"));
    assert.notEqual(nested.scope, f.a.scope);
    const invalid = join(sub, "invalid");
    await mkdir(invalid);
    await writeFile(join(invalid, ".git"), "invalid pointer\n");
    assert.equal(
        findRepository(invalid),
        undefined,
        "invalid nested boundaries must not fall through to the parent repository",
    );
    assert.equal(defaultMemoryScope(invalid), workspaceScope(invalid));
    const module = join(f.a.worktreeRoot, "module"),
        moduleGit = join(f.a.commonDirectory, "modules", "module");
    await mkdir(module);
    await mkdir(moduleGit, { recursive: true });
    await writeFile(join(moduleGit, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(moduleGit, "config"), "");
    await writeFile(
        join(module, ".git"),
        `gitdir: ${relative(module, moduleGit)}\n`,
    );
    assert.notEqual(defaultMemoryScope(module), f.a.scope);
    const submodule = findRepository(module);
    f.store.registerRepository(submodule);
    assert.equal(
        f.store.resolveRepository(submodule.commonDirectory).scope,
        submodule.scope,
    );
});

test("metadata resolution agrees with Git in the existing checkout without creating a worktree", async (t) => {
    const cwd = fileURLToPath(new URL("../", import.meta.url)),
        env = { ...process.env };
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"])
        delete env[key];
    const result = spawnSync(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        { cwd, env, encoding: "utf8" },
    );
    if (result.status !== 0) {
        t.skip(
            "No Git working tree available for this read-only parity check.",
        );
        return;
    }
    assert.equal(
        findRepository(cwd).commonDirectory,
        await realpath(result.stdout.trim()),
    );
});

test("scope selection preserves cwd data and explicit global choice without copying settings or facts", async (t) => {
    const f = await fixture(t),
        legacy = workspaceScope(f.a.worktreeRoot);
    f.store.addNote(legacy, "Legacy-only fact.");
    f.store.saveSettings(legacy, settings);
    f.store.selectScope(f.a.worktreeRoot, "workspace");
    assert.equal(f.store.scopeFor(f.a.worktreeRoot), f.a.scope);
    assert.equal(f.store.scopeFor(f.linked), f.a.scope);
    assert.equal(f.store.records(f.a.scope).length, 0);
    assert.equal(f.store.records(legacy).length, 1);
    assert.equal(f.store.getSettings(f.a.scope).generateMemories, false);
    f.store.selectScope(f.a.worktreeRoot, "global");
    assert.equal(f.store.scopeFor(f.a.worktreeRoot), "global");
    assert.equal(f.store.scopeFor(f.linked), f.a.scope);
    f.store.selectScope(f.a.worktreeRoot, "workspace");
    assert.equal(f.store.records(legacy).length, 1);
});

test("repository registration does not silently evict older worktrees or session directories", async (t) => {
    const f = await fixture(t);
    for (let index = 0; index < 257; index++)
        f.store.registerSessionDirectory(
            f.a.scope,
            join(f.root, `sessions-${index}`),
        );
    for (let index = 0; index < 101; index++)
        f.store.registerRepository({
            ...f.a,
            worktreeRoot: join(f.root, `synthetic-root-${index}`),
        });
    const registered = f.store.repository(f.a.scope);
    assert.equal(registered.sessionDirectories.length, 257);
    assert.ok(
        registered.sessionDirectories.includes(join(f.root, "sessions-0")),
    );
    assert.ok(registered.worktreeRoots.includes(f.a.worktreeRoot));
    assert.ok(registered.worktreeRoots.includes(f.linked));
});

test("repository selectors reject ambiguous names and cannot shadow an exact scope ID", async (t) => {
    const f = await fixture(t),
        duplicate = await repository(join(f.root, "other", "repo-a"));
    f.store.registerRepository(duplicate);
    assert.throws(() => f.store.resolveRepository("repo-a"), /Ambiguous/);
    assert.equal(f.store.resolveRepository(f.a.scope).scope, f.a.scope);
    const shadow = await repository(join(f.root, f.a.scope));
    f.store.registerRepository(shadow);
    assert.equal(f.store.resolveRepository(f.a.scope).scope, f.a.scope);
    await writeFile(join(f.linked, ".git"), `gitdir: ${f.b.commonDirectory}\n`);
    assert.equal(
        f.store.resolveRepository(f.linked).scope,
        f.b.scope,
        "a replaced root alias must resolve its current registered repository, not the former one",
    );
});

test("internal scope lookups never resolve repository names, while explicit name selectors remain available", async (t) => {
    const f = await fixture(t),
        tools = new Map(),
        handlers = new Map(),
        plain = join(f.root, "plain");
    await mkdir(plain);
    const workspace = workspaceScope(plain),
        namedGlobal = await repository(join(f.root, "first", "global"));
    const namedWorkspace = await repository(join(f.root, workspace));
    f.store.registerRepository(namedGlobal);
    f.store.registerRepository(namedWorkspace);
    let prompts = 0;
    const ctx = context(plain, {
        confirm: async () => {
            prompts++;
            return true;
        },
    });
    extension(
        {
            registerTool: (tool) => tools.set(tool.name, tool),
            on: (name, handler) => handlers.set(name, handler),
            registerCommand() {},
            appendEntry: (type, data) =>
                ctx.sessionManager.appendCustomEntry(type, data),
            sendMessage() {},
        },
        { agentDir: f.agentDir },
    );
    f.cleanup.push(() => handlers.get("session_shutdown")({}, ctx));
    const tool = (name, params) =>
        tools
            .get(`pi_codex_memory_${name}`)
            .execute(name, params, signal(), undefined, ctx);
    f.store.addNote(workspace, "Plain workspace fact.", Date.now(), "plain.md");
    await handlers.get("session_start")({}, ctx);
    await handlers.get("before_agent_start")({}, ctx);
    assert.equal(
        (await tool("read", { path: "extensions/ad_hoc/notes/plain.md" }))
            .details.repository,
        undefined,
        "a non-Git read must not borrow a repository named after its workspace scope",
    );
    assert.equal((await tool("list", {})).details.repository, undefined);
    assert.equal(
        (await tool("search", { queries: ["Plain"] })).details.repository,
        undefined,
    );
    f.store.addNote(
        namedGlobal.scope,
        "Named repository fact.",
        Date.now(),
        "named.md",
    );
    const named = await tool("read", {
        repository: "global",
        path: "extensions/ad_hoc/notes/named.md",
    });
    assert.equal(
        named.details.repository.id,
        namedGlobal.scope,
        "an explicit repository name still selects that repository",
    );
    assert.equal(prompts, 1);
    f.store.registerRepository(
        await repository(join(f.root, "second", "global")),
    );
    await assert.rejects(tool("list", { repository: "global" }), /Ambiguous/);
    f.store.selectScope(plain, "global");
    f.store.addNote(
        "global",
        "Personal global fact.",
        Date.now(),
        "personal.md",
    );
    await handlers.get("before_agent_start")({}, ctx);
    const personal = await tool("read", {
        path: "extensions/ad_hoc/notes/personal.md",
    });
    assert.equal(personal.details.path, "extensions/ad_hoc/notes/personal.md");
    assert.equal(
        personal.details.repository,
        undefined,
        "personal global has no repository provenance, even beside same-named repositories",
    );
    // An unregistered scope ID that equals another repository's name must not merge registration or links.
    const target = await repository(join(f.root, "target")),
        impostor = await repository(join(f.root, "names", target.scope));
    f.store.registerRepository(impostor);
    f.store.registerSessionDirectory(
        impostor.scope,
        join(f.root, "impostor-sessions"),
    );
    assert.equal(f.store.repository(target.scope), undefined);
    assert.throws(
        () => f.store.setReadLink(f.a.scope, target.scope, true),
        /registered repository/,
    );
    assert.throws(
        () =>
            f.store.registerSessionDirectory(
                target.scope,
                join(f.root, "target-sessions"),
            ),
        /Unknown repository/,
    );
    f.store.registerRepository(target);
    assert.deepEqual(f.store.repository(target.scope).worktreeRoots, [
        target.worktreeRoot,
    ]);
    assert.deepEqual(f.store.repository(target.scope).sessionDirectories, []);
    assert.deepEqual(f.store.repository(impostor.scope).worktreeRoots, [
        impostor.worktreeRoot,
    ]);
    assert.equal(f.store.readLink(f.a.scope, target.scope).isEnabled, false);
    assert.equal(
        f.store.resolveRepository(target.scope).scope,
        target.scope,
        "a registered exact ID wins over the same-named repository",
    );
});

test("legacy import copies only selected active records, preserves originals, and handles path collisions without overwrite", async (t) => {
    const f = await fixture(t),
        cwd = f.linked,
        legacyScope = workspaceScope(cwd);
    f.store.saveSettings(legacyScope, settings);
    const selected = f.store.addNote(
            legacyScope,
            "Selected prior fact.",
            Date.now(),
            "same.md",
        ),
        unselected = f.store.addNote(legacyScope, "Unselected fact.");
    f.store.setRetention(
        legacyScope,
        selected.path,
        true,
        Date.now() + 86_400_000,
    );
    f.store.addNote(f.a.scope, "Current fact remains.", Date.now(), "same.md");
    f.store.markUsed(legacyScope, [selected.path]);
    const before = JSON.stringify(f.store.records(legacyScope));
    const old = f.store.legacyMemories(cwd);
    const result = f.store.importLegacy(
        cwd,
        f.a.scope,
        [selected.id],
        old.revision,
        f.store.state(f.a.scope).revision,
    );
    assert.equal(result.imported, 1);
    assert.equal(JSON.stringify(f.store.records(legacyScope)), before);
    assert.equal(f.store.getSettings(f.a.scope).generateMemories, false);
    const copy = f.store
        .records(f.a.scope)
        .find((record) => record.id === selected.id);
    assert.equal(copy.isPinned, true);
    assert.notEqual(copy.path, selected.path);
    assert.equal(copy.usageCount, 0);
    assert.equal(copy.importedFrom.scope, legacyScope);
    assert.equal(copy.importedFrom.path, selected.path);
    assert.match(f.store.document(copy), /imported_from_cwd:/);
    assert.ok(
        !f.store
            .records(f.a.scope)
            .some((record) => record.id === unselected.id),
    );
    assert.equal(
        await readFile(
            join(f.store.artifactRoot(f.a.scope), copy.path),
            "utf8",
        ),
        f.store.document(copy),
    );
    const revision = f.store.state(f.a.scope).revision;
    assert.equal(
        f.store.importLegacy(
            cwd,
            f.a.scope,
            [selected.id],
            old.revision,
            revision,
        ).imported,
        0,
    );
    assert.equal(
        f.store.state(f.a.scope).revision,
        revision,
        "a no-op import must not invalidate consolidation",
    );
});

test("legacy import copies more records than the consolidation source limit", async (t) => {
    const f = await fixture(t),
        oldScope = workspaceScope(f.a.worktreeRoot),
        template = f.store.addNote(oldScope, "A prior note.");
    // Seed a legacy SQLite fixture without repeatedly publishing all intermediate projections.
    const database = new DatabaseSync(join(f.store.root, "state.sqlite"));
    try {
        database.exec("BEGIN");
        const insert = database.prepare(
            "INSERT INTO records(scope,id,path,value) VALUES(?,?,?,?)",
        );
        for (let index = 0; index < 256; index++) {
            const record = {
                ...template,
                id: `bulk-${index}`,
                path: `extensions/ad_hoc/notes/bulk-${index}.md`,
            };
            insert.run(
                oldScope,
                record.id,
                record.path,
                JSON.stringify(record),
            );
        }
        database.exec("COMMIT");
    } finally {
        database.close();
    }
    const ctx = context(f.a.worktreeRoot);
    const runtime = new MemoryRuntime(ctx, f.agentDir);
    f.cleanup.push(() => runtime.dispose());
    await importLegacyMemories(managementContext(runtime), ctx);
    assert.equal(f.store.records(f.a.scope).length, 257);
    assert.equal(f.store.records(oldScope).length, 257);
});

test("import preserves forgetting, rejects expired notes and cannot revive a copied note after deletion", async (t) => {
    const f = await fixture(t),
        cwd = f.a.worktreeRoot,
        oldScope = workspaceScope(cwd);
    const note = f.store.addNote(oldScope, "A selected remembered fact.");
    const expired = f.store.addNote(oldScope, "An expired fact.");
    const expiresAtMs = Date.now() + 60_000;
    f.store.setRetention(oldScope, expired.path, false, expiresAtMs);
    t.mock.method(Date, "now", () => expiresAtMs + 1);
    let old = f.store.legacyMemories(cwd);
    assert.ok(!old.records.some((record) => record.id === expired.id));
    const imported = f.store.importLegacy(
        cwd,
        f.a.scope,
        [note.id, expired.id],
        old.revision,
        f.store.state(f.a.scope).revision,
    );
    assert.equal(imported.imported, 1);
    assert.equal(imported.skipped, 1);
    f.store.revise(
        f.a.scope,
        note.path,
        "A fresh correction in this repository.",
    );
    const corrected = f.store.records(f.a.scope)[0];
    assert.equal(
        corrected.importedFrom,
        undefined,
        "a new explicit correction must not be attributed to the old imported text",
    );
    f.store.revise(f.a.scope, corrected.path, null);
    old = f.store.legacyMemories(cwd);
    assert.equal(
        f.store.importLegacy(
            cwd,
            f.a.scope,
            [note.id],
            old.revision,
            f.store.state(f.a.scope).revision,
        ).imported,
        0,
    );
    assert.equal(
        f.store.records(oldScope).some((record) => record.id === note.id),
        true,
    );
    assert.equal(f.store.records(f.a.scope).length, 0);
});

test("legacy import fences revisions, foreign directories and active leases atomically", async (t) => {
    const f = await fixture(t),
        oldScope = workspaceScope(f.a.worktreeRoot),
        note = f.store.addNote(oldScope, "Prior fact.");
    const old = f.store.legacyMemories(f.a.worktreeRoot),
        revision = f.store.state(f.a.scope).revision;
    assert.throws(
        () =>
            f.store.importLegacy(f.b.worktreeRoot, f.a.scope, [], 0, revision),
        /belong/,
    );
    const lease = f.store.claim(
        oldScope,
        "extract:pending",
        "pending",
        Date.now(),
        settings,
        true,
    );
    assert.throws(
        () =>
            f.store.importLegacy(
                f.a.worktreeRoot,
                f.a.scope,
                [note.id],
                old.revision,
                revision,
            ),
        /active/,
    );
    f.store.fail(lease, Date.now(), 0, true);
    f.store.addNote(oldScope, "New fact while confirmation is pending.");
    assert.throws(
        () =>
            f.store.importLegacy(
                f.a.worktreeRoot,
                f.a.scope,
                [note.id],
                old.revision,
                revision,
            ),
        /changed/,
    );
    assert.equal(f.store.records(f.a.scope).length, 0);
});

test("one confirmation lasts for one request; noninteractive access is denied unless directionally linked", async (t) => {
    const f = await fixture(t),
        a = access(f);
    let prompts = 0;
    const ctx = context(f.a.worktreeRoot, {
        confirm: async () => {
            prompts++;
            return true;
        },
    });
    assert.equal(a.value.catalog().repositories.length, 1);
    assert.equal(await a.value.authorize("repo-b", undefined, ctx), f.b.scope);
    await a.value.authorize(f.b.scope, undefined, ctx);
    assert.equal(prompts, 1);
    assert.equal(a.value.catalog().repositories.length, 2);
    a.value.beginRequest();
    await a.value.authorize("repo-b", undefined, ctx);
    assert.equal(prompts, 2);
    a.value.beginRequest();
    ctx.hasUI = false;
    await assert.rejects(
        a.value.authorize("repo-b", undefined, ctx),
        /confirmation/,
    );
    f.store.setReadLink(f.a.scope, f.b.scope, true);
    assert.equal(await a.value.authorize("repo-b", undefined, ctx), f.b.scope);
    assert.equal(f.store.readLink(f.b.scope, f.a.scope).isEnabled, false);
    const reopened = new MemoryStore(f.store.root);
    f.cleanup.push(() => reopened.close());
    assert.equal(
        new RepositoryAccess(reopened, f.a.scope, signal()).canRead(f.b.scope),
        true,
    );
});

test("revocation and disabled scopes invalidate reads, including an older request-local grant", async (t) => {
    const f = await fixture(t),
        a = access(f),
        ctx = context(f.a.worktreeRoot);
    await a.value.authorize("repo-b", undefined, ctx);
    f.store.setReadLink(f.a.scope, f.b.scope, true);
    f.store.setReadLink(f.a.scope, f.b.scope, false);
    assert.equal(a.value.canRead(f.b.scope), false);
    f.store.setReadLink(f.a.scope, f.b.scope, true);
    f.store.saveSettings(f.b.scope, {
        ...DEFAULT_SETTINGS,
        useMemories: false,
    });
    await assert.rejects(
        a.value.authorize("repo-b", undefined, ctx),
        /disabled/,
    );
    f.store.saveSettings(f.b.scope, DEFAULT_SETTINGS);
    f.store.saveSettings(f.a.scope, {
        ...DEFAULT_SETTINGS,
        useMemories: false,
    });
    await assert.rejects(
        a.value.authorize("repo-b", undefined, ctx),
        /disabled/,
    );
});

test("late confirmations after request switch, caller abort or disposal cannot grant access", async (t) => {
    const f = await fixture(t);
    for (const reason of ["request", "caller", "lifetime", "link"]) {
        const a = access(f),
            caller = new AbortController();
        let release;
        const ctx = context(f.a.worktreeRoot, {
            confirm: () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        });
        const pending = a.value.authorize(
            "repo-b",
            undefined,
            ctx,
            caller.signal,
        );
        await tick();
        if (reason === "request") a.value.beginRequest();
        else if (reason === "caller") caller.abort();
        else if (reason === "lifetime") a.lifetime.abort();
        else f.store.setReadLink(f.a.scope, f.b.scope, false);
        release(true);
        await assert.rejects(pending);
        assert.equal(a.value.canRead(f.b.scope), false);
    }
});

test("parallel reads coalesce consent and an aborted waiter does not start a second dialog", async (t) => {
    const f = await fixture(t),
        a = access(f);
    let release,
        prompts = 0;
    const ctx = context(f.a.worktreeRoot, {
        confirm: () => {
            prompts++;
            return new Promise((resolve) => {
                release = resolve;
            });
        },
    });
    const first = a.value.authorize("repo-b", undefined, ctx),
        controller = new AbortController();
    const second = a.value.authorize(
        "repo-b",
        undefined,
        ctx,
        controller.signal,
    );
    controller.abort();
    await assert.rejects(second);
    const third = a.value.authorize("repo-b", undefined, ctx);
    assert.equal(prompts, 1);
    release(true);
    await Promise.all([first, third]);
});

test("foreign lookup is explicit, namespaced and credited only to observed source scope", async (t) => {
    const f = await fixture(t),
        a = access(f);
    const local = f.store.addNote(
            f.a.scope,
            "Local alpha fact.",
            Date.now(),
            "same.md",
        ),
        foreign = f.store.addNote(
            f.b.scope,
            "Foreign beta fact.",
            Date.now(),
            "same.md",
        );
    assert.equal(a.reader.search({ queries: ["beta"] }).matches.length, 0);
    assert.doesNotMatch(
        buildInjection(f.store, f.a.scope, DEFAULT_SETTINGS),
        /Foreign beta/,
    );
    assert.throws(
        () => a.reader.read({ scope: f.b.scope, path: foreign.path }),
        /authorized/,
    );
    f.store.setReadLink(f.a.scope, f.b.scope, true);
    const found = a.reader.search({ scope: f.b.scope, queries: ["beta"] })
        .matches[0];
    assert.equal(repositoryPath(found.path).scope, f.b.scope);
    const read = a.reader.read({ scope: f.b.scope, path: found.path });
    a.reader.recordCitations(citation(read));
    assert.equal(a.reader.evidence().citations.valid, 1);
    assert.equal(
        f.store.records(f.b.scope).find((record) => record.id === foreign.id)
            .usageCount,
        1,
    );
    assert.equal(
        f.store.records(f.a.scope).find((record) => record.id === local.id)
            .usageCount,
        0,
    );
    const rollout = saveRollout(f.store, f.b.scope, source(f.b.worktreeRoot));
    const evidence = a.reader.read({ scope: f.b.scope, path: rollout.path });
    a.reader.recordCitations(citation(evidence, "wrong-source"));
    assert.equal(
        f.store.records(f.b.scope).find((record) => record.id === rollout.id)
            .usageCount,
        0,
    );
    a.reader.recordCitations(citation(evidence));
    assert.equal(a.reader.evidence().citations.valid, 1);
    f.store.setReadLink(f.a.scope, f.b.scope, false);
    a.reader.recordCitations(citation(evidence));
    assert.equal(a.reader.evidence().citations.valid, 0);
    assert.equal(
        f.store.records(f.b.scope).find((record) => record.id === rollout.id)
            .usageCount,
        1,
    );
    assert.doesNotMatch(
        buildInjection(f.store, f.a.scope, DEFAULT_SETTINGS),
        /Foreign beta/,
    );
});

test("cursors and explicit selectors cannot cross scopes, and an empty foreign root lists no facts", async (t) => {
    const f = await fixture(t),
        a = access(f);
    f.store.setReadLink(f.a.scope, f.b.scope, true);
    assert.deepEqual(a.reader.list({ scope: f.b.scope }).entries, []);
    for (const scope of [f.a.scope, f.b.scope])
        for (const name of ["one.md", "two.md"])
            f.store.addNote(scope, "same fact", Date.now(), name);
    const first = a.reader.list({
        path: "extensions/ad_hoc/notes",
        max_results: 1,
    });
    assert.ok(first.next_cursor);
    assert.throws(
        () =>
            new MemoryReader(f.store, f.b.scope).list({
                path: "extensions/ad_hoc/notes",
                cursor: first.next_cursor,
            }),
        /changed/,
    );
    const query = a.reader.search({ queries: ["same"], max_results: 1 });
    assert.throws(
        () =>
            a.reader.search({
                scope: f.b.scope,
                queries: ["same"],
                cursor: query.next_cursor,
            }),
        /changed/,
    );
    await assert.rejects(
        a.value.authorize(
            f.a.scope,
            `repositories/${f.b.scope}/extensions/ad_hoc/notes/one.md`,
            context(f.a.worktreeRoot),
        ),
        /different scopes/,
    );
    assert.throws(
        () =>
            a.reader.read({
                scope: f.b.scope,
                path: `repositories/${f.a.scope}/extensions/ad_hoc/notes/one.md`,
            }),
        /different repository/,
    );
});

test("changed foreign content and rejected delivery cannot receive citation credit", async (t) => {
    const f = await fixture(t),
        a = access(f);
    f.store.setReadLink(f.a.scope, f.b.scope, true);
    const note = f.store.addNote(f.b.scope, "beta fact", Date.now(), "fact.md");
    const reject = () => {
        throw new Error("serialized output budget");
    };
    assert.throws(
        () => a.reader.read({ scope: f.b.scope, path: note.path }, reject),
        /budget/,
    );
    assert.throws(
        () => a.reader.search({ scope: f.b.scope, queries: ["beta"] }, reject),
        /budget/,
    );
    assert.equal(a.reader.evidence().observedFiles, 0);
    assert.equal(a.reader.evidence().readCount, 0);
    const read = a.reader.read({ scope: f.b.scope, path: note.path });
    f.store.revise(f.b.scope, note.path, null);
    a.reader.recordCitations(citation(read));
    assert.equal(a.reader.evidence().citations.valid, 0);
});

function exposureProjection(result, marker = { version: 1 }) {
    const timestamp = "2026-01-01T00:00:00.000Z",
        entries = [];
    let parentId = null;
    const add = (id, value) => {
        entries.push({ id, parentId, timestamp, ...value });
        parentId = id;
    };
    const message = (id, value) => add(id, { type: "message", message: value });
    message("u1", {
        role: "user",
        content: "Check the local history, then run the checks.",
        timestamp: 1,
    });
    if (marker)
        add("m1", { type: "custom", customType: RECALL_ENTRY, data: marker });
    message("a1", {
        role: "assistant",
        stopReason: "toolUse",
        timestamp: 2,
        content: [
            { type: "text", text: "LOCAL_PLAN_TEXT" },
            {
                type: "toolCall",
                id: "c1",
                name: result.toolName,
                arguments: {},
            },
        ],
    });
    message("r1", {
        role: "toolResult",
        toolCallId: "c1",
        isError: false,
        timestamp: 3,
        ...result,
    });
    message("a2", {
        role: "assistant",
        stopReason: "toolUse",
        timestamp: 4,
        content: [
            { type: "text", text: "RESTATEMENT_TEXT" },
            {
                type: "toolCall",
                id: "c2",
                name: "fixture_check",
                arguments: { command: "npm test" },
            },
        ],
    });
    message("r2", {
        role: "toolResult",
        toolCallId: "c2",
        toolName: "fixture_check",
        isError: false,
        timestamp: 5,
        content: [{ type: "text", text: "CHECK_RESULT" }],
    });
    message("a3", {
        role: "assistant",
        stopReason: "stop",
        timestamp: 6,
        content: [{ type: "text", text: "FINAL_TEXT" }],
    });
    return buildSessionProjection(entries, parentId);
}

test("external exposure omits intermediate assistant text but keeps ordinary tool evidence; local-only rendering is unchanged", () => {
    const scopeA = `repository-${"a".repeat(24)}`,
        scopeB = `repository-${"b".repeat(24)}`;
    const delivered = (toolName, value, withDetails = true) => ({
        toolName,
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
        ...(withDetails ? { details: value } : {}),
    });
    const descriptor = (scope) => ({
        id: scope,
        name: scope === scopeA ? "repo-a" : "repo-b",
        common_directory: `/tmp/${scope}/.git`,
    });
    const read = (path, scope, content) => ({
        path,
        source_id: null,
        start_line_number: 1,
        end_line_number: 1,
        citation: `${path}:1-1|note=[read evidence]`,
        content,
        truncated: false,
        next_line_offset: null,
        repository: descriptor(scope),
    });
    // A local result can mention qualified paths in its content and carries its own repository descriptor.
    const localRead = delivered(
        "pi_codex_memory_read",
        read(
            "extensions/ad_hoc/notes/local.md",
            scopeA,
            `Mentions repositories/${scopeB}/extensions/ad_hoc/notes/x.md and "repository": {"id": "${scopeB}"}`,
        ),
    );
    const foreignRead = read(
        `repositories/${scopeB}/extensions/ad_hoc/notes/foreign.md`,
        scopeB,
        "FOREIGN_MEMORY_CANARY",
    );
    const catalog = (scopes) => ({
        current_scope: scopeA,
        repositories: scopes.map(descriptor),
        truncated: false,
    });
    // Captured from the renderer before external exposure was distinguished.
    const local =
        "[entry=u1; human user]\nCheck the local history, then run the checks.\n\n[entry=a1; assistant; outcome=toolUse]\nLOCAL_PLAN_TEXT\n\n\n" +
        '[entry=a2; assistant; outcome=toolUse]\nRESTATEMENT_TEXT\n{"tool":"fixture_check","arguments":{"command":"npm test"}}\n\n' +
        "[entry=r2; toolResult tool=fixture_check; isError=false]\nCHECK_RESULT\n\n[entry=a3; harness omission notice, NOT source testimony]\n" +
        "Assistant response omitted because it received memory context; not independent evidence and not evidence of task success or failure.";
    for (const projection of [
        exposureProjection(localRead),
        exposureProjection({
            ...delivered("pi_codex_memory_read", foreignRead),
            isError: true,
        }),
        exposureProjection(
            delivered("pi_codex_memory_list", catalog([scopeA]), false),
        ),
    ])
        assert.equal(renderProjection(projection, 64 * 1024), local);
    const omitted =
        "Assistant text omitted because it received external repository memory context; not independent evidence and not evidence of task success or failure.";
    const external =
        "[entry=u1; human user]\nCheck the local history, then run the checks.\n\n[entry=a1; assistant; outcome=toolUse]\nLOCAL_PLAN_TEXT\n\n\n" +
        `[entry=a2; harness omission notice, NOT source testimony]\n${omitted}\n\n` +
        '[entry=a2; assistant; outcome=toolUse]\n{"tool":"fixture_check","arguments":{"command":"npm test"}}\n\n' +
        `[entry=r2; toolResult tool=fixture_check; isError=false]\nCHECK_RESULT\n\n[entry=a3; harness omission notice, NOT source testimony]\n${omitted}`;
    const foreignSearch = {
        queries: ["fact"],
        match_mode: { type: "any" },
        path: `repositories/${scopeB}`,
        matches: [],
        next_cursor: null,
        truncated: false,
        repository: descriptor(scopeB),
    };
    for (const projection of [
        exposureProjection(delivered("pi_codex_memory_read", foreignRead)),
        exposureProjection(
            delivered("pi_codex_memory_read", foreignRead, false),
        ),
        exposureProjection(delivered("pi_codex_memory_search", foreignSearch)),
        exposureProjection(
            delivered("pi_codex_memory_list", catalog([scopeA, scopeB]), false),
            null,
        ),
    ])
        assert.equal(renderProjection(projection, 64 * 1024), external);
    // A version-2 external marker before the first response covers that response as well.
    assert.equal(
        renderProjection(
            exposureProjection(localRead, { version: 2, exposure: "external" }),
            64 * 1024,
        ),
        external.replace(
            "[entry=a1; assistant; outcome=toolUse]\nLOCAL_PLAN_TEXT\n",
            `[entry=a1; harness omission notice, NOT source testimony]\n${omitted}`,
        ),
    );
});

async function persisted(
    _f,
    cwd,
    directory,
    {
        marked = true,
        bound = true,
        originVersion = bound ? 3 : 2,
        text = "A direct human fixture fact.",
    } = {},
) {
    await mkdir(directory, { recursive: true });
    const manager = SessionManager.create(cwd, directory);
    if (marked)
        manager.appendCustomEntry(ORIGIN_ENTRY, {
            version: originVersion,
            isInteractiveRoot: true,
            ...(bound
                ? { repository: observeRepository(cwd, "session_start") }
                : {}),
        });
    manager.appendMessage({
        role: "user",
        content: text,
        timestamp: Date.now() - 120_000,
    });
    manager.appendMessage(assistant());
    const path = manager.getSessionFile();
    assert.ok(path);
    await utimes(
        path,
        new Date(Date.now() - 120_000),
        new Date(Date.now() - 120_000),
    );
    return manager;
}

test("repository provenance keeps session-start metadata across compaction and checkouts but rejects a repository change", async (t) => {
    const f = await fixture(t),
        manager = await persisted(f, f.linked, join(f.root, "history"));
    const legacy = await persisted(
        f,
        f.linked,
        join(f.root, "legacy-history"),
        { bound: false },
    );
    const before = currentSource(manager, 256 * 1024);
    assert.equal(before.repository.scope, f.a.scope);
    assert.equal(before.repository.branchAtCapture, "feature");
    assert.equal(
        before.fingerprint,
        digest(
            JSON.stringify({
                version: 4,
                leafId: before.leafId,
                text: before.text,
            }),
        ),
        "existing cwd/global fingerprints remain valid for Git sessions",
    );
    manager.appendCompaction(
        "Generated summary is not independent evidence.",
        manager.getLeafId(),
        1000,
    );
    const after = currentSource(manager, 256 * 1024);
    assert.equal(after.fingerprint, before.fingerprint);
    assert.equal(after.updatedAtMs, before.updatedAtMs);
    assert.equal(
        (
            await readSource(
                manager.getSessionFile(),
                256 * 1024,
                signal(),
                true,
                f.a.scope,
            )
        ).fingerprint,
        before.fingerprint,
    );
    const unbound = await readSource(
        legacy.getSessionFile(),
        256 * 1024,
        signal(),
        false,
    );
    assert.equal(unbound.repository.binding, "current_location");
    await writeFile(join(f.gitDir, "HEAD"), "ref: refs/heads/different\n");
    const checkout = currentSource(manager, 256 * 1024);
    assert.equal(
        checkout.fingerprint,
        before.fingerprint,
        "a later checkout must not trigger re-extraction",
    );
    assert.deepEqual(
        checkout.repository,
        before.repository,
        "a later checkout must not rewrite the session-start branch",
    );
    assert.equal(
        (
            await readSource(
                manager.getSessionFile(),
                256 * 1024,
                signal(),
                true,
                f.a.scope,
            )
        ).repository.branchAtCapture,
        "feature",
    );
    assert.equal(await isSourceUnchanged(before, signal(), 256 * 1024), true);
    assert.equal(await isSourceUnchanged(unbound, signal(), 256 * 1024), true);
    await writeFile(join(f.linked, ".git"), `gitdir: ${f.b.commonDirectory}\n`);
    assert.equal(
        currentSource(manager, 256 * 1024),
        null,
        "changed repository binding must not reassociate old history",
    );
    assert.equal(await isSourceUnchanged(before, signal(), 256 * 1024), false);
    assert.equal(
        await isSourceUnchanged(unbound, signal(), 256 * 1024),
        false,
        "an unchanged content fingerprint must not hide a repository change",
    );
});

test("registered directories scan all worktrees but reject foreign and legacy sources before rendering their input", async (t) => {
    const f = await fixture(t),
        sub = join(f.a.worktreeRoot, "src");
    await mkdir(sub);
    const dirs = ["main", "linked", "foreign", "legacy", "invalid-binding"].map(
        (name) => join(f.agentDir, "sessions", name),
    );
    const first = await persisted(f, sub, dirs[0]);
    const second = await persisted(f, f.linked, dirs[1]);
    await persisted(f, f.b.worktreeRoot, dirs[2], {
        text: "Foreign human evidence. ".repeat(20000),
    });
    await persisted(f, f.a.worktreeRoot, dirs[3], { bound: false });
    await persisted(f, f.a.worktreeRoot, dirs[4], { originVersion: 2 });
    for (const dir of dirs) f.store.registerSessionDirectory(f.a.scope, dir);
    const options = {
        cwd: f.a.worktreeRoot,
        agentDir: f.agentDir,
        sessionDir: dirs[0],
        scope: f.a.scope,
        sessionDirectories: f.store.repository(f.a.scope).sessionDirectories,
        settings,
        signal: signal(),
        nowMs: Date.now(),
    };
    const scanned = await scanSources(options);
    assert.deepEqual(
        new Set(scanned.map((value) => value.id)),
        new Set([first.getSessionId(), second.getSessionId()]),
    );
    const imported = await scanSources({ ...options, allowUnmarked: true });
    assert.equal(
        imported.length,
        4,
        "explicit import may inspect matching legacy sessions, never the foreign oversized input",
    );
});

test("repository collection excludes conversations from a cwd that currently selects personal global", async (t) => {
    const f = await fixture(t),
        sub = join(f.a.worktreeRoot, "personal");
    await mkdir(sub);
    const dirs = ["personal", "linked"].map((name) =>
        join(f.agentDir, "sessions", name),
    );
    const personal = await persisted(f, sub, dirs[0], {
        text: "Personal global conversation. ".repeat(20000),
    });
    const shared = await persisted(f, f.linked, dirs[1]);
    for (const dir of dirs) f.store.registerSessionDirectory(f.a.scope, dir);
    f.store.selectScope(sub, "global");
    const options = {
        cwd: f.a.worktreeRoot,
        agentDir: f.agentDir,
        sessionDir: dirs[1],
        scope: f.a.scope,
        sessionDirectories: f.store.repository(f.a.scope).sessionDirectories,
        settings,
        signal: signal(),
        nowMs: Date.now(),
        isCwdExcluded: (cwd) => f.store.selectsGlobal(cwd),
    };
    assert.deepEqual(
        (await scanSources(options)).map((value) => value.id),
        [shared.getSessionId()],
        "excluded before rendering its oversized input",
    );
    const global = await scanSources({
        ...options,
        scope: "global",
        isCwdExcluded: undefined,
        settings: { ...settings, maxInputBytes: 2 * 1024 * 1024 },
    });
    assert.ok(
        global.some((value) => value.id === personal.getSessionId()),
        "personal global keeps its existing collection",
    );
    const extracted = [];
    const ctx = {
        ...context(f.a.worktreeRoot),
        modelRegistry: {
            getAvailable: () => [],
            find: (provider, id) => ({ provider, id }),
            streamSimple(_model, request) {
                const input = JSON.parse(request.messages[0].content[0].text);
                if ("rendered_conversation" in input)
                    extracted.push(input.source_thread_id);
                const output =
                    "rendered_conversation" in input
                        ? {
                              rollout_summary: "The fixture fact is alpha.",
                              rollout_slug: "alpha",
                          }
                        : { memory_summary: EMPTY_SUMMARY };
                return {
                    async result() {
                        return {
                            stopReason: "stop",
                            content: [
                                { type: "text", text: JSON.stringify(output) },
                            ],
                        };
                    },
                };
            },
        },
    };
    f.store.saveSettings(f.a.scope, settings);
    const runtime = new MemoryRuntime(ctx, f.agentDir);
    f.cleanup.push(() => runtime.dispose());
    await runtime.run("refresh");
    assert.deepEqual(extracted, [shared.getSessionId()]);
    assert.deepEqual(
        f.store.records(f.a.scope).map((record) => record.id),
        [shared.getSessionId()],
    );
});

test("a personal-global selection after the candidate scan stops transmission and late publication", async (t) => {
    const f = await fixture(t),
        sub = join(f.a.worktreeRoot, "personal");
    await mkdir(sub);
    f.store.saveSettings(f.a.scope, settings);
    const reply = {
        text: '{"rollout_summary":"The fixture fact is alpha.","rollout_slug":"alpha"}',
    };
    let validations = 0,
        calls = 0;
    const run = (value, model) =>
        runPipeline({
            store: f.store,
            scope: f.a.scope,
            settings,
            model,
            sources: [value],
            signal: signal(),
        });
    await run(source(sub), {
        validate() {
            if (++validations === 1) f.store.selectScope(sub, "global");
        },
        async complete() {
            calls++;
            return reply;
        },
    });
    assert.equal(validations, 2);
    assert.equal(
        calls,
        0,
        "the atomic pre-transmission check sees the new selection",
    );
    f.store.selectScope(sub, "workspace");
    await run(source(sub, "Another fixture fact."), {
        async complete() {
            calls++;
            f.store.selectScope(sub, "global");
            return reply;
        },
    });
    assert.equal(calls, 1);
    assert.equal(
        f.store.records(f.a.scope).length,
        0,
        "a late result is not published after the selection changes",
    );
});

test("generation sends and stores repository provenance and rejects wrong-scope or legacy-forgotten sources", async (t) => {
    const f = await fixture(t),
        value = source(f.linked),
        calls = [];
    f.store.saveSettings(f.a.scope, settings);
    const model = {
        async complete(request) {
            calls.push(request);
            const input = JSON.parse(request.input);
            return {
                text: JSON.stringify(
                    request.stage === "extraction"
                        ? {
                              rollout_summary:
                                  "The confirmed fixture fact is alpha.",
                              rollout_slug: "alpha",
                          }
                        : {
                              memory_summary:
                                  EMPTY_SUMMARY +
                                  input.documents
                                      .map(
                                          (document) =>
                                              `- ${document.path} — fixture; thread_id=${document.thread_id}`,
                                      )
                                      .join("\n"),
                          },
                ),
            };
        },
    };
    const run = (sources, scope = f.a.scope) =>
        runPipeline({
            store: f.store,
            scope,
            settings,
            model,
            sources,
            signal: signal(),
            force: true,
        });
    assert.equal((await run([value])).extracted, 1);
    assert.equal(
        JSON.parse(calls[0].input).repository_observation.scope,
        f.a.scope,
    );
    const record = f.store.records(f.a.scope)[0];
    assert.match(f.store.document(record), /git_branch_at_capture: "feature"/);
    assert.equal(
        await readFile(
            join(f.store.artifactRoot(f.a.scope), record.path),
            "utf8",
        ),
        f.store.document(record),
    );
    const before = calls.length;
    await run([source(f.b.worktreeRoot)]);
    assert.equal(calls.length, before);
    const forgotten = source(f.a.worktreeRoot, "A forgotten original fact.");
    const legacy = saveRollout(
        f.store,
        workspaceScope(forgotten.cwd),
        forgotten,
    );
    f.store.revise(workspaceScope(forgotten.cwd), legacy.path, null);
    await run([forgotten]);
    assert.equal(calls.length, before);
});

test("a legacy forget during extraction rejects the late result, and shared settings stop later stage calls", async (t) => {
    const f = await fixture(t);
    f.store.saveSettings(f.a.scope, settings);
    const value = source(f.a.worktreeRoot),
        legacy = saveRollout(f.store, workspaceScope(value.cwd), value);
    let release,
        calls = 0;
    const pending = runPipeline({
        store: f.store,
        scope: f.a.scope,
        settings,
        sources: [value],
        signal: signal(),
        model: {
            complete() {
                calls++;
                return new Promise((resolve) => {
                    release = resolve;
                });
            },
        },
    });
    await tick();
    f.store.revise(workspaceScope(value.cwd), legacy.path, null);
    release({
        text: '{"rollout_summary":"The fixture fact is alpha.","rollout_slug":"alpha"}',
    });
    await pending;
    assert.equal(calls, 1);
    assert.equal(f.store.records(f.a.scope).length, 0);
    const next = source(f.linked),
        another = source(f.a.worktreeRoot, "Another independent fact.");
    const model = {
        async complete() {
            calls++;
            f.store.saveSettings(f.a.scope, {
                ...settings,
                generateMemories: false,
            });
            return {
                text: '{"rollout_summary":"The fixture fact is alpha.","rollout_slug":"alpha"}',
            };
        },
    };
    await runPipeline({
        store: f.store,
        scope: f.a.scope,
        settings,
        sources: [next, another],
        signal: signal(),
        model,
    });
    assert.equal(
        calls,
        2,
        "no second extraction or consolidation may use superseded transmission settings",
    );
    assert.equal(f.store.records(f.a.scope).length, 0);
});

test("public read tools target one repository, preserve qualified citations, and never copy foreign records", async (t) => {
    const f = await fixture(t),
        tools = new Map(),
        handlers = new Map(),
        commands = new Map();
    const ctx = context(f.a.worktreeRoot);
    let prompts = 0;
    ctx.ui.confirm = async () => {
        prompts++;
        return true;
    };
    extension(
        {
            registerTool: (tool) => tools.set(tool.name, tool),
            on: (name, handler) => handlers.set(name, handler),
            registerCommand: (name, command) => commands.set(name, command),
            appendEntry: (type, data) =>
                ctx.sessionManager.appendCustomEntry(type, data),
            sendMessage() {},
        },
        { agentDir: f.agentDir },
    );
    f.cleanup.push(() => handlers.get("session_shutdown")({}, ctx));
    const record = saveRollout(f.store, f.b.scope, source(f.b.worktreeRoot));
    await handlers.get("session_start")({}, ctx);
    await handlers.get("before_agent_start")({}, ctx);
    const tool = (name) => tools.get(`pi_codex_memory_${name}`);
    assert.deepEqual(
        (await tool("list").execute("list", {}, signal(), undefined, ctx))
            .details.entries,
        [],
    );
    const first = await tool("read").execute(
        "read",
        { repository: "repo-b", path: record.path },
        signal(),
        undefined,
        ctx,
    );
    assert.equal(first.details.repository.id, f.b.scope);
    assert.match(first.details.path, /^repositories\//);
    await tool("read").execute(
        "read2",
        { path: first.details.path },
        signal(),
        undefined,
        ctx,
    );
    assert.equal(prompts, 1);
    await handlers.get("message_end")(
        {
            message: {
                role: "assistant",
                stopReason: "stop",
                content: [{ type: "text", text: citation(first.details) }],
            },
        },
        ctx,
    );
    assert.equal(f.store.records(f.b.scope)[0].usageCount, 1);
    assert.equal(f.store.records(f.a.scope).length, 0);
    await handlers.get("input")(
        {
            text: "A steering request",
            source: "interactive",
            streamingBehavior: "steer",
        },
        ctx,
    );
    await tool("read").execute(
        "queued-read",
        { repository: "repo-b", path: record.path },
        signal(),
        undefined,
        ctx,
    );
    assert.equal(
        prompts,
        1,
        "queueing input does not end the answer in progress",
    );
    await handlers.get("message_start")(
        {
            message: {
                role: "user",
                content: "A steering request",
                timestamp: Date.now(),
            },
        },
        ctx,
    );
    await tool("read").execute(
        "steering-read",
        { repository: "repo-b", path: record.path },
        signal(),
        undefined,
        ctx,
    );
    assert.equal(prompts, 2);
    await handlers.get("agent_settled")({}, ctx);
    await handlers.get("before_agent_start")({}, ctx);
    await tool("read").execute(
        "read3",
        { repository: "repo-b", path: record.path },
        signal(),
        undefined,
        ctx,
    );
    assert.equal(prompts, 3);
    const event = {
        messages: [
            { role: "user", content: "new request", timestamp: Date.now() },
        ],
    };
    assert.equal(
        await handlers.get("context")(event, ctx),
        undefined,
        "foreign permissions do not add automatic context injection",
    );
    assert.deepEqual(
        [...commands.keys()],
        ["codex-memory", "codex-memory-manage", "codex-memory-settings"],
    );
});

test("queued input keeps the answer's consent and evidence until delivery; compaction continues the same request", async (t) => {
    const f = await fixture(t),
        tools = new Map(),
        handlers = new Map(),
        notices = [];
    const c = await repository(join(f.root, "repo-c"));
    f.store.registerRepository(c);
    const ctx = context(f.a.worktreeRoot, {
        notify: (message, level) => notices.push({ message, level }),
    });
    let prompts = 0,
        release;
    const approve = async () => {
        prompts++;
        return true;
    };
    ctx.ui.confirm = approve;
    extension(
        {
            registerTool: (tool) => tools.set(tool.name, tool),
            on: (name, handler) => handlers.set(name, handler),
            registerCommand() {},
            appendEntry: (type, data) =>
                ctx.sessionManager.appendCustomEntry(type, data),
            sendMessage() {},
        },
        { agentDir: f.agentDir },
    );
    f.cleanup.push(() => handlers.get("session_shutdown")({}, ctx));
    const local = saveRollout(
        f.store,
        f.a.scope,
        source(f.a.worktreeRoot, "Local human fixture fact."),
    );
    const foreign = saveRollout(f.store, f.b.scope, source(f.b.worktreeRoot)),
        other = saveRollout(f.store, c.scope, source(c.worktreeRoot));
    const read = async (params) =>
        (
            await tools
                .get("pi_codex_memory_read")
                .execute("read", params, signal(), undefined, ctx)
        ).details;
    const deliver = (text) =>
        handlers.get("message_start")(
            { message: { role: "user", content: text, timestamp: Date.now() } },
            ctx,
        );
    const answer = (text) =>
        handlers.get("message_end")(
            {
                message: {
                    role: "assistant",
                    stopReason: "stop",
                    content: [{ type: "text", text }],
                },
            },
            ctx,
        );
    const usage = (scope, id) =>
        f.store.records(scope).find((record) => record.id === id).usageCount;
    await handlers.get("session_start")({}, ctx);
    await handlers.get("before_agent_start")({}, ctx);
    await deliver("Consult the histories.");
    const localRead = await read({ path: local.path }),
        foreignRead = await read({ repository: "repo-b", path: foreign.path });
    assert.equal(prompts, 1);
    await handlers.get("session_compact")({ willRetry: true }, ctx);
    await read({ path: foreignRead.path });
    assert.equal(prompts, 1, "an overflow retry continues the same request");
    const otherRead = await read({ repository: c.scope, path: other.path });
    assert.equal(
        prompts,
        2,
        "after compaction another repository is confirmed, not aborted",
    );
    await handlers.get("input")(
        {
            text: "A follow-up request",
            source: "interactive",
            streamingBehavior: "followUp",
        },
        ctx,
    );
    await read({ path: foreignRead.path });
    assert.equal(
        prompts,
        2,
        "a queued follow-up does not revoke the answer's one-time grant",
    );
    await answer(
        [localRead, foreignRead, otherRead]
            .map((value) => citation(value))
            .join("\n"),
    );
    assert.deepEqual(
        [
            usage(f.a.scope, local.id),
            usage(f.b.scope, foreign.id),
            usage(c.scope, other.id),
        ],
        [1, 1, 1],
    );
    assert.deepEqual(
        notices,
        [],
        "citations of the answer in progress remain valid while input is queued",
    );
    await deliver("A follow-up request");
    await answer(citation(localRead));
    assert.equal(
        usage(f.a.scope, local.id),
        1,
        "delivered input does not inherit observed lines",
    );
    assert.equal(notices.length, 1);
    assert.equal(notices[0].level, "warning");
    await read({ repository: "repo-b", path: foreign.path });
    assert.equal(
        prompts,
        3,
        "delivered input does not inherit one-time consent",
    );
    await deliver("A steering correction");
    ctx.ui.confirm = () => {
        prompts++;
        return new Promise((resolve) => {
            release = resolve;
        });
    };
    const late = read({ repository: "repo-b", path: foreign.path });
    await tick();
    await deliver("Another request");
    release(true);
    await assert.rejects(late);
    ctx.ui.confirm = approve;
    await read({ repository: "repo-b", path: foreign.path });
    assert.equal(
        prompts,
        5,
        "a late approval after delivery does not grant access",
    );
});

function harness(f, ctx) {
    const tools = new Map(),
        handlers = new Map(),
        manager = ctx.sessionManager;
    extension(
        {
            registerTool: (tool) => tools.set(tool.name, tool),
            on: (name, handler) => handlers.set(name, handler),
            registerCommand() {},
            appendEntry: (type, data) => manager.appendCustomEntry(type, data),
            sendMessage() {},
        },
        { agentDir: f.agentDir },
    );
    f.cleanup.push(() => handlers.get("session_shutdown")({}, ctx));
    let calls = 0;
    return {
        tools,
        handlers,
        manager,
        markers: () =>
            manager
                .getBranch()
                .filter(
                    (entry) =>
                        entry.type === "custom" &&
                        entry.customType === RECALL_ENTRY,
                )
                .map((entry) => entry.data.exposure),
        request: async (text) => {
            await handlers.get("before_agent_start")({}, ctx);
            const message = {
                role: "user",
                content: text,
                timestamp: Date.now(),
            };
            await handlers.get("message_start")({ message }, ctx);
            manager.appendMessage(message);
        },
        context: () => handlers.get("context")({ messages: [] }, ctx),
        // Pi appends the requesting assistant message before executing its calls and appending their results.
        turn: async (text, requests = []) => {
            const parts = requests.map(([name, args]) => ({
                type: "toolCall",
                id: `call-${++calls}`,
                name,
                arguments: args,
            }));
            manager.appendMessage({
                ...assistant(),
                stopReason: parts.length ? "toolUse" : "stop",
                content: [{ type: "text", text }, ...parts],
            });
            for (const part of parts) {
                const value =
                    part.name === "fixture_check"
                        ? {
                              content: [
                                  {
                                      type: "text",
                                      text: `CHECK_RESULT ${part.arguments.command}`,
                                  },
                              ],
                              details: {},
                          }
                        : await tools
                              .get(part.name)
                              .execute(
                                  part.id,
                                  part.arguments,
                                  signal(),
                                  undefined,
                                  ctx,
                              );
                manager.appendMessage({
                    role: "toolResult",
                    toolCallId: part.id,
                    toolName: part.name,
                    content: value.content,
                    details: value.details,
                    isError: false,
                    timestamp: Date.now(),
                });
            }
        },
    };
}

test("foreign reads promote a local marker in the same request and stay excluded through compaction and the next request", async (t) => {
    const f = await fixture(t),
        directory = join(f.root, "exposure-sessions");
    await mkdir(directory);
    const ctx = {
            ...context(f.a.worktreeRoot),
            sessionManager: SessionManager.create(f.a.worktreeRoot, directory),
        },
        h = harness(f, ctx);
    saveRollout(
        f.store,
        f.a.scope,
        source(f.a.worktreeRoot, "Local human fixture fact."),
    );
    const foreign = saveRollout(f.store, f.b.scope, source(f.b.worktreeRoot));
    await h.handlers.get("session_start")({}, ctx);
    await h.request("Consult repo-b, then run the checks.");
    await h.context();
    assert.deepEqual(
        h.markers(),
        ["local"],
        "local injection is recorded first",
    );
    await h.turn("LOCAL_PLAN_TEXT", [
        ["pi_codex_memory_read", { repository: "repo-b", path: foreign.path }],
    ]);
    assert.deepEqual(
        h.markers(),
        ["local", "external"],
        "a later foreign read in the same request upgrades the marker",
    );
    await h.context();
    await h.turn("FOREIGN_RESTATEMENT_BEFORE_COMPACTION", [
        ["fixture_check", { command: "check-before-compaction" }],
    ]);
    await h.handlers.get("session_before_compact")({}, ctx);
    h.manager.appendCompaction(
        "COMPACTED_FOREIGN_SUMMARY",
        h.manager.getLeafId(),
        1000,
    );
    await h.handlers.get("session_compact")({ willRetry: true }, ctx);
    await h.context();
    await h.turn("FOREIGN_RESTATEMENT_AFTER_COMPACTION", [
        ["fixture_check", { command: "check-after-compaction" }],
    ]);
    await h.turn("FOREIGN_FINAL_ANSWER");
    await h.handlers.get("agent_settled")({}, ctx);
    await h.request("New request: the local decision is local-only.");
    await h.context();
    assert.deepEqual(
        h.markers(),
        ["local", "external", "external"],
        "the next request still carries earlier foreign context",
    );
    await h.turn("NEXT_REQUEST_RESTATEMENT", [
        ["fixture_check", { command: "check-next-request" }],
    ]);
    await h.turn("NEXT_FINAL_ANSWER");
    const current = currentSource(h.manager, 256 * 1024),
        disk = await readSource(
            h.manager.getSessionFile(),
            256 * 1024,
            signal(),
            true,
            f.a.scope,
        );
    assert.equal(disk.text, current.text);
    assert.equal(disk.fingerprint, current.fingerprint);
    assert.match(current.text, /Consult repo-b/);
    assert.match(current.text, /local-only/);
    assert.match(current.text, /LOCAL_PLAN_TEXT/);
    for (const command of [
        "check-before-compaction",
        "check-after-compaction",
        "check-next-request",
    ]) {
        assert.ok(
            current.text.includes(
                `{"tool":"fixture_check","arguments":{"command":"${command}"}}`,
            ),
        );
        assert.ok(current.text.includes(`CHECK_RESULT ${command}`));
    }
    assert.doesNotMatch(
        current.text,
        /FOREIGN_RESTATEMENT|FOREIGN_FINAL_ANSWER|NEXT_REQUEST_RESTATEMENT|NEXT_FINAL_ANSWER|COMPACTED_FOREIGN_SUMMARY|fixture fact is alpha/,
    );
});

test("foreign searches record external exposure even without matches; local empty searches and listings record none", async (t) => {
    const f = await fixture(t),
        ctx = context(f.a.worktreeRoot),
        h = harness(f, ctx);
    saveRollout(f.store, f.b.scope, source(f.b.worktreeRoot));
    await h.handlers.get("session_start")({}, ctx);
    await h.request("Search both histories.");
    const run = (name, params) =>
        h.tools
            .get(`pi_codex_memory_${name}`)
            .execute(name, params, signal(), undefined, ctx);
    await run("search", { queries: ["absent"] });
    await run("list", {});
    assert.deepEqual(h.markers(), []);
    assert.equal(
        (await run("search", { repository: "repo-b", queries: ["absent"] }))
            .details.matches.length,
        0,
    );
    assert.deepEqual(h.markers(), ["external"]);
});

test("an undelivered oversized repository catalog leaves no exposure marker", async (t) => {
    const f = await fixture(t),
        ctx = context(f.a.worktreeRoot),
        h = harness(f, ctx);
    for (let index = 0; index < 60; index++) {
        const value = await repository(
            join(
                f.root,
                "long",
                "d".repeat(200),
                "e".repeat(200),
                `repo-${index}`,
            ),
        );
        f.store.registerRepository(value);
        f.store.setReadLink(f.a.scope, value.scope, true);
    }
    await h.handlers.get("session_start")({}, ctx);
    await h.request("List readable repositories.");
    const catalog = (max_results) =>
        h.tools
            .get("pi_codex_memory_list")
            .execute(
                "catalog",
                { repositories: true, max_results },
                signal(),
                undefined,
                ctx,
            );
    await assert.rejects(catalog(100), /output budget/);
    assert.deepEqual(h.markers(), []);
    assert.equal((await catalog(2)).details.repositories.length, 2);
    assert.deepEqual(h.markers(), ["external"]);
});

test("foreign branch summaries and nested summaries cannot recycle abandoned memory; a plain branch remains independent", async (t) => {
    const f = await fixture(t),
        directory = join(f.root, "branch-sessions");
    await mkdir(directory);
    const ctx = {
            ...context(f.a.worktreeRoot),
            sessionManager: SessionManager.create(f.a.worktreeRoot, directory),
        },
        h = harness(f, ctx);
    const note = f.store.addNote(
        f.b.scope,
        "FOREIGN_BRANCH_CANARY",
        Date.now(),
        "branch.md",
    );
    await h.handlers.get("session_start")({}, ctx);
    await h.request("Current local human fact.");
    await h.turn("Local acknowledgment.");
    const anchor = h.manager.getLeafId();
    await h.request("Consult the other repository.");
    await h.turn("Lookup", [
        ["pi_codex_memory_read", { repository: f.b.scope, path: note.path }],
    ]);
    await h.turn("The other repository says FOREIGN_BRANCH_CANARY.");
    assert.doesNotMatch(
        currentSource(h.manager, 256 * 1024).text,
        /FOREIGN_BRANCH_CANARY/,
    );
    await h.handlers.get("session_before_tree")({}, ctx);
    h.manager.branchWithSummary(
        anchor,
        "Summary echoes FOREIGN_BRANCH_CANARY.",
    );
    const lookup = (id) => h.manager.getEntry(id);
    assert.equal(branchExposure(h.manager.getBranch(), lookup), "external");
    h.manager.branchWithSummary(
        anchor,
        "Nested summary echoes FOREIGN_BRANCH_CANARY.",
    );
    assert.equal(
        branchExposure(h.manager.getBranch(), lookup),
        "external",
        "summary ancestry must be followed transitively",
    );
    await h.handlers.get("session_tree")({}, ctx);
    await h.request("New local human decision.");
    await h.context();
    assert.deepEqual(h.markers(), ["external"]);
    await h.turn("Applying FOREIGN_BRANCH_CANARY.", [
        ["fixture_check", { command: "current-local-check" }],
    ]);
    const current = currentSource(h.manager, 256 * 1024),
        disk = await readSource(
            h.manager.getSessionFile(),
            256 * 1024,
            signal(),
            true,
            f.a.scope,
        );
    assert.equal(disk.text, current.text);
    assert.equal(disk.fingerprint, current.fingerprint);
    assert.doesNotMatch(current.text, /FOREIGN_BRANCH_CANARY/);
    assert.match(current.text, /New local human decision/);
    assert.match(current.text, /CHECK_RESULT current-local-check/);
    h.manager.branch(anchor);
    await h.handlers.get("session_tree")({}, ctx);
    await h.request("Independent local branch.");
    await h.context();
    await h.turn("CLEAN_LOCAL_ASSISTANT");
    assert.equal(branchExposure(h.manager.getBranch(), lookup), undefined);
    assert.match(
        currentSource(h.manager, 256 * 1024).text,
        /CLEAN_LOCAL_ASSISTANT/,
    );
});

test("local branch summaries remain evidence, while missing or cyclic summary ancestry is not trusted", async (t) => {
    const f = await fixture(t),
        manager = SessionManager.inMemory(f.a.worktreeRoot);
    manager.appendCustomEntry(ORIGIN_ENTRY, {
        version: 3,
        isInteractiveRoot: true,
        repository: observeRepository(f.a.worktreeRoot, "session_start"),
    });
    const anchor = manager.appendMessage({
        role: "user",
        content: "Local original human fact.",
        timestamp: Date.now(),
    });
    manager.appendMessage(assistant());
    const summaryId = manager.branchWithSummary(
        anchor,
        "LOCAL_GENERATED_SUMMARY",
    );
    manager.appendMessage({
        role: "user",
        content: "Local next human fact.",
        timestamp: Date.now(),
    });
    manager.appendMessage({
        ...assistant(),
        content: [{ type: "text", text: "LOCAL_NEXT_RESPONSE" }],
    });
    assert.equal(
        branchExposure(manager.getBranch(), (id) => manager.getEntry(id)),
        undefined,
    );
    assert.match(
        currentSource(manager, 256 * 1024).text,
        /LOCAL_GENERATED_SUMMARY/,
    );
    assert.match(
        currentSource(manager, 256 * 1024).text,
        /LOCAL_NEXT_RESPONSE/,
    );
    for (const isCyclic of [false, true]) {
        // A fork/export can retain a summary without the abandoned path; malformed cycles must terminate too.
        const branch = manager
            .getBranch()
            .map((entry) =>
                isCyclic && entry.id === summaryId
                    ? { ...entry, fromId: summaryId }
                    : entry,
            );
        const entries = new Map(branch.map((entry) => [entry.id, entry]));
        const path = join(
            f.root,
            isCyclic ? "cyclic-summary.jsonl" : "missing-summary.jsonl",
        );
        await writeFile(
            path,
            `${[manager.getHeader(), ...branch]
                .map((entry) => JSON.stringify(entry))
                .join("\n")}\n`,
        );
        const view = {
            getHeader: () => manager.getHeader(),
            getBranch: () => branch,
            getEntry: (id) => entries.get(id),
            getSessionFile: () => path,
        };
        const current = currentSource(view, 256 * 1024),
            disk = await readSource(
                path,
                256 * 1024,
                signal(),
                true,
                f.a.scope,
            );
        assert.equal(disk.text, current.text);
        assert.equal(disk.fingerprint, current.fingerprint);
        assert.match(current.text, /Local next human fact/);
        assert.doesNotMatch(
            current.text,
            /LOCAL_GENERATED_SUMMARY|LOCAL_NEXT_RESPONSE/,
        );
    }
});

test("a busy injection database and a missing context hook cannot reset earlier external exposure", async (t) => {
    const f = await fixture(t),
        notices = [],
        ctx = context(f.a.worktreeRoot, {
            notify: (text) => notices.push(text),
        }),
        h = harness(f, ctx);
    const note = f.store.addNote(
        f.b.scope,
        "FOREIGN_LOCK_CANARY",
        Date.now(),
        "lock.md",
    );
    await h.handlers.get("session_start")({}, ctx);
    await h.request("Consult the other repository.");
    await h.turn("Lookup", [
        ["pi_codex_memory_read", { repository: f.b.scope, path: note.path }],
    ]);
    await h.request("Current local human work.");
    const holder = new DatabaseSync(join(f.store.root, "state.sqlite"));
    holder.exec("BEGIN IMMEDIATE");
    try {
        assert.equal(await h.context(), undefined);
    } finally {
        holder.exec("ROLLBACK");
        holder.close();
    }
    assert.deepEqual(h.markers(), ["external", "external"]);
    assert.ok(notices.some((text) => text.includes("could not be added")));
    await h.turn("Applying FOREIGN_LOCK_CANARY.", [
        ["fixture_check", { command: "after-contention" }],
    ]);
    await h.request("Another local human fact without a context callback.");
    await h.turn("Still applying FOREIGN_LOCK_CANARY.");
    const current = currentSource(h.manager, 256 * 1024);
    assert.doesNotMatch(current.text, /FOREIGN_LOCK_CANARY/);
    assert.match(current.text, /Another local human fact/);
    assert.match(current.text, /CHECK_RESULT after-contention/);
});

test("shared settings changed while source scanning awaits IO supersede the captured runtime job", async (t) => {
    const f = await fixture(t),
        directory = join(f.root, "settings-sessions");
    await mkdir(directory);
    const old = SessionManager.create(f.a.worktreeRoot, directory);
    old.appendCustomEntry(ORIGIN_ENTRY, {
        version: 3,
        isInteractiveRoot: true,
        repository: observeRepository(f.a.worktreeRoot, "session_start"),
    });
    old.appendMessage({
        role: "user",
        content: "The confirmed fixture fact is alpha.",
        timestamp: Date.now() - 120_000,
    });
    old.appendMessage({ ...assistant(), timestamp: Date.now() - 120_000 });
    await utimes(
        old.getSessionFile(),
        new Date(Date.now() - 120_000),
        new Date(Date.now() - 120_000),
    );
    const calls = [],
        ctx = {
            ...context(f.a.worktreeRoot),
            sessionManager: SessionManager.create(f.a.worktreeRoot, directory),
            modelRegistry: {
                getAvailable: () => [],
                find: (provider, id) => ({ provider, id }),
                streamSimple(model, request) {
                    calls.push(model.id);
                    const input = JSON.parse(
                        request.messages[0].content[0].text,
                    );
                    const output =
                        "rendered_conversation" in input
                            ? {
                                  rollout_summary: "The fixture fact is alpha.",
                                  rollout_slug: "alpha",
                              }
                            : { memory_summary: EMPTY_SUMMARY };
                    return {
                        async result() {
                            return {
                                stopReason: "stop",
                                content: [
                                    {
                                        type: "text",
                                        text: JSON.stringify(output),
                                    },
                                ],
                            };
                        },
                    };
                },
            },
        };
    f.store.saveSettings(f.a.scope, settings);
    const runtime = new MemoryRuntime(ctx, f.agentDir);
    f.cleanup.push(() => runtime.dispose());
    const pending = runtime.run("refresh");
    const next = {
        ...settings,
        extractModel: { provider: "fixture", id: "new-choice" },
        consolidateModel: { provider: "fixture", id: "new-choice" },
    };
    f.store.saveSettings(f.a.scope, next); // A separate SQLite connection, like another worktree process.
    await assert.rejects(pending, { code: "superseded" });
    assert.deepEqual(calls, []);
    assert.equal(f.store.records(f.a.scope).length, 0);
    const result = await runtime.run("refresh");
    assert.equal(result.extracted, 1);
    assert.equal(result.consolidated, true);
    assert.deepEqual(
        calls,
        ["new-choice", "new-choice"],
        "only a fresh job may use the newly selected model",
    );
});

test("manual extraction rejects an unbound current session whose repository changes during the request", async (t) => {
    const f = await fixture(t),
        manager = SessionManager.inMemory(f.linked);
    manager.appendCustomEntry(ORIGIN_ENTRY, {
        version: 2,
        isInteractiveRoot: true,
    });
    manager.appendMessage({
        role: "user",
        content: "The confirmed fixture fact is alpha.",
        timestamp: Date.now() - 120_000,
    });
    let calls = 0;
    const ctx = {
        ...context(f.linked),
        sessionManager: manager,
        modelRegistry: {
            getAvailable: () => [],
            find: (provider, id) => ({ provider, id }),
            streamSimple() {
                calls++;
                return {
                    async result() {
                        if (calls === 1)
                            await writeFile(
                                join(f.linked, ".git"),
                                `gitdir: ${f.b.commonDirectory}\n`,
                            );
                        return {
                            stopReason: "stop",
                            content: [
                                {
                                    type: "text",
                                    text: '{"rollout_summary":"The fixture fact is alpha.","rollout_slug":"alpha"}',
                                },
                            ],
                        };
                    },
                };
            },
        },
    };
    f.store.saveSettings(f.a.scope, settings);
    const runtime = new MemoryRuntime(ctx, f.agentDir);
    f.cleanup.push(() => runtime.dispose());
    assert.equal(runtime.scope, f.a.scope);
    const result = await runtime.run("current");
    assert.equal(calls, 1);
    assert.equal(result.extracted, 0);
    assert.equal(
        f.store.records(f.a.scope).length,
        0,
        "an unbound source that moved repositories must not be published",
    );
});

test("management confirms directional access and legacy import without enabling generation", async (t) => {
    const f = await fixture(t),
        ctx = context(f.a.worktreeRoot),
        runtime = new MemoryRuntime(ctx, f.agentDir);
    f.cleanup.push(() => runtime.dispose());
    let rows = ["Add repository…", "Always allow reads", "Back"];
    ctx.ui.select = async () => rows.shift();
    ctx.ui.input = async () => f.b.worktreeRoot;
    await editRepositoryAccess(managementContext(runtime), ctx);
    assert.equal(f.store.readLink(f.a.scope, f.b.scope).isEnabled, true);
    assert.equal(f.store.readLink(f.b.scope, f.a.scope).isEnabled, false);
    rows = [
        (labels) => labels.find((label) => label.startsWith(f.b.name)),
        "Ask each time",
        "Back",
    ];
    ctx.ui.select = async (_title, labels) => {
        const row = rows.shift();
        return typeof row === "function" ? row(labels) : row;
    };
    await editRepositoryAccess(managementContext(runtime), ctx);
    assert.equal(f.store.readLink(f.a.scope, f.b.scope).isEnabled, false);
    const note = f.store.addNote(
        workspaceScope(f.a.worktreeRoot),
        "Explicit legacy selection.",
    );
    await importLegacyMemories(managementContext(runtime), ctx);
    assert.equal(f.store.records(f.a.scope)[0].id, note.id);
    assert.equal(runtime.settings().generateMemories, false);
    assert.equal(f.store.records(workspaceScope(f.a.worktreeRoot)).length, 1);
});

test("legacy import conflicts name the conflicting memory path instead of a generic failure", async (t) => {
    const f = await fixture(t),
        oldScope = workspaceScope(f.a.worktreeRoot);
    const note = f.store.addNote(
        oldScope,
        "Original legacy wording.",
        Date.now(),
        "decision.md",
    );
    const old = f.store.legacyMemories(f.a.worktreeRoot);
    f.store.importLegacy(
        f.a.worktreeRoot,
        f.a.scope,
        [note.id],
        old.revision,
        f.store.state(f.a.scope).revision,
    );
    // Seed a divergent copy with the same record ID without going through a public writer.
    const database = new DatabaseSync(join(f.store.root, "state.sqlite"));
    try {
        const row = database
            .prepare("SELECT value FROM records WHERE scope = ? AND id = ?")
            .get(f.a.scope, note.id);
        database
            .prepare("UPDATE records SET value = ? WHERE scope = ? AND id = ?")
            .run(
                JSON.stringify({
                    ...JSON.parse(row.value),
                    body: "Divergent wording.",
                }),
                f.a.scope,
                note.id,
            );
    } finally {
        database.close();
    }
    const notices = [],
        rows = [
            (labels) => labels.find((label) => label.startsWith("Import")),
            "Close",
        ];
    const ctx = context(f.a.worktreeRoot, {
        select: async (_title, labels) => {
            const row = rows.shift();
            return typeof row === "function" ? row(labels) : row;
        },
        notify: (message, level) => notices.push({ message, level }),
    });
    const runtime = new MemoryRuntime(ctx, f.agentDir);
    f.cleanup.push(() => runtime.dispose());
    await manageCommand({
        ctx,
        runtime,
        repositories: managementContext(runtime),
        show() {},
    });
    assert.equal(notices.length, 1);
    assert.equal(notices[0].level, "error");
    assert.match(notices[0].message, /different version/);
    assert.ok(notices[0].message.includes(note.path));
    assert.doesNotMatch(notices[0].message, /model configuration/);
    assert.equal(
        f.store.records(f.a.scope).find((record) => record.id === note.id).body,
        "Divergent wording.",
        "the conflict is not overwritten",
    );
});

test("management cancellation and late confirmation after disposal leave persistent links unchanged", async (t) => {
    const f = await fixture(t),
        ctx = context(f.a.worktreeRoot),
        runtime = new MemoryRuntime(ctx, f.agentDir);
    f.cleanup.push(() => runtime.dispose());
    let rows = ["Add repository…", "Always allow reads"],
        release;
    ctx.ui.select = async () => rows.shift();
    ctx.ui.input = async () => f.b.worktreeRoot;
    ctx.ui.confirm = () =>
        new Promise((resolve) => {
            release = resolve;
        });
    const pending = editRepositoryAccess(managementContext(runtime), ctx);
    await tick();
    await runtime.dispose();
    release(true);
    await assert.rejects(pending);
    assert.equal(f.store.readLink(f.a.scope, f.b.scope).isEnabled, false);
});

test("repository provenance and tool descriptors use the existing secret masker", async (t) => {
    const f = await fixture(t),
        syntheticToken = `ghp_${"A".repeat(24)}`;
    const sensitive = await repository(join(f.root, syntheticToken));
    f.store.registerRepository(sensitive);
    await writeFile(
        join(sensitive.commonDirectory, "HEAD"),
        `ref: refs/heads/${syntheticToken}\n`,
    );
    const record = saveRollout(
        f.store,
        sensitive.scope,
        source(sensitive.worktreeRoot),
    );
    assert.ok(!f.store.document(record).includes(syntheticToken));
    assert.ok(
        !JSON.stringify(access(f).value.describe(sensitive)).includes(
            syntheticToken,
        ),
    );
});

async function sdkSession(t, f, options = {}) {
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = f.agentDir;
    t.after(() => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
    });
    const settingsManager = SettingsManager.inMemory({
        cacheWarming: "off",
        compaction: { enabled: false },
        quietStartup: true,
    });
    const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        modelsStorePath: join(f.agentDir, "models.json"),
        allowModelNetwork: false,
        refreshOnCreate: false,
    });
    modelRuntime.refresh = async () => ({ aborted: false, errors: new Map() });
    modelRuntime.registerProvider("fixture", {
        baseUrl: "http://unused.invalid",
        api: "openai-completions",
        apiKey: "synthetic-fixture-key",
        models: [
            {
                id: "local",
                name: "Local fixture",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 100000,
                maxTokens: 4096,
            },
        ],
    });
    const model = modelRuntime.getModel("fixture", "local");
    const resourceLoader = new DefaultResourceLoader({
        cwd: f.a.worktreeRoot,
        agentDir: f.agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        additionalExtensionPaths: [
            fileURLToPath(new URL("../", import.meta.url)),
        ],
    });
    await resourceLoader.reload();
    assert.equal(resourceLoader.getExtensions().errors.length, 0);
    const { session } = await createAgentSession({
        cwd: f.a.worktreeRoot,
        agentDir: f.agentDir,
        settingsManager,
        modelRuntime,
        model,
        resourceLoader,
        sessionManager: SessionManager.inMemory(f.a.worktreeRoot),
        noTools: true,
        ...options,
    });
    f.cleanup.push(async () => {
        await session.extensionRunner.emit({ type: "session_shutdown" });
        session.dispose();
    });
    return { session, model };
}
function streamReply(message) {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end(message);
    });
    return stream;
}
function lastRead(input) {
    const tool = input.messages.findLast(
        (message) =>
            message.role === "toolResult" &&
            message.toolName === "pi_codex_memory_read",
    );
    return tool
        ? JSON.parse(
              tool.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n"),
          )
        : undefined;
}

test("real SDK receives citation guidance without local injection and routes linked foreign reads to the owning scope", async (t) => {
    const f = await fixture(t);
    const record = saveRollout(f.store, f.b.scope, source(f.b.worktreeRoot));
    f.store.setReadLink(f.a.scope, f.b.scope, true);
    const { session, model } = await sdkSession(t, f);
    const errors = [];
    await session.bindExtensions({
        mode: "print",
        onError: (error) => errors.push(error),
    });
    const seen = [];
    let calls = 0;
    session.agent.streamFunction = async (_model, input) => {
        seen.push(input);
        const isFirst = calls === 0,
            isFollowUp = calls >= 2;
        calls++;
        return streamReply({
            ...assistant(),
            model: model.id,
            content: isFirst
                ? [
                      {
                          type: "toolCall",
                          id: "external-read",
                          name: "pi_codex_memory_read",
                          arguments: {
                              repository: "repo-b",
                              path: record.path,
                          },
                      },
                  ]
                : [
                      {
                          type: "text",
                          text: isFollowUp
                              ? "The fixture fact is alpha."
                              : "Historical fixture result from repo-b.\n" +
                                citation(lastRead(input)),
                      },
                  ],
            stopReason: isFirst ? "toolUse" : "stop",
        });
    };
    await session.prompt(
        "Consult repo-b's historical record and identify its source.",
    );
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert.equal(calls, 2);
    const systemText = seen[0].messages
        .filter((message) => message.role === "system")
        .flatMap((message) => [
            typeof message.content === "string"
                ? message.content
                : message.content
                      .filter((part) => part.type === "text")
                      .map((part) => part.text)
                      .join("\n"),
            ...Object.values(message.sections ?? {}),
        ])
        .join("\n");
    assert.match(systemText, /<oai-mem-citation>/);
    assert.ok(
        seen.every(
            (input) =>
                !JSON.stringify(input.messages).includes("CODEX_MEMORY_V2"),
        ),
        "external memory is not automatically injected",
    );
    const returned = session.messages.find(
        (message) =>
            message.role === "toolResult" &&
            message.toolName === "pi_codex_memory_read",
    );
    assert.equal(returned.isError, false);
    assert.equal(f.store.records(f.b.scope)[0].usageCount, 1);
    assert.equal(f.store.records(f.a.scope).length, 0);
    await session.prompt(
        "A new local decision: local-only. Continue without another memory lookup.",
    );
    assert.equal(calls, 3);
    const extracted = currentSource(session.sessionManager, 256 * 1024);
    assert.match(extracted.text, /local-only/);
    assert.doesNotMatch(
        extracted.text,
        /The fixture fact is alpha/,
        "a later echo of foreign memory must not become current-repository evidence",
    );
});

test("real SDK keeps a queued follow-up out of the answer's consent and citations until the follow-up is delivered", async (t) => {
    const f = await fixture(t),
        record = saveRollout(f.store, f.b.scope, source(f.b.worktreeRoot));
    const { session, model } = await sdkSession(t, f);
    const errors = [],
        notices = [];
    let prompts = 0,
        calls = 0;
    await session.bindExtensions({
        mode: "rpc",
        onError: (error) => errors.push(error),
        uiContext: {
            setStatus() {},
            setWidget() {},
            notify: (message, level) => notices.push({ message, level }),
            confirm: async () => {
                prompts++;
                return true;
            },
        },
    });
    session.agent.streamFunction = async (_model, input) => {
        const step = calls++,
            isRead = step === 0 || step === 2;
        // Queue while the cited answer is still streaming; Pi delivers it after that answer ends.
        if (step === 1)
            await session.prompt("Follow-up: check the record again.", {
                streamingBehavior: "followUp",
            });
        return streamReply({
            ...assistant(),
            model: model.id,
            content: isRead
                ? [
                      {
                          type: "toolCall",
                          id: `external-read-${step}`,
                          name: "pi_codex_memory_read",
                          arguments: {
                              repository: "repo-b",
                              path: record.path,
                          },
                      },
                  ]
                : [
                      {
                          type: "text",
                          text:
                              step === 1
                                  ? "Historical fixture result from repo-b.\n" +
                                    citation(lastRead(input))
                                  : "Checked again.",
                      },
                  ],
            stopReason: isRead ? "toolUse" : "stop",
        });
    };
    await session.prompt(
        "Consult repo-b's historical record and identify its source.",
    );
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert.equal(calls, 4);
    assert.equal(
        f.store.records(f.b.scope)[0].usageCount,
        1,
        "the queued follow-up does not invalidate the answer in progress",
    );
    assert.deepEqual(
        notices.filter((notice) => notice.level === "warning"),
        [],
    );
    assert.equal(
        prompts,
        2,
        "the delivered follow-up requires fresh one-time consent",
    );
});

test("real SDK records external catalogs and listings from an empty current scope and keeps ordinary tool evidence", async (t) => {
    const f = await fixture(t),
        checks = [];
    saveRollout(f.store, f.b.scope, source(f.b.worktreeRoot));
    f.store.setReadLink(f.a.scope, f.b.scope, true);
    const fixtureCheck = {
        name: "fixture_check",
        label: "Fixture check",
        description: "Run a synthetic local check.",
        parameters: Type.Object({ command: Type.String() }),
        async execute(_id, params) {
            checks.push(params.command);
            return {
                content: [
                    { type: "text", text: `CHECK_RESULT ${params.command}` },
                ],
                details: {},
            };
        },
    };
    const { session, model } = await sdkSession(t, f, {
        customTools: [fixtureCheck],
    });
    const errors = [];
    await session.bindExtensions({
        mode: "print",
        onError: (error) => errors.push(error),
    });
    const steps = [
        { calls: [["pi_codex_memory_list", { repositories: true }]] },
        {
            text: "CATALOG_RESTATEMENT_CANARY",
            calls: [["fixture_check", { command: "check-after-catalog" }]],
        },
        { calls: [["pi_codex_memory_list", { repository: "repo-b" }]] },
        {
            text: "LISTING_RESTATEMENT_CANARY",
            calls: [["fixture_check", { command: "check-after-listing" }]],
        },
        { text: "FINAL_EXTERNAL_CANARY" },
        {
            text: "NEXT_REQUEST_RESTATEMENT_CANARY",
            calls: [["fixture_check", { command: "check-next-request" }]],
        },
        { text: "NEXT_FINAL_CANARY" },
    ];
    let calls = 0;
    session.agent.streamFunction = async () => {
        const step = steps[calls++];
        return streamReply({
            ...assistant(),
            model: model.id,
            stopReason: step.calls ? "toolUse" : "stop",
            content: [
                ...(step.text ? [{ type: "text", text: step.text }] : []),
                ...(step.calls ?? []).map(([name, args], index) => ({
                    type: "toolCall",
                    id: `call-${calls}-${index}`,
                    name,
                    arguments: args,
                })),
            ],
        });
    };
    await session.prompt(
        "Which repositories are readable, and what does repo-b contain?",
    );
    await session.prompt(
        "A new local decision: local-only. Run the next check.",
    );
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert.equal(calls, steps.length);
    assert.deepEqual(checks, [
        "check-after-catalog",
        "check-after-listing",
        "check-next-request",
    ]);
    assert.ok(
        session.messages
            .filter((message) => message.role === "toolResult")
            .every((message) => !message.isError),
    );
    const markers = session.sessionManager
        .getBranch()
        .filter(
            (entry) =>
                entry.type === "custom" && entry.customType === RECALL_ENTRY,
        )
        .map((entry) => entry.data.exposure);
    assert.deepEqual(
        markers,
        ["external", "external"],
        "the catalog marks this request and its context marks the next one",
    );
    const extracted = currentSource(session.sessionManager, 256 * 1024);
    assert.match(extracted.text, /local-only/);
    for (const command of checks) {
        assert.ok(extracted.text.includes(`"command":"${command}"`));
        assert.ok(extracted.text.includes(`CHECK_RESULT ${command}`));
    }
    assert.doesNotMatch(
        extracted.text,
        /CATALOG_RESTATEMENT_CANARY|LISTING_RESTATEMENT_CANARY|FINAL_EXTERNAL_CANARY|NEXT_REQUEST_RESTATEMENT_CANARY|NEXT_FINAL_CANARY/,
    );
    assert.equal(
        f.store.records(f.b.scope)[0].usageCount,
        0,
        "listing is not an observed read for citation credit",
    );
});
