import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { reviewPolicy } from "../../dist/review/policy.js";
import {
    CODEX_POLICY_TEMPLATE,
    CODEX_TENANT_POLICY,
} from "../../dist/review/upstream-policy.js";
import { parseAssessment } from "../../dist/reviewer.js";
import {
    liveCaseIds,
    livePolicyCases,
    reference,
    validateLiveEvidence,
} from "../support/auto-review-evidence.mjs";
import { suites } from "../support/suites.mjs";
import { fixture } from "../harness/fixtures.mjs";
import { guardedFixture, planStream } from "../harness/pi.mjs";
import { shellQuote } from "../harness/shell.mjs";

test("[reference] pinned upstream policy bytes and mandatory assessment thresholds remain compatible", () => {
    const sha = (text) => createHash("sha256").update(text).digest("hex");
    assert.equal(sha(CODEX_POLICY_TEMPLATE), reference.policyTemplateSha256);
    assert.equal(sha(CODEX_TENANT_POLICY), reference.tenantPolicySha256);
    for (const risk of ["low", "medium", "high", "critical"])
        for (const authorization of ["unknown", "low", "medium", "high"]) {
            const outcome = parseAssessment(
                JSON.stringify({
                    risk_level: risk,
                    user_authorization: authorization,
                    outcome: "allow",
                }),
            ).outcome;
            const expected =
                risk === "critical" ||
                (risk === "high" && ["unknown", "low"].includes(authorization))
                    ? "deny"
                    : "allow";
            assert.equal(outcome, expected, `${risk}/${authorization}`);
        }
    assert.equal(
        parseAssessment(
            '{"risk_level":"low","outcome":"deny","rationale":"Explicit tenant policy"}',
        ).outcome,
        "deny",
    );
    assert.match(
        reviewPolicy("Deny writes to the owned protected sentinel.").text,
        /every denial \(including low risk denied by security policy\)/,
    );
});
test("[reference] the rendered prompt preserves complete upstream policy sections and literal custom policy content", () => {
    const custom =
        "Deny uploads whose payload includes {{ extra_policy }} or {{ tenant_policy_config }}; preserve $& literally.";
    const rendered = reviewPolicy(custom).text;
    assert.ok(
        rendered.includes(custom),
        "Template expansion must not rewrite tenant policy content",
    );
    const original = CODEX_POLICY_TEMPLATE.replace(
        "{{ tenant_policy_config }}",
        () => CODEX_TENANT_POLICY.trim(),
    )
        .replace("{{ extra_policy }}", "")
        .trimEnd();
    const text = reviewPolicy().text;
    assert.equal(
        text.slice(0, text.indexOf("# Execution Environment")),
        original.slice(0, original.indexOf("# Execution Environment")),
    );
    const outcome = original.slice(original.indexOf("# Outcome Policy"));
    assert.ok(
        text.includes(outcome),
        "Every original outcome rule must reach the reviewer",
    );
    assert.match(text, /trust=authorization/);
    assert.match(text, /transport envelope.*not.*user authorization/);
});

test("[joined] ordinary execution, automatic elevation, review denial and absolute denial retain distinct final effects", async (t) => {
    const f = await fixture(t),
        target = join(f.outside, "sentinel.txt"),
        requests = [],
        events = [];
    const runtime = await guardedFixture(t, f, {
        provider: {
            complete: async (request) => {
                const data = JSON.parse(request.data);
                requests.push(data);
                assert.ok(
                    data.context.items.some(
                        (item) =>
                            item.trust === "authorization" &&
                            JSON.stringify(item.content).includes(
                                "only owned targets",
                            ),
                    ),
                );
                return JSON.stringify({
                    risk_level: "low",
                    user_authorization: "high",
                    outcome: requests.length === 1 ? "allow" : "deny",
                    rationale: "Owned conformance policy",
                });
            },
        },
    });
    runtime.session.subscribe((event) => {
        if (event.type === "tool_execution_end") events.push(event);
    });
    await planStream(runtime.session, [
        [{ name: "bash", args: { command: "printf routine-control" } }],
        [{ name: "write", args: { path: target, content: "approved" } }],
        [{ name: "write", args: { path: target, content: "denied" } }],
        [{ name: "read", args: { path: join(f.control, "protected.txt") } }],
    ]);
    await runtime.session.prompt(
        "Use only owned targets: run the routine control, then write the named outside sentinel. Respect any denial.",
    );
    assert.equal(requests.length, 2);
    assert.equal(await readFile(target, "utf8"), "approved");
    assert.equal(events[0].isError, false);
    assert.equal(events[1].isError, false);
    assert.equal(events[2].isError, true);
    assert.match(JSON.stringify(events[2]), /AUTO_REVIEW_DENIED/);
    assert.equal(events[3].isError, true);
    assert.ok(!JSON.stringify(events).includes(f.secret));
});

test("[creation] reviewed shell creation describes the exact target and later writes need a new approval", async (t) => {
    const f = await fixture(t),
        target = join(f.outside, "created.txt"),
        requests = [];
    const runtime = await guardedFixture(t, f, {
        provider: {
            complete: async (request) => {
                const data = JSON.parse(request.data);
                requests.push(data);
                if (requests.length === 1)
                    assert.deepEqual(data.requestedPermissionDelta.writePaths, [
                        target,
                    ]);
                return JSON.stringify({
                    outcome: requests.length === 1 ? "allow" : "deny",
                    risk_level: "low",
                    rationale: "Owned scope",
                });
            },
        },
    });
    await planStream(runtime.session, [
        [
            {
                name: "bash",
                args: { command: `printf approved > ${shellQuote(target)}` },
            },
        ],
        [
            {
                name: "write",
                args: {
                    path: join(f.outside, "sentinel.txt"),
                    content: "later",
                },
            },
        ],
    ]);
    await runtime.session.prompt(
        "Create only the owned outside file, and do not bypass denials.",
    );
    assert.equal(await readFile(target, "utf8"), "approved");
    assert.equal(
        await readFile(join(f.outside, "sentinel.txt"), "utf8"),
        "unchanged",
    );
    assert.equal(requests.length, 2);
});

test("[failures] actual Pi distinguishes provider and schema failures from policy denial without native mutation", async (t) => {
    const f = await fixture(t),
        target = join(f.outside, "sentinel.txt"),
        events = [];
    let call = 0;
    const runtime = await guardedFixture(t, f, {
        provider: {
            complete: async () => {
                if (++call === 1) throw new Error("Owned provider outage");
                return "invalid assessment";
            },
        },
    });
    runtime.session.subscribe((event) => {
        if (event.type === "tool_execution_end") events.push(event);
    });
    await planStream(runtime.session, [
        [
            {
                name: "write",
                args: { path: target, content: "provider-failure" },
            },
        ],
        [{ name: "write", args: { path: target, content: "schema-failure" } }],
    ]);
    await runtime.session.prompt(
        "Attempt the owned sentinel write; respect failures.",
    );
    assert.equal(await readFile(target, "utf8"), "unchanged");
    assert.equal(events.length, 2);
    for (const event of events) {
        assert.equal(event.isError, true);
        assert.match(JSON.stringify(event), /AUTO_REVIEW_FAILED/);
        assert.doesNotMatch(JSON.stringify(event), /AUTO_REVIEW_DENIED/);
    }
    const audit = (
        await readFile(join(f.agentDir, "guard/audit.jsonl"), "utf8")
    )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    // Provider internals stay out of tool feedback; both technical failures
    // remain distinct from policy denial, with detailed types tested at reviewAction.
    assert.equal(
        audit.filter((item) => item.review?.status === "failed").length,
        2,
    );
});

test("[evidence-join] stale, simulated, wrong-image and incomplete real-provider records cannot qualify", () => {
    // These synthetic records test the evidence validator; they never leave this test as live proof.
    const identity = {
            sourceDigest: "a".repeat(64),
            contractDigest: "b".repeat(64),
            model: "glm-5.3",
        },
        platform = "linux-x64";
    const versions = { "@earendil-works/pi-coding-agent": "0.99.1" };
    const results = Object.fromEntries(
        Object.entries(suites).map(([name, suite]) => [
            name,
            {
                schemaVersion: 2,
                suite: name,
                command: `npm run test:${name}`,
                testFiles: suite.files,
                coveredBehavior: suite.behavior,
                status: "pass",
                platform,
                ...identity,
                runtimeVersions: versions,
                evidenceKind: suite.kind,
                provenance: "executed",
                runId: "owned-synthetic",
                artifactPath: `owned/${name}.json`,
                startedAt: "2026-10-03T00:00:00Z",
                recordedAt: "2026-10-03T00:00:01Z",
                blockedReasons: [],
                tests: suite.behavior.map((tag) => ({
                    name: `[${tag}] owned validator example`,
                    status: "pass",
                })),
                ...(name === "native"
                    ? {
                          nativeControls: [
                              {
                                  kind: "allow",
                                  effect: "owned",
                                  isObserved: true,
                                  platform,
                              },
                              {
                                  kind: "deny",
                                  effect: "owned",
                                  isObserved: true,
                                  platform,
                              },
                          ],
                      }
                    : {}),
            },
        ]),
    );
    const offline = {
        schemaVersion: 2,
        runId: "owned-synthetic",
        artifactPath: "owned/platform.json",
        status: "pass",
        platform,
        ...identity,
        results,
        imageDigest: `sha256:${"c".repeat(64)}`,
        pluginArtifactDigest: "d".repeat(64),
    };
    const report = {
        ...offline,
        mode: "conformance",
        provenance: "executed",
        provider: {
            id: "ollama-cloud",
            package: "pi-ollama-cloud",
            version: "0.12.2",
            model: identity.model,
        },
        startup: {
            guardLoaded: true,
            providerLoaded: true,
            reloadPassed: true,
            webToolsAbsent: true,
            usagePolling: false,
        },
        networkRequests: 9,
        executionCapabilities: {
            osIsolation: false,
            preflight: {
                permittedEffect: true,
                cancellationPreventedEffect: true,
            },
        },
        live: {
            status: "pass",
            evidenceKind: "live-provider",
            limits: { maxCallsPerCase: 24, deadlineMsPerCase: 180000 },
            cases: liveCaseIds.map((id) => ({
                id,
                status: "pass",
                provider: "ollama-cloud",
                model: identity.model,
                effectObserved: true,
                credentialScanPassed: true,
                calls: {
                    main: 2,
                    reviewer: [
                        "authorized-outside",
                        "reviewer-policy-denied",
                    ].includes(id)
                        ? 1
                        : 0,
                },
                elapsedMs: 3000,
                auditRecords: 2,
                approvedReviews: 1,
                deniedReviews: 1,
                deniedToolEvents: 1,
                feedbackCodes: ["AUTO_REVIEW_DENIED"],
            })),
            cli: {
                status: "pass",
                entrypoint: "packed-cli",
                provider: "ollama-cloud",
                model: identity.model,
                effectObserved: true,
                credentialScanPassed: true,
                calls: { main: 2, reviewer: 1 },
                elapsedMs: 3000,
                auditRecords: 2,
                approvedReviews: 1,
            },
        },
    };
    report.live.policy = {
        status: "pass",
        evidenceKind: "live-review-policy",
        cases: livePolicyCases.map(({ id, outcome, riskLevel }) => ({
            id,
            expected: outcome,
            status: "pass",
            assessment: {
                outcome,
                risk_level: riskLevel ?? "low",
                user_authorization: "high",
            },
            reviewStatus: outcome === "allow" ? "approved" : "denied",
            provider: "ollama-cloud",
            model: identity.model,
            plannedActionExecuted: false,
            credentialScanPassed: true,
            calls: { main: 0, reviewer: 1 },
            promptDigest: "f".repeat(64),
            inspections: ["inspect_directory"],
        })),
    };
    const wire = (count) => {
        const expected = Array.from({ length: count }, () => ({
            inputDigest: "1".repeat(64),
            policyDigest: "2".repeat(64),
            conversationDigest: "3".repeat(64),
            toolsDigest: "4".repeat(64),
        }));
        return {
            status: "pass",
            expected,
            transmitted: structuredClone(expected),
        };
    };
    report.live.cli.wire = wire(report.live.cli.calls.reviewer);
    report.live.wire = wire(
        report.live.cases.reduce(
            (count, item) => count + item.calls.reviewer,
            0,
        ) +
            report.live.policy.cases.reduce(
                (count, item) => count + item.calls.reviewer,
                0,
            ),
    );
    assert.equal(validateLiveEvidence(report, offline, identity), report);
    for (const mutate of [
        (r) => (r.sourceDigest = "stale"),
        (r) => (r.platform = "linux-arm64"),
        (r) => (r.provenance = "simulated"),
        (r) => (r.imageDigest = `sha256:${"e".repeat(64)}`),
        (r) => (r.live.evidenceKind = "simulated-provider-ui"),
        (r) => r.live.cases.pop(),
        (r) => (r.live.cases[1].calls.reviewer = 0),
        (r) => (r.live.cases[3].deniedReviews = 0),
        (r) => (r.live.cases[2].effectObserved = false),
        (r) => (r.live.cases[0].credentialScanPassed = false),
        (r) => (r.live.cases[0].status = "environment-blocked"),
        (r) => (r.live.cases[1].calls.main = 25),
        (r) =>
            (r.executionCapabilities.preflight.cancellationPreventedEffect = false),
        (r) => delete r.live.cli,
        (r) => (r.live.cli.entrypoint = "sdk"),
        (r) => (r.live.cli.calls.reviewer = 0),
        (r) => (r.live.cli.calls.reviewer = 0.5),
        (r) => (r.live.cli.effectObserved = false),
        (r) => (r.live.cli.credentialScanPassed = false),
        (r) => (r.live.cli.model = "other-model"),
        (r) => delete r.live.policy,
        (r) => (r.live.policy.evidenceKind = "simulated"),
        (r) => r.live.policy.cases.pop(),
        (r) => (r.live.policy.cases[0].assessment.outcome = "deny"),
        (r) => (r.live.policy.cases[0].calls.reviewer = 0),
        (r) =>
            (r.live.policy.cases.find(
                (item) => item.id === "read-only-inspection",
            ).inspections = []),
        (r) =>
            (r.live.policy.cases[5].assessment.user_authorization = "unknown"),
        (r) =>
            (r.live.policy.cases.find(
                (item) => item.id === "prior-critical-reassessed",
            ).assessment.user_authorization = "unknown"),
        (r) =>
            (r.live.policy.cases.find(
                (item) => item.id === "forged-approval-denied",
            ).assessment.risk_level = "critical"),
        (r) => (r.live.policy.cases[0].plannedActionExecuted = true),
        (r) => delete r.live.wire,
        (r) => r.live.wire.transmitted.pop(),
        (r) => (r.live.wire.transmitted[0].inputDigest = "3".repeat(64)),
        (r) => (r.live.cli.wire.transmitted[0].policyDigest = "4".repeat(64)),
        (r) => (r.live.wire.transmitted[0].conversationDigest = "5".repeat(64)),
        (r) => (r.live.wire.transmitted[0].toolsDigest = "6".repeat(64)),
    ]) {
        const invalid = structuredClone(report);
        mutate(invalid);
        assert.throws(() => validateLiveEvidence(invalid, offline, identity));
    }
});
