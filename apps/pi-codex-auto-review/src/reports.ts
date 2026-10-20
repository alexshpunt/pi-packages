import { GuardError, type TestEvidence } from "./contracts.js";

export function validateEvidence(
    evidence: TestEvidence,
    requiredBehavior: readonly string[],
    expected?: {
        contractDigest: string;
        sourceDigest: string;
        platform?: string;
        requireRun?: boolean;
    },
): void {
    if (
        !evidence ||
        !["pass", "fail", "environment-blocked", "not-run"].includes(
            evidence.status,
        )
    )
        throw new GuardError("INVALID_EVIDENCE", "Unknown evidence status");
    if (
        !evidence.testFiles?.length ||
        new Set(evidence.testFiles).size !== evidence.testFiles.length ||
        !evidence.tests?.length
    )
        throw new GuardError(
            "MISSING_EVIDENCE",
            "Missing or duplicate test files / empty suite",
        );
    if (
        new Set(evidence.tests.map((t) => t.name)).size !==
        evidence.tests.length
    )
        throw new GuardError("DUPLICATE_EVIDENCE", "Duplicate test names");
    if (
        !evidence.contractDigest ||
        !evidence.sourceDigest ||
        !evidence.platform ||
        !evidence.runtimeVersions ||
        !Object.keys(evidence.runtimeVersions).length
    )
        throw new GuardError("STALE_EVIDENCE", "Missing evidence versions");
    if (
        expected &&
        (expected.contractDigest !== evidence.contractDigest ||
            expected.sourceDigest !== evidence.sourceDigest)
    )
        throw new GuardError(
            "STALE_EVIDENCE",
            "Evidence does not match current source",
        );
    if (expected?.platform && evidence.platform !== expected.platform)
        throw new GuardError(
            "WRONG_PLATFORM",
            "Evidence does not match the required platform and architecture",
        );
    if (
        expected?.requireRun &&
        (evidence.schemaVersion !== 2 ||
            !evidence.runId ||
            !evidence.artifactPath ||
            !evidence.startedAt ||
            !evidence.recordedAt ||
            evidence.provenance !== "executed")
    )
        throw new GuardError(
            "MISSING_PROVENANCE",
            "Qualification requires an executed, addressable run",
        );
    if (
        evidence.provenance === "synthetic" &&
        evidence.evidenceKind === "native-os"
    )
        throw new GuardError(
            "FALSE_NATIVE",
            "Synthetic storage fixtures cannot qualify native execution",
        );
    if (evidence.status === "pass") {
        if (
            evidence.blockedReasons.length ||
            evidence.tests.some((t) => t.status !== "pass" || t.isSkipped)
        )
            throw new GuardError(
                "FALSE_PASS",
                "Skipped, blocked or failed tests cannot pass",
            );
        for (const requirement of requiredBehavior) {
            if (
                !evidence.coveredBehavior.includes(requirement) ||
                !evidence.tests.some(
                    (t) =>
                        t.name.includes(`[${requirement}]`) &&
                        t.status === "pass",
                )
            )
                throw new GuardError(
                    "MISSING_COVERAGE",
                    `Missing executed proof for ${requirement}`,
                );
        }
        if (
            evidence.suite === "native" &&
            evidence.evidenceKind !== "native-os"
        )
            throw new GuardError(
                "FALSE_NATIVE",
                "Native evidence requires OS controls",
            );
        if (
            evidence.suite === "native" &&
            (!evidence.nativeControls?.some(
                (control) =>
                    control.kind === "allow" &&
                    control.isObserved &&
                    control.platform === evidence.platform,
            ) ||
                !evidence.nativeControls.some(
                    (control) =>
                        control.kind === "deny" &&
                        control.isObserved &&
                        control.platform === evidence.platform,
                ))
        )
            throw new GuardError(
                "FALSE_NATIVE",
                "Native evidence requires observed permitted and denied controls",
            );
    }
}

export function validatePlatformEvidence(
    record: {
        platform: string;
        status: string;
        sourceDigest: string;
        contractDigest: string;
        runId?: string;
        results: Record<string, TestEvidence>;
    },
    requirements: Record<string, { behavior: readonly string[] }>,
    expected: {
        platform: string;
        sourceDigest: string;
        contractDigest: string;
    },
): void {
    if (
        record?.status !== "pass" ||
        !record.runId ||
        record.platform !== expected.platform ||
        record.sourceDigest !== expected.sourceDigest ||
        record.contractDigest !== expected.contractDigest
    )
        throw new GuardError(
            "STALE_PLATFORM",
            "Missing matching platform qualification",
        );
    for (const [name, suite] of Object.entries(requirements)) {
        const result = record.results?.[name];
        validateEvidence(result, suite.behavior, {
            ...expected,
            requireRun: true,
        });
        if (
            result.suite !== name ||
            result.runId !== record.runId ||
            result.status !== "pass"
        )
            throw new GuardError(
                "INCOMPLETE_PLATFORM",
                "Platform suites must pass in the recorded run",
            );
    }
}
