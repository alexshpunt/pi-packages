import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { classifyThrownError } from "../accounts/failure.ts";
import { type AccountRouter, NO_ACCOUNT_MESSAGE } from "../accounts/router.ts";
import type { SessionAccountBinding } from "../accounts/session.ts";
import { getCloudApiKey } from "../auth/context.ts";
import { fromPromise } from "../shared/effects.ts";

export type ResolveApiKey = (signal?: AbortSignal) => Promise<string | undefined>;

/** Run one Ollama Cloud API operation with a key; the default uses Pi's single credential. */
export type AccountRequestRunner = <T>(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  signal: AbortSignal | undefined,
  run: (resolveApiKey: ResolveApiKey) => Promise<T>,
) => Promise<T>;

export const singleAccountRunner: AccountRequestRunner = (ctx, _signal, run) => run(() => getCloudApiKey(ctx));

/**
 * Run web-tool requests with the session's account. A usage-limit or rejected-key
 * error marks that account and repeats the operation with the next account; other
 * errors, including refused requests (HTTP 403), are returned unchanged.
 */
export function createAccountRequestRunner(
  router: AccountRouter,
  binding: SessionAccountBinding,
): AccountRequestRunner {
  return (ctx, signal, run) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const primaryKey = yield* fromPromise(() => getCloudApiKey(ctx));
        const excludedIds = new Set<string>();
        let lastError: unknown;
        let hasLastError = false;
        for (;;) {
          const acquisition = yield* fromPromise(() => router.acquire({ primaryKey, binding, excludedIds, signal }));
          if (!acquisition.ok) {
            if (hasLastError) throw lastError;
            // Keep each tool's own missing-key error.
            if (acquisition.message === NO_ACCOUNT_MESSAGE) return yield* fromPromise(() => run(async () => undefined));
            throw new Error(acquisition.message);
          }
          const { account } = acquisition;
          excludedIds.add(account.id);
          const outcome = yield* fromPromise(() => run(async () => account.apiKey)).pipe(
            Effect.match({
              onSuccess: (value) => ({ ok: true as const, value }),
              onFailure: (error) => ({ ok: false as const, error }),
            }),
          );
          if (outcome.ok) return outcome.value;
          const failure = signal?.aborted ? undefined : classifyThrownError(outcome.error);
          if (!failure || failure.kind === "forbidden") return yield* Effect.fail(outcome.error);
          yield* fromPromise(() => router.reportFailure(account, failure));
          lastError = outcome.error;
          hasLastError = true;
        }
      }),
    );
}
