import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_SETTINGS } from "../dist/config.js";
import { parseExtraction } from "../dist/pipeline.js";
import { MemoryReader } from "../dist/retrieval.js";
import { workspaceScope } from "../dist/safety.js";
import { readSource } from "../dist/sources.js";
import { MemoryStore } from "../dist/store.js";

// Offline replay of the operator-approved snapshot and already recorded model output.
// Never opens authentication or calls a provider. Outputs stay outside the package.
const input = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
await mkdir(output, { recursive: true, mode: 0o700 });
const reference = JSON.parse(
    await readFile(join(input, "source.json"), "utf8"),
);
const source = await readSource(
    reference.file,
    DEFAULT_SETTINGS.maxInputBytes - 8192,
    new AbortController().signal,
    false,
);
if (!source)
    throw new Error("Approved source snapshot could not be projected.");
const expected = [
    "f3a9ce5d",
    "fac33e99",
    "a5270b51",
    "2c84e63c",
    "1d418acf",
    "2fdc986c",
    "25b941e2",
    "e4d88ded",
];
const presence = Object.fromEntries(
    expected.map((id) => [id, source.text.includes(`[entry=${id};`)]),
);
const result = {
    modelCalls: 0,
    sourceBytes: Buffer.byteLength(source.text),
    encodedSourceBytes: Buffer.byteLength(JSON.stringify(source.text)) - 2,
    expectedEntries: presence,
    missingEntries: expected.filter((id) => !presence[id]),
};
for (const key of ["sol", "luna"]) {
    const store = new MemoryStore(join(output, key));
    try {
        const scope = workspaceScope(output);
        const extraction = parseExtraction(
            await readFile(join(input, key, "extraction-output.txt"), "utf8"),
        );
        const lease = store.claim(
            scope,
            key,
            source.fingerprint,
            Date.now(),
            DEFAULT_SETTINGS,
            true,
        );
        if (
            !lease ||
            !store.completeExtraction(
                lease,
                source,
                extraction.rollout_summary,
                extraction.rollout_slug,
                Date.now(),
            )
        )
            throw new Error("Replay storage failed.");
        const record = store.records(scope)[0];
        result[key] = {
            originalBytes: Buffer.byteLength(extraction.rollout_summary),
            storedBytes: Buffer.byteLength(record.body),
            latestSelectionOriginallyPresent: /The user selected:/i.test(
                extraction.rollout_summary,
            ),
            latestSelectionStored: /The user selected:/i.test(record.body),
            sourceId: record.source.id,
            path: record.path,
        };
        if (key === "luna") {
            const reader = new MemoryReader(store, scope);
            reader.read({
                path: record.path,
                max_bytes: 16384,
                max_lines: 1000,
            });
            const answer = await readFile(
                join(input, key, "recall-answer.md"),
                "utf8",
            );
            reader.recordCitations(answer);
            result[key].wrongIdAcceptedAsUsage =
                store.records(scope)[0].usageCount > 0;
            result[key].citationEvidence = reader.evidence?.() ?? null;
        }
    } finally {
        store.close();
    }
}
await writeFile(
    join(output, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    { mode: 0o600 },
);
console.log(JSON.stringify(result, null, 2));
