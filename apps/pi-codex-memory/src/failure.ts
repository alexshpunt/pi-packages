/** Safe categories only: provider messages can contain credentials or source text. */
export type MemoryFailureCode =
    | "aborted"
    | "timeout"
    | "model_unavailable"
    | "authentication_unavailable"
    | "reasoning_unsupported"
    | "daily_budget"
    | "input_budget"
    | "output_length"
    | "stream_incomplete"
    | "provider_error"
    | "schema_invalid"
    | "ungrounded_pointer"
    | "ungrounded_identifier"
    | "superseded"
    | "storage";
export interface MemoryUsage {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
}
export class MemoryFailure extends Error {
    constructor(
        readonly code: MemoryFailureCode,
        readonly usage?: MemoryUsage,
    ) {
        super(`Memory operation failed (${code}).`);
        this.name = "MemoryFailure";
    }
}
/** Fixed management guidance without source text or provider output; UI boundaries may show it verbatim. */
export class MemoryUserError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MemoryUserError";
    }
}
export function memoryFailureCode(error: unknown): MemoryFailureCode {
    if (error instanceof MemoryFailure) return error.code;
    if (error instanceof Error && error.name === "TimeoutError")
        return "timeout";
    if (error instanceof Error && error.name === "AbortError") return "aborted";
    return "storage";
}
