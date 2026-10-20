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
import { classifyProviderMessage } from "../accounts/failure.ts";
import type { AccountAcquisition, AccountRouter } from "../accounts/router.ts";
import type { SessionAccountBinding } from "../accounts/session.ts";

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
 * apart from a notification. Errors after `start` are passed through unchanged.
 */
export function createAccountStreamSimple(dependencies: AccountStreamDependencies): StreamSimpleFunction {
  const { router, binding, delegate = registeredApiStream } = dependencies;
  return (model, context, options) =>
    lazyStream(model, async () => {
      const signal = options?.signal;
      const excludedIds = new Set<string>();
      const acquire = (): Promise<AccountAcquisition> =>
        router.acquire({ primaryKey: options?.apiKey, binding, modelId: model.id, excludedIds, signal });
      try {
        let acquisition = await acquire();
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
          const first = await iterator.next();
          if (!first.done && first.value.type === "error" && first.value.reason === "error") {
            const failure = classifyProviderMessage(first.value.error.errorMessage);
            if (failure) {
              await router.reportFailure(account, failure, { modelId: model.id });
              const next = await acquire();
              if (next.ok) {
                acquisition = next;
                continue;
              }
            }
          }
          // With no other account available, Pi receives the provider's own error.
          return replay(first, iterator, stream);
        }
      } catch (error) {
        if (signal?.aborted) return abortedEvents(model);
        throw error;
      }
    });
}
