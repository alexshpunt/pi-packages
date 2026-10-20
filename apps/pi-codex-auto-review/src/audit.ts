import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
    GuardAction,
    ReviewResult,
    ReviewTerminalState,
    RiskLevel,
    UserAuthorization,
} from "./contracts.js";

interface ReviewAudit {
    status: ReviewTerminalState;
    riskLevel?: RiskLevel;
    userAuthorization?: UserAuthorization;
    rationale?: string;
}

export function redact(text: string, markers: readonly string[] = []): string {
    let safe = text
        .replace(/SYNTHETIC_[A-Z0-9_:-]+/gi, "[REDACTED]")
        .replace(/\b(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
        .replace(
            /\b((?:api[_-]?key|token|password|secret)\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;"']+)/gi,
            "$1[REDACTED]",
        )
        .replace(
            /\b(?:sk-[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{16})\b/g,
            "[REDACTED]",
        );
    for (const marker of markers)
        if (marker) safe = safe.split(marker).join("[REDACTED]");
    return safe;
}
export class AuditLog {
    private tail: Promise<unknown> = Promise.resolve();
    constructor(
        readonly path?: string,
        readonly markers: readonly string[] = [],
    ) {}
    readonly records: {
        timestamp: string;
        actionDigest: string;
        toolCallId: string;
        tool: string;
        sessionId: string;
        event: string;
        outcome: string;
        review?: ReviewAudit;
    }[] = [];
    async recordReview(
        action: GuardAction,
        result: ReviewResult,
    ): Promise<void> {
        const review: ReviewAudit =
            "assessment" in result
                ? {
                      status: result.status,
                      riskLevel: result.assessment.risk_level,
                      userAuthorization: result.assessment.user_authorization,
                      rationale: redact(
                          result.assessment.rationale,
                          this.markers,
                      ).slice(0, 1000),
                  }
                : { status: result.status };
        await this.record(action, "review", result.status, review);
    }
    async record(
        action: GuardAction,
        event: string,
        outcome: string,
        review?: ReviewAudit,
    ): Promise<void> {
        // No arguments, command text, content, provider text or worker output enter the audit schema.
        const record = {
            timestamp: new Date().toISOString(),
            actionDigest: action.digest,
            toolCallId: action.toolCallId,
            tool: action.tool,
            sessionId: action.sessionId,
            event,
            outcome,
            ...(review ? { review } : {}),
        };
        const safe = JSON.parse(
            JSON.stringify(record, (_key, value: unknown) =>
                typeof value === "string" ? redact(value, this.markers) : value,
            ),
        ) as typeof record;
        this.records.push(safe);
        if (!this.path) return;
        const path = this.path;
        const pending = this.tail.then(async () => {
            await mkdir(dirname(path), { recursive: true, mode: 0o700 });
            await appendFile(path, `${JSON.stringify(safe)}\n`, {
                mode: 0o600,
            });
        });
        this.tail = pending.catch(() => {});
        await pending;
    }
    async flush(): Promise<void> {
        await this.tail;
    }
}
