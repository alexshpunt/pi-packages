import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { currentSource } from "../../dist/sources.js";
import { MODELS, QUERY, sha256 } from "../compaction/fixtures.mjs";
import { loadPackage } from "./load-package.mjs";

const root = resolve(process.argv[2]), repository = resolve(process.argv[3] ?? process.cwd());
const evidence = join(repository, ".reports/codex-memory"), oldRoot = join(evidence, "compaction-verification");
const original = JSON.parse(await readFile(join(oldRoot, "manifest.json"), "utf8"));
const packageRoot = join(repository, "apps/pi-codex-memory");
const previousPackage = join(evidence, "completion/distribution/production-memory/node_modules/@buyong/pi-codex-memory");
const currentPackage = join(root, "production-memory/node_modules/@buyong/pi-codex-memory");
const bundlePackage = join(root, "production-bundle/node_modules/@buyong/pi-codex/node_modules/@buyong/pi-codex-memory");
const previous = await loadPackage(previousPackage);
const unknownIdentifierHash = "e9eaf217d38fbc031bc72db4d0fdcb937db89849dfdbac3bdd55fbba97215faf";
const save = (name, value) => writeFile(join(root, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
const manifest = { version: 1, startedAt: new Date().toISOString(), maximumRequests: 48, node: process.version,
    models: MODELS, providerPaths: original.providerPaths, query: QUERY, previousPackage, currentPackage, bundlePackage,
    previousVersion: "0.1.0", currentVersion: "0.1.0", cases: {}, archives: {}, runtimeFiles: {} };
for (const name of ["previous-memory-0.1.0.tgz", "previous-bundle-0.4.1.tgz", "buyong-pi-codex-memory-0.1.0.tgz", "buyong-pi-codex-0.4.1.tgz"])
    manifest.archives[name] = sha256(await readFile(join(root, name)));
assert.equal(manifest.archives["previous-memory-0.1.0.tgz"], "45dfac955a88700e0b51ccb9027ea1025cef5679173fd405c33ce1af056794c2");
assert.equal(manifest.archives["previous-bundle-0.4.1.tgz"], "c5e4146b0abce62c28a57988d88360ea91835532bcd250285d09bd298987a0be");
async function publishedFiles(directory, prefix = "") {
    const paths = [];
    for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "package.json") continue;
        const path = join(prefix, entry.name);
        if (entry.isDirectory()) paths.push(...await publishedFiles(directory, path));
        else if (entry.isFile()) paths.push(path);
    }
    return paths.sort();
}
for (const path of await publishedFiles(currentPackage)) {
    const [source, installed, bundled] = await Promise.all([packageRoot, currentPackage, bundlePackage].map(base => readFile(join(base, path))));
    assert.equal(sha256(installed), sha256(source), `installed/source mismatch: ${path}`);
    assert.equal(sha256(bundled), sha256(source), `bundle/source mismatch: ${path}`);
    manifest.runtimeFiles[path] = sha256(installed);
}
assert.notEqual(sha256(await readFile(join(previousPackage, "dist/sources.js"))), manifest.runtimeFiles["dist/sources.js"]);

const offline = [];
for (const model of MODELS) for (const length of ["short", "medium", "long"]) {
    const name = `${model.key}-${length}`;
    const prior = JSON.parse(await readFile(join(oldRoot, name, "result.json"), "utf8"));
    const fixture = JSON.parse(await readFile(join(oldRoot, `${length}-fixture.json`), "utf8"));
    let source = await readFile(prior.sourceSessionFile, "utf8"), removedIdentifiers = 0;
    const originalSHA256 = sha256(source);
    // Only the known unexplained identifier is removed from the verification copy.
    // Preserve originals and use the same sanitized history in both version arms.
    source = source.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, value => {
        if (sha256(value) !== unknownIdentifierHash) return value;
        removedIdentifiers++; return "[unsupported-compaction-identifier-omitted]";
    });
    const directory = join(root, "inputs", name); await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, "source.jsonl"); await writeFile(file, source, { mode: 0o600, flag: "wx" });
    const manager = SessionManager.open(file, directory), leaf = manager.getLeafId();
    const entries = manager.getBranch(), compaction = entries.find(entry => entry.type === "compaction");
    assert.ok(compaction, `${name}: no saved real compaction`);
    const textOf = content => typeof content === "string" ? content : (content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
    const originalUserIds = entries.filter(entry => entry.type === "message" && entry.message.role === "user" &&
        textOf(entry.message.content).startsWith("검증 대화 ")).map(entry => entry.id);
    assert.equal(originalUserIds.length, fixture.turns, `${name}: original fixture population`);
    const inspect = (snapshot, bytes) => {
        try {
            const value = snapshot(manager, bytes - 8192);
            return { fingerprint: value?.fingerprint, bytes: Buffer.byteLength(value?.text ?? ""),
                originalHumanCount: originalUserIds.filter(id => value?.text.includes(`[entry=${id}; human user]`)).length,
                opaqueFactsPresent: ["service", "region", "verify_command", "release_gate"].every(key => value?.text.includes(fixture.expected[key])),
                containsUnknownIdentifier: [...(value?.text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [])].some(match => sha256(match[0]) === unknownIdentifierHash) };
        } catch (error) { return { failure: error.code ?? error.message }; }
    };
    manager.branch(compaction.parentId);
    const before = inspect(currentSource, 256 * 1024);
    manager.branch(compaction.id);
    const after = inspect(currentSource, 256 * 1024), previousAfter = inspect(previous.currentSource, 256 * 1024);
    manager.branch(leaf);
    const full = inspect(currentSource, 512 * 1024);
    const row = { name, originalSHA256, sanitizedSHA256: sha256(source), removedIdentifiers, turns: fixture.turns,
        currentBefore: before, currentAfter: after, previousAfter, currentFull512KiB: full };
    if (length !== "long") {
        assert.equal(before.fingerprint, after.fingerprint, `${name}: compaction-only fingerprint`);
        assert.equal(after.originalHumanCount, fixture.turns, `${name}: original human evidence`);
        assert.ok(after.opaqueFactsPresent);
    } else { assert.equal(before.failure, "input_budget"); assert.equal(after.failure, "input_budget"); }
    assert.equal(full.originalHumanCount, fixture.turns);
    assert.ok(full.opaqueFactsPresent); assert.equal(full.containsUnknownIdentifier, false);
    offline.push(row);
    if (length === "medium") assert.ok(!/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(source), `${name}: unexpected identifier in live input copy`);
    if (length === "medium") manifest.cases[model.key] = { cwd: original.workspaces[name], source: file,
        expected: fixture.expected, obsoleteGate: fixture.obsoleteGate, sourceSessionId: manager.getSessionId(),
        originalSHA256, sanitizedSHA256: sha256(source), removedIdentifiers };
}
await save("offline-replay.json", offline);
const database = new DatabaseSync(join(root, "model-budget.sqlite"));
database.exec("CREATE TABLE budget(id INTEGER PRIMARY KEY CHECK(id=1),used INTEGER NOT NULL,maximum INTEGER NOT NULL); CREATE TABLE calls(id INTEGER PRIMARY KEY,provider TEXT,model TEXT,started_ms INTEGER);");
database.prepare("INSERT INTO budget VALUES(1,0,48)").run(); database.close();
await save("manifest.json", manifest);
console.log(JSON.stringify({ offlineCases: offline.map(row => ({ name: row.name, originalHumanCount: row.currentFull512KiB.originalHumanCount,
    defaultFailure: row.currentAfter.failure ?? null, removedIdentifiers: row.removedIdentifiers })),
    matchingInstalledFiles: Object.keys(manifest.runtimeFiles).length, maximumRequests: manifest.maximumRequests }, null, 2));
