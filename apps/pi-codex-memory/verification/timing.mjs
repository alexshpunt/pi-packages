import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, isSourceEligible } from "../dist/config.js";

// Explicit synthetic workloads, not personal session telemetry or model-quality measurements.
// Values are minutes after a session starts. Intermediate quiet gaps can resume the same task.
const workloads = [
    { name: "continuous", updates: [0, 5, 10, 15, 20, 25, 30, 35, 40] },
    { name: "short-pauses", updates: [0, 10, 25, 40, 55, 70, 85] },
    { name: "review-pauses", updates: [0, 20, 45, 70, 95] },
    { name: "lunch-resume", updates: [0, 10, 70, 80, 90] },
    { name: "separate-tasks", updates: [0, 120, 240, 360] },
];
const rows = [];
for (const idleMinutes of [5, 15, 30, 60, 360]) {
    const settings = { ...DEFAULT_SETTINGS, minIdleMs: idleMinutes * 60_000 };
    let extractions = 0,
        interimExtractions = 0;
    for (const workload of workloads) {
        let latest = -1,
            processed = -1;
        const end = workload.updates.at(-1) + 361;
        for (let minute = 0; minute <= end; minute++) {
            const index = workload.updates.indexOf(minute);
            if (index >= 0) latest = index;
            if (
                latest !== processed &&
                latest >= 0 &&
                isSourceEligible(
                    workload.updates[latest] * 60_000,
                    minute * 60_000,
                    settings,
                )
            ) {
                extractions++;
                processed = latest;
                if (latest < workload.updates.length - 1) interimExtractions++;
            }
        }
    }
    rows.push({
        idleMinutes,
        extractions,
        interimExtractions,
        finalSnapshotDelayMinutes: idleMinutes,
    });
}
const consolidationRows = [];
for (const intervalMinutes of [15, 30, 60, 180, 360]) {
    // One new source every ten minutes for two hours, then silence.
    let last = -Infinity,
        latest = -1,
        processed = -1,
        calls = 0,
        finalReadyAt = null;
    for (let minute = 0; minute <= 480; minute++) {
        if (minute <= 120 && minute % 10 === 0) latest = minute;
        if (latest !== processed && minute - last >= intervalMinutes) {
            calls++;
            processed = latest;
            last = minute;
            if (latest === 120) finalReadyAt = minute;
        }
    }
    consolidationRows.push({
        intervalMinutes,
        calls,
        finalInputLagMinutes: finalReadyAt - 120,
    });
}
assert.equal(DEFAULT_SETTINGS.minIdleMs, 1_800_000);
assert.equal(DEFAULT_SETTINGS.consolidationCooldownMs, 3_600_000);
console.log(
    JSON.stringify(
        {
            kind: "deterministic-synthetic-timing-comparison",
            cadenceMinutes: 1,
            limitations:
                "No live model, personal-session telemetry, semantic-quality score, prompt-cache hit-rate, or billing measurement. These results do not prove a universal optimum.",
            workloads,
            extraction: rows,
            consolidation: consolidationRows,
            selectedDefaults: {
                minIdleMs: DEFAULT_SETTINGS.minIdleMs,
                consolidationCooldownMs:
                    DEFAULT_SETTINGS.consolidationCooldownMs,
            },
        },
        null,
        2,
    ),
);
