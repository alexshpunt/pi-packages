import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GuardAction, Json } from "../contracts.js";
import type { ReviewContextStore } from "./context.js";

/** Attest only answers returned by Pi's real dialog API, never claims in tool output. */
export function observeToolUserInput<T extends ExtensionContext>(
    context: T,
    action: GuardAction,
    store: ReviewContextStore,
    signal: AbortSignal,
): T {
    const identity = store.identity;
    const ui = new Proxy(context.ui, {
        get(target, key) {
            const original = Reflect.get(target, key, target);
            if (
                !["select", "confirm", "input"].includes(String(key)) ||
                typeof original !== "function"
            )
                return typeof original === "function"
                    ? original.bind(target)
                    : original;
            return async (...args: unknown[]) => {
                const answer = await Reflect.apply(original, target, args);
                if (
                    answer !== undefined &&
                    !signal.aborted &&
                    store.identity === identity
                ) {
                    const title = String(args[0] ?? ""),
                        method = String(key);
                    const question =
                        method === "select"
                            ? { title, options: args[1] }
                            : method === "confirm"
                              ? { title, message: args[1] }
                              : {
                                    title,
                                    ...(args[1] !== undefined
                                        ? { placeholder: args[1] }
                                        : {}),
                                };
                    const isRedacted =
                        method === "input" &&
                        /password|api[_ -]?key|token|secret|credential/i.test(
                            title,
                        );
                    store.recordUserAnswer({
                        type: "verified-tool-user-answer",
                        tool: action.tool,
                        toolCallId: action.toolCallId,
                        actionDigest: action.digest,
                        question: JSON.parse(JSON.stringify(question)) as Json,
                        method,
                        answer: isRedacted ? "[REDACTED]" : (answer as Json),
                        ...(isRedacted ? { isRedacted: true } : {}),
                    });
                }
                return answer;
            };
        },
    });
    return new Proxy(context, {
        get(target, key) {
            if (key === "ui") return ui;
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}
