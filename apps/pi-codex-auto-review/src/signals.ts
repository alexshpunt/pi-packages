import { GuardError } from "./contracts.js";
export interface Clock {
    setTimeout(fn: () => void, delayMs: number): unknown;
    clearTimeout(id: unknown): void;
}
export const SYSTEM_CLOCK: Clock = {
    setTimeout: (fn, delayMs) => setTimeout(fn, delayMs),
    clearTimeout: (id) => clearTimeout(id as NodeJS.Timeout),
};
export function deadlineSignal(
    caller: AbortSignal | undefined,
    timeoutMs: number,
    clock: Clock = SYSTEM_CLOCK,
) {
    const controller = new AbortController();
    const onAbort = () =>
        controller.abort(
            caller?.reason ?? new GuardError("CANCELLED", "Call cancelled"),
        );
    if (caller?.aborted) onAbort();
    else caller?.addEventListener("abort", onAbort, { once: true });
    const id = clock.setTimeout(
        () =>
            controller.abort(
                new GuardError("TIMEOUT", "Configured deadline expired"),
            ),
        timeoutMs,
    );
    return {
        signal: controller.signal,
        dispose() {
            clock.clearTimeout(id);
            caller?.removeEventListener("abort", onAbort);
        },
    };
}
export async function withSignal<T>(
    work: Promise<T>,
    signal: AbortSignal,
): Promise<T> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const onAbort = () =>
            reject(
                signal.reason ?? new GuardError("CANCELLED", "Call cancelled"),
            );
        signal.addEventListener("abort", onAbort, { once: true });
        work.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            },
        );
    });
}
