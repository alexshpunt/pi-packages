import { streamingLifecycle } from "../streaming-cases.js";
import type { VerificationCheck } from "../types.js";

export default {
	name: "09-stream-lifecycle", mode: "live",
	inputs: { buffered: false, turns: 3, cancellation: "first text delta before upstream completion" },
	expected: { earlyDeltas: true, orderedEvents: true, terminalCount: 1, canceledThenRecovered: true, queryScopesClosed: true },
	run: streamingLifecycle,
} satisfies VerificationCheck;
