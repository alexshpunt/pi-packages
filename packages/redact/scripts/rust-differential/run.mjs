// Differential check of @buyong/redact against the Rust redaction module it was ported
// from (buyong-mcp apps/codemap-search/src/redact). Run it after syncing from the source:
//
//   npm run build
//   npm run verify:rust-differential --workspace @buyong/redact -- --source <buyong-mcp checkout>
//
// Options: --scale <n> multiplies the generated mutations (default 1), --seed <n> changes
// them, --keep leaves the work directory in place. Requires cargo.
//
// It builds rust/ with the source's rules.rs and text.rs, runs both engines over the same
// generated inputs, and fails when
//   1. any built-in rule, PEM, assignment, or PII regex result differs from Rust,
//   2. the naive control (Rust syntax given to RegExp unchanged) finds no difference,
//      which would mean the inputs no longer reach the semantics that differ, or
//   3. a PII pattern never matches or a built-in rule id never detects anything.
// The inputs avoid characters assigned after Unicode 16.0, the version of the source's
// regex tables; the runtime classifies those by its own Unicode version (README).
import { execFileSync } from "node:child_process";
import {
    copyFileSync,
    cpSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
    compareCoreResults,
    comparePiiResults,
    measureCoverage,
} from "./compare.mjs";
import {
    generateInputLines,
    generatePatternLines,
} from "./generate-inputs.mjs";
import {
    loadEngine,
    writeCoreResults,
    writePiiResults,
} from "./javascript-side.mjs";

const PINNED_CRATES = [
    "regex",
    "regex-automata",
    "regex-syntax",
    "aho-corasick",
    "memchr",
];
const COPIED_SOURCE_FILES = ["rules.rs", "text.rs"];
const crateTemplate = fileURLToPath(new URL("./rust/", import.meta.url));

const { values: options } = parseArgs({
    options: {
        source: { type: "string" },
        scale: { type: "string", default: "1" },
        seed: { type: "string", default: "2654435769" },
        keep: { type: "boolean", default: false },
    },
});
if (!options.source) {
    console.error(
        "Usage: run.mjs --source <buyong-mcp checkout> [--scale n] [--seed n] [--keep]",
    );
    process.exit(2);
}
// npm runs workspace scripts from the package directory; resolve against the caller's cwd.
const sourceRoot = resolve(
    process.env.INIT_CWD ?? process.cwd(),
    options.source,
);
const sourceCrate = join(sourceRoot, "apps/codemap-search");
const sourceRedact = join(sourceCrate, "src/redact");
const scale = Number(options.scale);
const seed = Number(options.seed);

function lockedVersions(lockPath) {
    const versions = new Map();
    for (const block of readFileSync(lockPath, "utf8").split("[[package]]")) {
        const name = /^name = "(.+)"$/m.exec(block)?.[1];
        const version = /^version = "(.+)"$/m.exec(block)?.[1];
        if (name && version)
            versions.set(name, [...(versions.get(name) ?? []), version]);
    }
    return versions;
}

function sourceRevision() {
    try {
        return execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
            encoding: "utf8",
        }).trim();
    } catch {
        return null;
    }
}

for (const file of COPIED_SOURCE_FILES)
    if (!existsSync(join(sourceRedact, file)))
        throw new Error(`Missing source file: ${join(sourceRedact, file)}`);
const sourceVersions = lockedVersions(join(sourceCrate, "Cargo.lock"));
const ownVersions = lockedVersions(join(crateTemplate, "Cargo.lock"));
const regexCrates = Object.fromEntries(
    PINNED_CRATES.map((name) => [name, ownVersions.get(name)?.[0]]),
);
const versionMismatches = PINNED_CRATES.filter(
    (name) => !sourceVersions.get(name)?.includes(regexCrates[name]),
);
if (versionMismatches.length || sourceVersions.get("regex")?.length !== 1)
    throw new Error(
        `The source Cargo.lock pins other versions of ${versionMismatches.join(", ") || "regex"}; update rust/Cargo.toml and rust/Cargo.lock to match.`,
    );

const workDirectory = mkdtempSync(join(tmpdir(), "redact-rust-differential-"));
const workPath = (name) => join(workDirectory, name);
let isPassed = false;
try {
    const crateDirectory = workPath("crate");
    cpSync(crateTemplate, crateDirectory, { recursive: true });
    for (const file of COPIED_SOURCE_FILES)
        copyFileSync(
            join(sourceRedact, file),
            join(crateDirectory, "src/redact", file),
        );
    const targetDirectory = join(tmpdir(), "redact-rust-differential-target");
    execFileSync("cargo", ["build", "--release", "--locked", "--quiet"], {
        cwd: crateDirectory,
        env: { ...process.env, CARGO_TARGET_DIR: targetDirectory },
        stdio: "inherit",
    });
    const rustBinary = join(
        targetDirectory,
        "release",
        `redact-rust-differential${process.platform === "win32" ? ".exe" : ""}`,
    );

    const patternLines = generatePatternLines();
    const inputLines = generateInputLines({ scale, seed });
    writeFileSync(workPath("patterns.tsv"), `${patternLines.join("\n")}\n`);
    writeFileSync(workPath("pii-inputs.tsv"), `${inputLines.pii.join("\n")}\n`);
    writeFileSync(
        workPath("core-inputs.tsv"),
        `${inputLines.core.join("\n")}\n`,
    );
    execFileSync(rustBinary, [
        "core",
        workPath("core-inputs.tsv"),
        workPath("core-rust.txt"),
    ]);
    execFileSync(rustBinary, [
        "pii",
        workPath("patterns.tsv"),
        workPath("pii-inputs.tsv"),
        workPath("pii-rust.txt"),
    ]);

    let engine;
    try {
        engine = await loadEngine();
    } catch (cause) {
        throw new Error("Build @buyong/redact first (npm run build)", {
            cause,
        });
    }
    const results = {};
    for (const [variant, isNaive] of [
        ["engine", false],
        ["naive", true],
    ]) {
        const core = writeCoreResults(engine, {
            inputLines: inputLines.core,
            outputPath: workPath(`core-${variant}.txt`),
            isNaive,
        });
        const pii = writePiiResults(engine, {
            patternLines,
            inputLines: inputLines.pii,
            outputPath: workPath(`pii-${variant}.txt`),
            isNaive,
        });
        results[variant] = {
            compileErrorCount: core.compileErrorCount + pii.compileErrorCount,
            core: compareCoreResults({
                rustPath: workPath("core-rust.txt"),
                javascriptPath: workPath(`core-${variant}.txt`),
                inputLines: inputLines.core,
            }),
            pii: comparePiiResults({
                rustPath: workPath("pii-rust.txt"),
                javascriptPath: workPath(`pii-${variant}.txt`),
                inputLines: inputLines.pii,
                patternLines,
            }),
        };
    }

    const coverage = measureCoverage({
        piiRustPath: workPath("pii-rust.txt"),
        coreRustPath: workPath("core-rust.txt"),
        patternLines,
    });
    const expectedRuleIds = [
        ...engine.builtInRules.map((rule) => rule.id),
        "private-key.pem",
        "field.sensitive",
    ];
    const undetectedRuleIds = expectedRuleIds.filter(
        (ruleId) => !coverage.detectedRuleIds.includes(ruleId),
    );
    const failures = [
        ...(results.engine.core.mismatchCount
            ? ["built-in rule results differ from Rust"]
            : []),
        ...(results.engine.pii.mismatchCount
            ? ["PII regex results differ from Rust"]
            : []),
        ...(results.naive.core.mismatchCount && results.naive.pii.mismatchCount
            ? []
            : [
                  "the naive control found no difference; the inputs are too weak",
              ]),
        ...(coverage.unmatchedPatterns.length
            ? [
                  `PII patterns never matched: ${coverage.unmatchedPatterns.join(", ")}`,
              ]
            : []),
        ...(undetectedRuleIds.length
            ? [`rule ids never detected: ${undetectedRuleIds.join(", ")}`]
            : []),
    ];
    isPassed = failures.length === 0;
    const report = {
        status: isPassed ? "pass" : "fail",
        failures,
        source: { path: sourceRoot, revision: sourceRevision() },
        runtime: {
            node: process.version,
            unicode: process.versions.unicode,
        },
        regexCrates,
        scale,
        seed,
        inputs: {
            piiPatterns: patternLines.length,
            piiTexts: inputLines.pii.length,
            coreTexts: inputLines.core.length,
        },
        engine: {
            coreMismatches: results.engine.core.mismatchCount,
            piiMismatches: results.engine.pii.mismatchCount,
            coreExamples: results.engine.core.examples.slice(0, 5),
            piiExamples: results.engine.pii.examples.slice(0, 5),
        },
        naiveControl: {
            coreMismatches: results.naive.core.mismatchCount,
            coreRuleIds: Object.keys(results.naive.core.mismatchesByGroup)
                .length,
            piiMismatches: results.naive.pii.mismatchCount,
            piiGroups: Object.keys(results.naive.pii.mismatchesByGroup).length,
            compileErrors: results.naive.compileErrorCount,
        },
        coverage: {
            piiPatternsMatched:
                coverage.patternCount - coverage.unmatchedPatterns.length,
            piiPatterns: coverage.patternCount,
            ruleIdsDetected: expectedRuleIds.length - undetectedRuleIds.length,
            ruleIds: expectedRuleIds.length,
        },
    };
    console.log(JSON.stringify(report, null, 2));
} finally {
    if (options.keep || !isPassed)
        console.error(`Work directory: ${workDirectory}`);
    else rmSync(workDirectory, { recursive: true, force: true });
}
process.exitCode = isPassed ? 0 : 1;
