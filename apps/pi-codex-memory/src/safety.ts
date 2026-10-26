import { createHash, randomUUID } from "node:crypto";
import {
    closeSync,
    lstatSync,
    mkdirSync,
    openSync,
    realpathSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createRedactor } from "@buyong/redact";
import {
    MemoryFailure,
    MemoryUserError,
    memoryFailureCode,
} from "./failure.js";

export const SUMMARY_MAX_BYTES = 9000;
export const CONSOLIDATED_MAX_BYTES = 10_000;
export const OUTPUT_MAX_BYTES = 24 * 1024;
export function digest(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}
export function canonicalCwd(cwd: string): string {
    try {
        return realpathSync(cwd);
    } catch {
        return resolve(cwd);
    }
}
export function workspaceScope(cwd: string): string {
    return `workspace-${digest(canonicalCwd(cwd)).slice(0, 24)}`;
}
export function truncateBytes(
    text: string,
    maxBytes: number,
    marker = "\n[truncated]",
): string {
    if (Buffer.byteLength(text) <= maxBytes) return text;
    const budget = Math.max(0, maxBytes - Buffer.byteLength(marker));
    const buffer = Buffer.from(text);
    let end = budget;
    while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
    return buffer.subarray(0, end).toString("utf8") + marker.slice(0, maxBytes);
}
export function truncateMiddleBytes(
    text: string,
    maxBytes: number,
    marker = "\n[Middle omitted by input byte budget; missing evidence is unknown.]\n",
): string {
    if (Buffer.byteLength(text) <= maxBytes) return text;
    if (maxBytes <= Buffer.byteLength(marker))
        return truncateBytes(text, maxBytes, "");
    const half = Math.max(
        0,
        Math.floor((maxBytes - Buffer.byteLength(marker)) / 2),
    );
    const buffer = Buffer.from(text);
    let start = buffer.length - half;
    while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
    return (
        truncateBytes(text, half, "") +
        marker +
        buffer.subarray(start).toString("utf8")
    );
}
export function jsonStringBytes(text: string): number {
    return Buffer.byteLength(JSON.stringify(text)) - 2;
}
/** Exact JSON-escaped budget; unlike percentage cuts this does not discard spare capacity. */
export function fitJSONString(text: string, maxBytes: number): string {
    if (maxBytes < 0) throw new MemoryFailure("input_budget");
    if (jsonStringBytes(text) <= maxBytes) return text;
    const marker =
        "\n[Middle omitted by input byte budget; missing evidence is unknown.]\n";
    const hasMarkerBudget = maxBytes > jsonStringBytes(marker) + 8;
    let low = hasMarkerBudget ? Buffer.byteLength(marker) + 1 : 0;
    let high = Buffer.byteLength(text);
    let best = hasMarkerBudget ? marker : "";
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = hasMarkerBudget
            ? truncateMiddleBytes(text, middle, marker)
            : truncateBytes(text, middle, "");
        if (jsonStringBytes(candidate) <= maxBytes) {
            best = candidate;
            low = middle + 1;
        } else high = middle - 1;
    }
    return best;
}
export function createMemoryMasker(): (text: string) => string {
    const redactor = createRedactor(undefined, {
        rules: [
            {
                id: "host.memory-bearer",
                pattern: "\\bBearer\\s+(?<secret>[^\\s\\\"']+)",
                flags: "i",
            },
            {
                id: "host.memory-url-query",
                pattern:
                    "(?:[?&](?:token|key|api_key|signature|sig|password|secret)=)(?<secret>[^&#\\s]+)",
                flags: "i",
            },
        ],
    });
    return (text) => redactor.redactText(text);
}
/** Reject newly invented contact identifiers and host paths; explicit user notes are not filtered. */
export function createMemoryGroundingGuard(): (
    input: string,
    output: string,
) => void {
    const detector = createRedactor({ piiEntities: ["EMAIL_ADDRESS"] });
    return (input, output) => {
        const values: string[] = [];
        const pending: unknown[] = [JSON.parse(input)];
        while (pending.length) {
            const value = pending.pop();
            if (typeof value === "string") values.push(value);
            else if (value && typeof value === "object")
                pending.push(...Object.values(value));
        }
        const evidence = values.join("\n");
        const emails = detector
            .scan(output)
            .detections.filter((item) => item.ruleId === "pii.email-address")
            .map((item) => output.slice(item.start, item.end));
        const paths = [
            ...output.matchAll(
                /(?:^|[\s\x60\x22'(])((?:\/(?:Users|Volumes|home|tmp|var|private|workspace|workspaces)\/|[A-Za-z]:\\)[^\s\x60\x22'<>]+)/gm,
            ),
        ].map((match) => match[1]!.replace(/[),.;:]+$/, ""));
        if (
            emails.some(
                (value) =>
                    !evidence.toLowerCase().includes(value.toLowerCase()),
            ) ||
            paths.some((value) => !evidence.includes(value))
        )
            throw new MemoryFailure("ungrounded_identifier");
    };
}
export function privateDirectory(path: string): void {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error("Memory directory must not be a symlink.");
}
export function atomicWrite(path: string, content: string): void {
    privateDirectory(dirname(path));
    try {
        if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
            throw new Error("Memory artifact must be a regular file.");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
        writeFileSync(descriptor, content, "utf8");
        closeSync(descriptor);
        renameSync(temporary, path);
    } catch (error) {
        try {
            closeSync(descriptor);
        } catch {}
        try {
            unlinkSync(temporary);
        } catch (cleanupError) {
            if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT")
                throw cleanupError;
        }
        throw error;
    }
}
export function abortable<T>(
    work: Promise<T>,
    signal: AbortSignal,
): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error("Cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        work.then(resolve, reject).finally(() =>
            signal.removeEventListener("abort", abort),
        );
    });
}
export function safeError(error: unknown): string {
    // Provider errors can contain source text, credentials, or response bodies.
    if (error instanceof MemoryFailure || error instanceof MemoryUserError)
        return error.message;
    return error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError")
        ? `Memory operation failed (${memoryFailureCode(error)}).`
        : "Memory operation failed. Check model configuration, input limits, and storage permissions.";
}
