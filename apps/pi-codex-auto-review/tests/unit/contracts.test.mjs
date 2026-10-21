import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
    createAgentSession,
    createAgentSessionRuntime,
    createBashToolDefinition,
    createEditToolDefinition,
    createFindToolDefinition,
    createGrepToolDefinition,
    createLsToolDefinition,
    createReadToolDefinition,
    createWriteToolDefinition,
    DefaultResourceLoader,
    InteractiveMode,
    ModelRuntime,
    runPrintMode,
    runRpcMode,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
    approvalEligible,
    canonicalJson,
    createAction,
    createProfile,
    decision,
    digest,
    retryIdentity,
    validateWorkerFrame,
} from "../../dist/contracts.js";
import { validateSettings } from "../../dist/policy/index.js";
import {
    validateEvidence,
    validatePlatformEvidence,
} from "../../dist/reports.js";
import { createRun, writeImmutable } from "../support/evidence-store.mjs";
import { fixture } from "../harness/fixtures.mjs";

test("[identity] canonical snapshots bind final input/cwd/source/session/policy/profile independently", async (t) => {
    const f = await fixture(t),
        args = { path: "a", nested: { z: 1, a: 2 } };
    const a = f.action("read", args, { toolCallId: "a" });
    expect(a.digest).toBe(
        f.action(
            "read",
            { nested: { a: 2, z: 1 }, path: "a" },
            { toolCallId: "a" },
        ).digest,
    );
    args.nested.z = 7;
    expect(a.args.nested.z).toBe(1);
    expect(() => {
        a.args.path = "b";
    }).toThrow(TypeError);
    for (const changed of [
        { tool: "write" },
        { args: { path: "b" } },
        { cwd: f.outside },
        { source: "nested" },
        { sessionId: "new" },
        { policyRevision: "new" },
    ]) {
        expect(a.digest).not.toBe(
            f.action(changed.tool ?? "read", changed.args ?? a.args, {
                toolCallId: "a",
                ...changed,
            }).digest,
        );
    }
    expect(() => canonicalJson({ x: NaN })).toThrow();
    expect(() => canonicalJson({ x: undefined })).toThrow();
    expect(() => createAction({ ...a, args: [] }, f.profile)).toThrow();
});
test("[profiles] profiles are immutable and read-only cannot silently gain writes", async (t) => {
    const f = await fixture(t);
    expect(() => f.profile.writeRoots.push(f.outside)).toThrow();
    expect(() => createProfile({ ...f.profile, mode: "read-only" })).toThrow();
    expect(() =>
        createProfile({ ...f.profile, readRoots: ["relative"] }),
    ).toThrow();
    expect(digest(f.profile)).not.toBe(
        digest(
            createProfile({ ...f.profile, mode: "read-only", writeRoots: [] }),
        ),
    );
    expect(() =>
        decision(f.action("read", {}), "allow", "bad", undefined, true),
    ).toThrow();
});
test("[ipc] invalid protocol frames cannot be treated as worker success", () => {
    for (const frame of [
        {},
        { schemaVersion: 1, type: "workload-started", processGroupId: 123 },
        {
            schemaVersion: 1,
            type: "network-request",
            requestId: "forged",
            destination: { host: "example.com" },
        },
        { schemaVersion: 2, type: "result", result: null },
        { schemaVersion: 1, type: "result" },
        { schemaVersion: 1, type: "data", data: 2 },
        { schemaVersion: 1, type: "update", result: {} },
    ])
        expect(() => validateWorkerFrame(frame)).toThrow();
    expect(
        validateWorkerFrame({ schemaVersion: 1, type: "result", result: null })
            .result,
    ).toStrictEqual(null);
});
test("[evidence] incomplete, stale, blocked, skipped, duplicate or simulated-native proof cannot pass", () => {
    const valid = {
        suite: "native",
        status: "pass",
        command: "test",
        testFiles: ["a"],
        coveredBehavior: ["effect"],
        tests: [{ name: "[effect] allowed and denied", status: "pass" }],
        platform: "darwin-arm64",
        sourceDigest: "source",
        contractDigest: "contract",
        runtimeVersions: { node: "24" },
        evidenceKind: "native-os",
        blockedReasons: [],
        nativeControls: [
            {
                kind: "allow",
                effect: "permitted control",
                isObserved: true,
                platform: "darwin-arm64",
            },
            {
                kind: "deny",
                effect: "denied control",
                isObserved: true,
                platform: "darwin-arm64",
            },
        ],
    };
    validateEvidence(valid, ["effect"]);
    for (const changed of [
        { tests: [] },
        { testFiles: [] },
        { coveredBehavior: [] },
        { tests: [{ name: "[effect]", status: "environment-blocked" }] },
        { tests: [{ name: "[effect]", status: "pass", isSkipped: true }] },
        { tests: [valid.tests[0], valid.tests[0]] },
        { blockedReasons: ["blocked"] },
        { evidenceKind: "unit-doubles" },
    ])
        expect(() =>
            validateEvidence({ ...valid, ...changed }, ["effect"]),
        ).toThrow();
    expect(() =>
        validateEvidence(valid, ["effect"], {
            contractDigest: "changed",
            sourceDigest: "source",
        }),
    ).toThrow();
    expect(() =>
        validateEvidence({ ...valid, nativeControls: [] }, ["effect"]),
    ).toThrow(/observed permitted and denied/);
    expect(() =>
        validateEvidence(valid, ["effect"], {
            contractDigest: "contract",
            sourceDigest: "source",
            platform: "linux-x64",
        }),
    ).toThrow(/architecture/);
    expect(() =>
        validateEvidence(valid, ["effect"], {
            contractDigest: "contract",
            sourceDigest: "source",
            requireRun: true,
        }),
    ).toThrow(/executed/);
    expect(() =>
        validateEvidence({ ...valid, provenance: "synthetic" }, ["effect"]),
    ).toThrow(/Synthetic/);
    const current = {
        ...valid,
        schemaVersion: 2,
        runId: "run",
        artifactPath: "runs/run/native.json",
        provenance: "executed",
        startedAt: "2026-10-03T00:00:00Z",
        recordedAt: "2026-10-03T00:00:01Z",
    };
    const platform = { ...current, results: { native: current } };
    const expected = {
        platform: valid.platform,
        sourceDigest: valid.sourceDigest,
        contractDigest: valid.contractDigest,
    };
    validatePlatformEvidence(
        platform,
        { native: { behavior: ["effect"] } },
        expected,
    );
    expect(() =>
        validatePlatformEvidence(
            {
                ...platform,
                results: { native: { ...current, platform: "linux-x64" } },
            },
            { native: { behavior: ["effect"] } },
            expected,
        ),
    ).toThrow();
    expect(() =>
        validatePlatformEvidence(
            {
                ...platform,
                results: { native: { ...current, runId: "other" } },
            },
            { native: { behavior: ["effect"] } },
            expected,
        ),
    ).toThrow();
    validateEvidence(
        {
            ...valid,
            status: "environment-blocked",
            tests: [{ name: "[effect]", status: "environment-blocked" }],
            blockedReasons: ["Unavailable OS"],
        },
        [],
    );
});
test("[evidence] concurrent synthetic platform and same-platform storage preserves immutable bytes", async (t) => {
    const f = await fixture(t);
    const runs = await Promise.all(
        ["darwin-arm64", "linux-x64", "linux-x64", "linux-x64"].map(
            (platform) =>
                createRun({
                    base: join(f.root, "reports"),
                    platform,
                    provenance: "synthetic",
                }),
        ),
    );
    expect(new Set(runs.map((run) => run.directory)).size).toBe(4);
    const bytes = runs.map((run, index) =>
        JSON.stringify({
            runId: run.runId,
            platform: run.platform,
            sourceDigest: `synthetic-${index}`,
            provenance: "synthetic",
        }),
    );
    await Promise.all(
        runs.map((run, index) =>
            writeImmutable(join(run.directory, "proof.json"), bytes[index]),
        ),
    );
    await expect(
        writeImmutable(join(runs[0].directory, "proof.json"), "replacement"),
    ).rejects.toThrow(expect.objectContaining({ code: "EEXIST" }));
    expect(
        await Promise.all(
            runs.map((run) =>
                readFile(join(run.directory, "proof.json"), "utf8"),
            ),
        ),
    ).toStrictEqual(bytes);
});
test("[public-api] supported installed Pi exposes complete tool contracts and protected startup seams", () => {
    for (const [name, value] of Object.entries({
        createAgentSession,
        createAgentSessionRuntime,
        DefaultResourceLoader,
        SessionManager,
        SettingsManager,
        ModelRuntime,
        InteractiveMode,
        runPrintMode,
        runRpcMode,
        createBashToolDefinition,
        createReadToolDefinition,
        createEditToolDefinition,
        createWriteToolDefinition,
        createGrepToolDefinition,
        createFindToolDefinition,
        createLsToolDefinition,
    }))
        expect(typeof value, name).toBe("function");
    const tool = createBashToolDefinition(process.cwd());
    expect(tool.name).toBe("bash");
    expect(tool.outputSchema).toBeTruthy();
    expect(typeof tool.execute).toBe("function");
});
test("[identity] retry semantics survive a new invocation but bind session, policy and context", async (t) => {
    const f = await fixture(t),
        original = f.action("write", { path: "a", content: "b" });
    expect(retryIdentity(original, "context")).toBe(
        retryIdentity(
            f.action("write", { path: "a", content: "b" }),
            "context",
        ),
    );
    for (const action of [
        f.action("write", { path: "a", content: "changed" }),
        f.action("write", original.args, { sessionId: "other" }),
        f.action("write", original.args, { policyRevision: "changed" }),
    ])
        expect(retryIdentity(original, "context")).not.toBe(
            retryIdentity(action, "context"),
        );
    expect(retryIdentity(original, "context")).not.toBe(
        retryIdentity(original, "changed"),
    );
});
test("[profiles] old settings adapt while new routing and model settings reject malformed values", () => {
    const legacy = validateSettings({
        mode: "read-only",
        commandRules: [{ prefix: ["git", "status"], decision: "allow" }],
        reviewTimeoutMs: 5000,
    });
    expect(legacy.approvalPolicy).toBe("on-request");
    expect(legacy.approvalsReviewer).toBe("auto_review");
    expect(legacy.reviewTimeoutMs).toBe(5000);
    expect(approvalEligible("never", "sandbox")).toBe(false);
    expect(approvalEligible({ sandbox: false, rules: true }, "rules")).toBe(
        true,
    );
    expect(approvalEligible({ sandbox: false, rules: true }, "sandbox")).toBe(
        false,
    );
    expect(
        validateSettings({
            reviewModel: { provider: "ollama-cloud", id: "operator-choice" },
        }).reviewModel,
    ).toStrictEqual({ provider: "ollama-cloud", id: "operator-choice" });
    for (const value of [
        { approvalPolicy: { sandbox: true } },
        { approvalsReviewer: "unknown" },
        { reviewModel: { provider: "p", id: "" } },
        { reviewPolicy: "" },
        { reviewMaxRounds: 0 },
        { reviewContextChars: Infinity },
        { ruleFiles: [4] },
        { excludeTmpdir: "false" },
    ])
        expect(() => validateSettings(value)).toThrow();
});
