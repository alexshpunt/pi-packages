import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LINE_CHARS = 64 * 1024;
const SECRET_KEY_PATTERN =
    /token|key|secret|account|password|cookie|authorization/i;

/** Replaces values whose key looks secret; applied before anything is written to the log. */
export function redactSecrets(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redactSecrets);
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(
            value as Record<string, unknown>,
        ))
            out[key] = SECRET_KEY_PATTERN.test(key)
                ? "[redacted]"
                : redactSecrets(entry);
        return out;
    }
    return value;
}

/**
 * Append-only, redacted record of the bridge's JSON-RPC traffic and lifecycle, rotated to `.1` once
 * it grows past 5 MB like pi's own `mcp.log`. Writes are synchronous and best effort.
 */
export class BridgeLog {
    private size: number | undefined;

    constructor(readonly path: string) {}

    write(kind: string, payload?: unknown): void {
        let body = "";
        if (payload !== undefined) {
            try {
                body =
                    typeof payload === "string"
                        ? payload
                        : (JSON.stringify(redactSecrets(payload)) ??
                          String(payload));
            } catch {
                body = String(payload);
            }
            if (body.length > MAX_LINE_CHARS)
                body = `${body.slice(0, MAX_LINE_CHARS)}…[${body.length - MAX_LINE_CHARS} more chars]`;
            body = body.replace(/\r?\n/g, "\\n");
        }
        const line = `${new Date().toISOString()} ${kind}${body ? ` ${body}` : ""}\n`;
        try {
            if (this.size === undefined) {
                mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
                this.size = this.currentSize();
            }
            if (this.size > MAX_LOG_BYTES) {
                if (this.currentSize() > MAX_LOG_BYTES)
                    renameSync(this.path, `${this.path}.1`);
                this.size = this.currentSize();
            }
            appendFileSync(this.path, line, { mode: 0o600 });
            this.size += Buffer.byteLength(line);
        } catch {
            // Logging must never break the bridge.
        }
    }

    private currentSize(): number {
        try {
            return statSync(this.path).size;
        } catch {
            return 0;
        }
    }
}
