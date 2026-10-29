import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@earendil-works/pi-mcp";
import { type ElicitationHandler, openConnection } from "./connection.js";
import {
    AUTO_APPROVE_RESPONSE,
    classify,
    declineWithMessage,
} from "./elicitation.js";
import type { PrerequisiteCheck } from "./install.js";
import type { BridgeLog } from "./log.js";
import type { RuntimeDiscovery } from "./runtime.js";
import { buildCallMeta } from "./tools.js";

const RESULT_MARKER = "pi-computer-use-check";
const CALL_TIMEOUT_MS = 60_000;
const DETAIL_LIMIT = 300;
const DECLINE_MESSAGE =
    "The pi connection check never grants approvals, so this request was declined.";
/** Lists apps without emitting the list, so the result carries only the count. */
const CHECK_CODE = `const apps = await cua.listApps({ emit: false });
nodeRepl.write(JSON.stringify({ "${RESULT_MARKER}": apps.length }));`;

export interface ConnectionCheckOptions {
    runtime: RuntimeDiscovery;
    isComputerUseEnabled: boolean;
    log: BridgeLog;
    sessionId: string;
}

function shorten(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > DETAIL_LIMIT
        ? `${flat.slice(0, DETAIL_LIMIT)}…`
        : flat;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function appCount(text: string): number | undefined {
    const pattern = new RegExp(`\\{"${RESULT_MARKER}":(\\d+)\\}`);
    const match = pattern.exec(text);
    return match ? Number(match[1]) : undefined;
}

/**
 * Starts a separate, temporary `cua_repl` with only the computer surface, runs `cua.listApps` once
 * and closes it. The shared session server and its REPL bindings are untouched, and no app is
 * operated. Only the empty-form `js` approval Codex auto-accepts is accepted; every other approval
 * request is declined.
 */
export async function checkServiceConnection(
    options: ConnectionCheckOptions,
): Promise<PrerequisiteCheck> {
    const base = {
        id: "service-connection",
        label: "Computer Use connection",
    };
    const { runtime, log } = options;
    if (runtime.kind === "unavailable")
        return { ...base, status: "skipped", detail: "No runtime found." };
    if (runtime.isSimulated)
        return {
            ...base,
            status: "skipped",
            detail: "Not run for a simulated platform.",
        };
    if (!options.isComputerUseEnabled)
        return { ...base, status: "skipped", detail: "Computer Use is off." };
    const declined: string[] = [];
    const elicitationHandler: ElicitationHandler = (params) => {
        const classification = classify(params);
        if (classification.kind === "auto-approve") {
            log.write("check-elicitation-auto-approved", {
                meta: params._meta,
            });
            return { ...AUTO_APPROVE_RESPONSE, content: {} };
        }
        declined.push(classification.message || classification.kind);
        log.write("check-elicitation-declined", {
            kind: classification.kind,
            message: classification.message,
        });
        return declineWithMessage(DECLINE_MESSAGE);
    };
    const startedAt = Date.now();
    let connection: Awaited<ReturnType<typeof openConnection>>;
    try {
        connection = await openConnection({
            plan: runtime,
            state: { computerUse: true, browserUse: false },
            log,
            elicitationHandler,
        });
    } catch (error) {
        return {
            ...base,
            status: "missing",
            detail: `cua_repl did not start: ${shorten(describeError(error))}`,
        };
    }
    try {
        if (!connection.tools.some((tool) => tool.name === "js"))
            return {
                ...base,
                status: "missing",
                detail: "cua_repl does not list the js tool.",
            };
        const turnId = randomUUID();
        let result: CallToolResult;
        try {
            result = await connection.client.request<CallToolResult>(
                "tools/call",
                {
                    name: "js",
                    arguments: { code: CHECK_CODE },
                    _meta: buildCallMeta({
                        callId: randomUUID(),
                        sessionId: options.sessionId,
                        turnId,
                    }),
                },
                { timeoutMs: CALL_TIMEOUT_MS },
            );
        } catch (error) {
            return {
                ...base,
                status: "missing",
                detail: `cua.listApps failed: ${shorten(describeError(error))}`,
            };
        }
        const text = (result.content ?? [])
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n");
        const declinedNote =
            declined.length > 0
                ? ` Declined approval requests: ${declined.join("; ")}.`
                : "";
        const count = result.isError ? undefined : appCount(text);
        if (count === undefined)
            return {
                ...base,
                status: "missing",
                detail: `cua.listApps did not return a result: ${shorten(text) || "(no text)"}${declinedNote}`,
            };
        return {
            ...base,
            status: "ok",
            detail: `cua.listApps returned ${count} apps in ${Date.now() - startedAt}ms.${declinedNote}`,
        };
    } finally {
        await connection.close().catch((error: unknown) =>
            log.write("check-server-stop-failed", {
                error: describeError(error),
            }),
        );
    }
}
