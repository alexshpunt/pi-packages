import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRedactor } from "@buyong/redact";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../../dist/config.js";
import { createMemoryMasker, digest } from "../../dist/safety.js";
import { readSource } from "../../dist/sources.js";
import { privateJSON, REVIEWER, TARGETS } from "./runtime.mjs";

const input = resolve(process.argv[2]);
const root = resolve(process.argv[3]);
await mkdir(root, { recursive: true, mode: 0o700 });
await chmod(root, 0o700);
const raw = await readFile(input, "utf8");
const values = raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const textOf = (message) =>
    typeof message.content === "string"
        ? message.content
        : (message.content ?? [])
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
const users = values
    .filter(
        (entry) => entry.type === "message" && entry.message.role === "user",
    )
    .map((entry) => textOf(entry.message));
if (
    !users.some((text) =>
        text.includes("b78d43a2c5d355583d72e9c75b530eb1104f6da1"),
    ) ||
    !users.some(
        (text) =>
            text.includes("gpt-6.1-sol medium") && text.includes("swe2-high"),
    )
)
    throw new Error(
        "The selected file is not the approved development conversation.",
    );
const boundary = values.findLastIndex(
    (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName?.endsWith("ask_user_question") &&
        textOf(entry.message).includes("openai-codex (Recommended)") &&
        textOf(entry.message).includes("현재 개발 대화 (Recommended)"),
);
if (boundary < 0)
    throw new Error(
        "The explicit source/provider approval boundary was not found.",
    );
const prefix = values.slice(0, boundary + 1);
const manager = SessionManager.inMemory(values[0].cwd, undefined, prefix);
const active = [manager.getHeader(), ...manager.getBranch()];
const redactor = createRedactor();
const sanitized = active.map((entry) => redactor.redactJson(entry).value);
const file = join(root, "input-session.jsonl");
await writeFile(
    file,
    `${sanitized.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    { mode: 0o600 },
);
const source = await readSource(
    file,
    DEFAULT_SETTINGS.maxInputBytes - 8192,
    new AbortController().signal,
    false,
);
if (!source) throw new Error("The approved branch could not be projected.");
source.text = createMemoryMasker()(source.text);
await privateJSON(join(root, "source.json"), source);
await writeFile(join(root, "source.txt"), source.text, { mode: 0o600 });
await privateJSON(join(root, "input-manifest.json"), {
    sourceSessionId: source.id,
    sourceCwd: source.cwd,
    sourceEntryId: source.leafId,
    approvedBoundaryEntryId: values[boundary].id,
    selectedEntries: active.length,
    inputBytes: Buffer.byteLength(source.text),
    inputHash: digest(source.text),
    selection:
        "current development conversation only, through explicit dataset/provider approval",
    preprocessing:
        "active branch, Pi context projection, image/custom-memory exclusion, byte-bound head/tail projection, redaction",
    targets: TARGETS,
    reviewer: REVIEWER,
    limits: {
        modelRunsPerTarget: 1,
        extractionOutputTokens: DEFAULT_SETTINGS.maxOutputTokens,
        extractionTimeoutMs: DEFAULT_SETTINGS.timeoutMs,
        maxRecallRequests: 3,
        reviewPasses: 1,
    },
    caveats: [
        "A single real session is a pilot, not a representative quality benchmark.",
        "Only model-visible bounded input is valid evidence for grading recall.",
        "No other personal conversation was opened.",
    ],
});
console.log(
    JSON.stringify(
        {
            sourceSessionId: source.id,
            selectedEntries: active.length,
            inputBytes: Buffer.byteLength(source.text),
            inputHash: digest(source.text),
            boundaryEntryId: values[boundary].id,
        },
        null,
        2,
    ),
);
