import { queryRecovery } from "../streaming-cases.js";
import type { VerificationCheck } from "../types.js";

export default {
	name: "09-query-recovery", mode: "live",
	inputs: { buffered: false, turns: 5, failures: ["HTTP connection loss after partial output", "owned SDK process SIGKILL during output"] },
	expected: { failuresAreNotCallerAborts: true, memoryPreservedAfterRecovery: true, terminalCount: 1, queryScopesClosed: true },
	run: queryRecovery,
} satisfies VerificationCheck;
