import { randomUUID } from "node:crypto";
import type { AgentActivityOutcome } from "@earendil-works/pi-coding-agent";
import type { BridgeConnection } from "./connection.js";
import type { BridgeLog } from "./log.js";

/** Codex's plugin hook events the runtime understands (`SubagentStop` is never emitted by pi). */
export type HookEventName = "Stop" | "Interrupt";

export interface TurnInfo {
    turnId: string;
    startedAtUnixMs: number;
}

export interface SettledTurn extends TurnInfo {
    outcome: AgentActivityOutcome | undefined;
    hookEventName: HookEventName;
}

/** `aborted` is the user's interrupt; `completed` and `error` end the turn normally. */
export function hookEventNameFor(
    outcome: AgentActivityOutcome | undefined,
): HookEventName {
    return outcome === "aborted" ? "Interrupt" : "Stop";
}

/**
 * One Codex turn equals one pi agent run (`agent_start` → `agent_settled`). A tool call outside a
 * run (for example from codemode or a command) starts a turn on demand.
 */
export class TurnTracker {
    private current: TurnInfo | undefined;
    private outcome: AgentActivityOutcome | undefined;

    begin(): TurnInfo {
        this.current = { turnId: randomUUID(), startedAtUnixMs: Date.now() };
        this.outcome = undefined;
        return this.current;
    }

    ensure(): TurnInfo {
        return this.current ?? this.begin();
    }

    get currentTurn(): TurnInfo | undefined {
        return this.current;
    }

    recordOutcome(outcome: AgentActivityOutcome): void {
        this.outcome = outcome;
    }

    /** Returns the turn to notify about and clears it, so each run notifies at most once. */
    settle(): SettledTurn | undefined {
        const turn = this.current;
        if (!turn) return undefined;
        this.current = undefined;
        const outcome = this.outcome;
        this.outcome = undefined;
        return { ...turn, outcome, hookEventName: hookEventNameFor(outcome) };
    }
}

/**
 * node_repl answers `turn_ended` only after the current `js` execution finishes, and a cancelled `js`
 * keeps running inside the REPL until its own timeout, so the wait has to cover that.
 */
const TURN_ENDED_TIMEOUT_MS = 120_000;

/** Calls the runtime's `turn_ended` tool the way Codex's bundled hook does. Failures are logged only. */
export async function notifyTurnEnded(
    connection: BridgeConnection,
    sessionId: string,
    turn: SettledTurn,
    log: BridgeLog,
): Promise<boolean> {
    if (connection.isClosed()) return false;
    const started = Date.now();
    try {
        const result = await connection.client.request<{
            isError?: boolean;
            content?: unknown;
        }>(
            "tools/call",
            {
                name: "turn_ended",
                arguments: {
                    hook_event_name: turn.hookEventName,
                    session_id: sessionId,
                    turn_id: turn.turnId,
                },
            },
            { timeoutMs: TURN_ENDED_TIMEOUT_MS },
        );
        log.write("turn-ended", {
            hookEventName: turn.hookEventName,
            outcome: turn.outcome,
            turnId: turn.turnId,
            isError: result?.isError ?? false,
            durationMs: Date.now() - started,
        });
        return !result?.isError;
    } catch (error) {
        log.write("turn-ended-failed", {
            hookEventName: turn.hookEventName,
            turnId: turn.turnId,
            error: error instanceof Error ? error.message : String(error),
        });
        return false;
    }
}
