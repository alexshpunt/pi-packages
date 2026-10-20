import { readFileSync } from "node:fs";
import { evaluateRuleSources } from "./rule-engine.js";
import type { RuleSource } from "./rule-types.js";

try {
    const input = readFileSync(0, "utf8");
    if (Buffer.byteLength(input) > 8 * 1024 * 1024)
        throw new Error("Rule request exceeded its size budget");
    const data = JSON.parse(input) as {
        sources: RuleSource[];
        commands: string[][];
    };
    process.stdout.write(
        JSON.stringify(evaluateRuleSources(data.sources, data.commands)),
    );
} catch (error) {
    process.stderr.write(
        error instanceof Error ? error.message : "Rule evaluation failed",
    );
    process.exitCode = 1;
}
