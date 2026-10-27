// Read-only configuration/dependency check. Does not call release-it's release API.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
    configProblems,
    dryRunOptions,
    findTarget,
    isPublishedOnNpm,
    listTargets,
    loadTargetOptions,
    registryWorkspaceDependencies,
    requireConfiguredTargets,
} from "../../../scripts/release/shared.mjs";

const output = resolve(process.argv[2]),
    initialCwd = process.cwd(),
    targets = listTargets(),
    checks = [];
requireConfiguredTargets(targets);
try {
    for (const name of ["@buyong/pi-codex-memory", "@buyong/pi-codex"]) {
        const target = findTarget(targets, name);
        assert.ok(target);
        process.chdir(target.directory);
        const problems = configProblems(
            await loadTargetOptions(dryRunOptions),
            target,
        );
        assert.deepEqual(problems, []);
        execFileSync(
            process.execPath,
            ["../../scripts/release/changelog.mjs", "check"],
            { stdio: "pipe" },
        );
        const dependencies = registryWorkspaceDependencies(target, targets).map(
            (dependency) => ({
                ...dependency,
                published:
                    isPublishedOnNpm(dependency.name, dependency.version) ??
                    null,
            }),
        );
        checks.push({ name, config: "pass", changelogs: "pass", dependencies });
        assert.ok(
            dependencies.every((dependency) => dependency.published === true),
            "Runtime dependencies must already exist on npm.",
        );
    }
    await writeFile(
        output,
        `${JSON.stringify(
            { status: "pass", checks, releaseExecuted: false },
            null,
            2,
        )}\n`,
    );
    console.log(
        JSON.stringify({ status: "pass", checks, releaseExecuted: false }),
    );
} finally {
    process.chdir(initialCwd);
}
