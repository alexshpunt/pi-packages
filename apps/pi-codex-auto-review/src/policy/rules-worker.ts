import { parentPort, workerData } from "node:worker_threads";
import { evaluateRuleSources } from "./rule-engine.js";
import type { RuleSource } from "./rule-types.js";

const data = workerData as { sources: RuleSource[]; commands: string[][] };
try {
    parentPort?.postMessage({
        result: evaluateRuleSources(data.sources, data.commands),
    });
} catch (error) {
    parentPort?.postMessage({
        error:
            error instanceof Error ? error.message : "Rule evaluation failed",
    });
}
