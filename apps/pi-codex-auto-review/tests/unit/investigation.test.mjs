import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeRedactionConfig } from "@buyong/redact";
import { expect, test } from "vitest";
import { LocalInvestigation } from "../../dist/review/investigation.js";
import { reviewRedactor } from "../../dist/review/redaction.js";
import { PiExecutor } from "../../dist/tools/executor.js";
import { fixture } from "../harness/fixtures.mjs";

test("[investigation] masks the full file and .env values before line and character excerpts", async (t) => {
    const f = await fixture(t);
    const executor = new PiExecutor();
    t.onTestFinished(() => executor.close());
    const redactor = reviewRedactor(normalizeRedactionConfig({
        rules: [{ id: "custom.boundary", pattern: "start:(?<secret>BOUNDARYVALUE)\\nEND" }],
    }).config);
    const inspection = new LocalInvestigation(executor, f.profile, f.workspace, redactor);
    const boundary = "public\n".repeat(119) + "start:BOUNDARYVALUE\nEND\n";
    await writeFile(join(f.workspace, "boundary.txt"), boundary);
    await writeFile(join(f.workspace, ".env"), "DB_PASSWORD=alpha beta gamma\n");
    const signal = new AbortController().signal;
    expect(await inspection.execute("inspect_file", { path: "boundary.txt" }, signal)).not.toContain("BOUNDARYVALUE");
    const env = await inspection.execute("inspect_file", { path: ".env" }, signal);
    for (const part of ["alpha", "beta", "gamma"]) expect(env).not.toContain(part);
    expect(env).toContain("[REDACTED]");
    const original = await executor.execute({ kind: "tool", tool: "read", toolCallId: "original", args: { path: join(f.workspace, ".env") }, cwd: f.workspace }, f.profile, { readPaths: [], writePaths: [], domains: [] });
    expect(original.content[0].text).toContain("alpha beta gamma");
});

test("[investigation] rejects oversized raw files instead of inspecting an unmasked prefix", async (t) => {
    const f = await fixture(t);
    const executor = new PiExecutor();
    t.onTestFinished(() => executor.close());
    const inspection = new LocalInvestigation(executor, f.profile, f.workspace);
    await writeFile(join(f.workspace, "large.txt"), "x".repeat(1024 * 1024 + 1));
    await expect(inspection.execute("inspect_file", { path: "large.txt" }, new AbortController().signal)).rejects.toThrow(/1 MiB read limit/);
});
