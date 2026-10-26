import { spawn } from "node:child_process";
import { open, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2]);
const manifest = JSON.parse(
    await readFile(join(root, "manifest.json"), "utf8"),
);
const mode = process.argv[3];
if (mode && !["recall-recheck", "finish-forgetting"].includes(mode))
    throw new Error("Unknown verification continuation mode");
const suffix =
    mode === "recall-recheck"
        ? "-recall-recheck"
        : mode === "finish-forgetting"
          ? "-forgetting-finish"
          : "";
const runFile = join(
    root,
    mode === "recall-recheck"
        ? "execution-recheck.json"
        : mode === "finish-forgetting"
          ? "execution-finish.json"
          : "execution.json",
);
await writeFile(
    runFile,
    `${JSON.stringify({
        status: "running",
        startedAt: new Date().toISOString(),
        maximumRequests: manifest.maximumRequests,
    })}\n`,
    { flag: "wx", mode: 0o600 },
);
const children = new Set();
for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
        for (const child of children) child.kill(signal);
    });
const outcomes = await Promise.all(
    manifest.models.map(async (model) => {
        const log = await open(
            join(root, `${model.key}${suffix}-live.log`),
            "wx",
            0o600,
        );
        console.log(`Starting ${model.key}: disabled / previous / current`);
        const child = spawn(
            process.execPath,
            [
                fileURLToPath(new URL("./compare.mjs", import.meta.url)),
                root,
                model.key,
                ...(mode ? [mode] : []),
            ],
            { stdio: ["ignore", log.fd, log.fd], env: process.env },
        );
        children.add(child);
        const outcome = await new Promise((resolve) => {
            child.once("error", (error) =>
                resolve({ key: model.key, error: error.message }),
            );
            child.once("exit", (code, signal) =>
                resolve({ key: model.key, code, signal }),
            );
        });
        children.delete(child);
        await log.close();
        console.log(`Finished ${model.key}: ${outcome.code ?? outcome.error}`);
        return outcome;
    }),
);
const database = new DatabaseSync(join(root, "model-budget.sqlite"), {
    readOnly: true,
});
const budget = database.prepare("SELECT used,maximum FROM budget").get();
const byModel = database
    .prepare(
        "SELECT provider,model,count(*) AS calls FROM calls GROUP BY provider,model",
    )
    .all();
database.close();
const reports = [];
for (const model of manifest.models) {
    try {
        const value = JSON.parse(
            await readFile(
                join(root, model.key + suffix, "result.json"),
                "utf8",
            ),
        );
        reports.push({
            key: model.key,
            status: value.status,
            calls: value.calls.length,
            cases: Object.fromEntries(
                Object.entries(value.cases).map(([variant, row]) => [
                    variant,
                    {
                        passed: row.passed,
                        actualExtraction: row.generation?.actualExtraction,
                        correctFacts: Object.values(
                            (row.recall ?? row).audit?.factChecks ?? {},
                        ).filter(Boolean).length,
                        injectedBytes: (row.recall ?? row).injectedBytes,
                        actualReads: (row.recall ?? row).audit?.actualReadCount,
                        actualSearches: (row.recall ?? row).audit
                            ?.actualSearchCount,
                        citationCount: (row.recall ?? row).audit
                            ?.referenceCount,
                        citationsValid:
                            (row.recall ?? row).audit?.referenceCount > 0
                                ? (row.recall ?? row).audit
                                      .hasMatchingSourceIds &&
                                  (row.recall ?? row).audit.invalidReferences
                                      .length === 0
                                : null,
                    },
                ]),
            ),
            mutationPassed: value.mutation.passed,
            errors: value.errors.map((item) => ({
                phase: item.phase,
                message: item.message.slice(0, 600),
            })),
        });
    } catch (error) {
        reports.push({ key: model.key, error: error.message });
    }
}
const result = {
    status: outcomes.every((item) => item.code === 0) ? "passed" : "failed",
    finishedAt: new Date().toISOString(),
    outcomes,
    budget,
    byModel,
    reports,
};
await writeFile(runFile, `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
});
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.status === "passed" ? 0 : 1;
