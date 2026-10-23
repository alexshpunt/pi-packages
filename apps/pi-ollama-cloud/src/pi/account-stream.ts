import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  ProviderHeaders,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { getApiProvider, lazyStream } from "@earendil-works/pi-ai/compat";
import { Effect } from "effect";
import { classifyProviderMessage, isConcurrencyLimitMessage } from "../accounts/failure.ts";
import type { AccountAcquisition, AccountRouter } from "../accounts/router.ts";
import type { SessionAccountBinding } from "../accounts/session.ts";
import { fromPromise, runAbortable } from "../shared/effects.ts";

export type StreamSimpleFunction = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface AccountStreamDependencies {
  router: AccountRouter;
  binding: SessionAccountBinding;
  /** Defaults to the API implementation Pi registered for the model's `api`. */
  delegate?: StreamSimpleFunction;
  /** Waits before resending after a concurrency limit; rejects when `signal` aborts. Replaced in tests. */
  wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  /** Source of jitter in [0, 1). */
  random?: () => number;
}

/**
 * Waits before resending a request the account's concurrent request limit refused. Parallel Pi sessions and
 * subagents share one account, so a slot usually frees within seconds; Pi's own retries (2/4/8 s) were too
 * short and too synchronized to get through a burst. Each delay is jittered to between 0.5 and 1.5 times.
 */
export const CONCURRENCY_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000];

const defaultWait = (delayMs: number, signal?: AbortSignal) => runAbortable(Effect.sleep(delayMs), signal);

/** Pi loads the OpenAI-compatible API implementation on the first request. After Pi is upgraded under a running
 *  session, that file no longer exists; name the cause instead of only the missing path. */
const STALE_PI_BUNDLE_PATTERN = /Cannot find module '[^']*[\\/]pi-coding-agent[\\/]dist[\\/]/;
const STALE_PI_BUNDLE_HINT = "Pi was updated while this session was running. Restart Pi to use Ollama Cloud.";

function explainStalePiBundle(error: AssistantMessage): void {
  if (
    error.errorMessage &&
    STALE_PI_BUNDLE_PATTERN.test(error.errorMessage) &&
    !error.errorMessage.startsWith(STALE_PI_BUNDLE_HINT)
  ) {
    error.errorMessage = `${STALE_PI_BUNDLE_HINT} (${error.errorMessage})`;
  }
}

/** The same dispatch Pi performs for a provider without its own stream implementation. */
function registeredApiStream(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const api = getApiProvider(model.api);
  if (!api) throw new Error(`No API provider registered for api: ${model.api}`);
  return api.streamSimple(model, context, options);
}

/** Replace a configured Authorization header (models.json `authHeader`) with the selected account's key. */
function withAccountAuthorization(headers: ProviderHeaders | undefined, apiKey: string) {
  if (!headers) return headers;
  const names = Object.keys(headers).filter((name) => name.toLowerCase() === "authorization");
  if (names.length === 0) return headers;
  const next: ProviderHeaders = { ...headers };
  for (const name of names) next[name] = `Bearer ${apiKey}`;
  return next;
}

function replay(
  first: IteratorResult<AssistantMessageEvent>,
  iterator: AsyncIterator<AssistantMessageEvent>,
  stream: AssistantMessageEventStream,
) {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
      if (first.done) return;
      yield first.value;
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    },
    result: () => stream.result(),
  };
}

function abortedEvents(model: Model<Api>) {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "aborted",
    errorMessage: "Request was aborted",
    timestamp: Date.now(),
  };
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
      yield { type: "error", reason: "aborted", error: message };
    },
    result: async () => message,
  };
}

/**
 * Provider `streamSimple` that sends each request with the session's account.
 * A usage-limit, rejected-key, or refused-model error that arrives before the
 * response starts marks the account and retries the same request once per
 * remaining account; nothing has reached Pi yet, so the switch is invisible
 * apart from a notification. A concurrent request limit before `start` waits
 * (CONCURRENCY_RETRY_DELAYS_MS) and resends on the same account. Errors after
 * `start` are passed through unchanged.
 */
export function createAccountStreamSimple(dependencies: AccountStreamDependencies): StreamSimpleFunction {
  const { router, binding, delegate = registeredApiStream, wait = defaultWait, random = Math.random } = dependencies;
  return (model, context, options) =>
    lazyStream(model, async () => {
      const signal = options?.signal;
      const excludedIds = new Set<string>();
      const acquire = (): Promise<AccountAcquisition> =>
        router.acquire({ primaryKey: options?.apiKey, binding, modelId: model.id, excludedIds, signal });
      let concurrencyRetries = 0;
      try {
        return await Effect.runPromise(
          Effect.gen(function* () {
            let acquisition = yield* fromPromise(acquire);
            for (;;) {
              if (!acquisition.ok) throw new Error(acquisition.message);
              const { account } = acquisition;
              excludedIds.add(account.id);
              const stream = delegate(model, context, {
                ...options,
                apiKey: account.apiKey,
                headers: withAccountAuthorization(options?.headers, account.apiKey),
              });
              const iterator = stream[Symbol.asyncIterator]();
              const first = yield* fromPromise(() => iterator.next());
              if (!first.done && first.value.type === "error" && first.value.reason === "error") {
                const errorMessage = first.value.error.errorMessage;
                const failure = classifyProviderMessage(errorMessage);
                if (failure) {
                  yield* fromPromise(() => router.reportFailure(account, failure, { modelId: model.id }));
                  const next = yield* fromPromise(acquire);
                  if (next.ok) {
                    acquisition = next;
                    continue;
                  }
                } else if (
                  isConcurrencyLimitMessage(errorMessage) &&
                  concurrencyRetries < CONCURRENCY_RETRY_DELAYS_MS.length
                ) {
                  const delayMs = Math.round(CONCURRENCY_RETRY_DELAYS_MS[concurrencyRetries] * (0.5 + random()));
                  concurrencyRetries++;
                  if (concurrencyRetries === 1) {
                    binding.notify(
                      `Ollama Cloud account "${account.id}" is at its concurrent request limit; waiting for a free slot.`,
                    );
                  }
                  yield* fromPromise(() => wait(delayMs, signal));
                  // Nothing reached Pi yet, so the same account is asked again once the wait ends.
                  excludedIds.delete(account.id);
                  acquisition = yield* fromPromise(acquire);
                  continue;
                }
              }
              if (!first.done && first.value.type === "error") explainStalePiBundle(first.value.error);
              // With no other account available, Pi receives the provider's own error.
              return replay(first, iterator, stream);
            }
          }),
        );
      } catch (error) {
        if (signal?.aborted) return abortedEvents(model);
        throw error;
      }
    });
}
