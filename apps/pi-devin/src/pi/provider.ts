import {
  clampThinkingLevel,
  type AssistantMessageEventStream, type Model, type Provider, type SimpleStreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { DevinClient, type DevinClientOptions } from "../core/client.ts";
import { assertCanInfer } from "../core/auth/access.ts";
import { ChatAccumulator, chatRequest } from "../core/inference/chat.ts";
import { applyTeamModelPolicy } from "../core/models/access.ts";
import type { BackendModelSelection, EffectiveThinkingLevel } from "../core/models/variants.ts";
import { createFingerprintProvider, type FingerprintProvider } from "../core/protocol/fingerprint.ts";
import { CHAT_METHOD } from "../core/protocol/protobuf.ts";
import { awaitWithSignal, endpoint, isAuthenticationError, isTransientConnectionFailure, RPCError, safeError } from "../core/protocol/transport.ts";
import { object, requiredString, tokenCount, type Credential, type JsonObject } from "../core/types.ts";
import { createDevinAccountAuth } from "./auth.ts";
import { DevinLifecycle, type RequestLease, type SessionBinding } from "./lifecycle.ts";
import { toDevinTranscript } from "./messages.ts";
import { catalogScope, createDevinModelSource, DEVIN_API, hasExtendedPromptCacheRetention, isFusionModelID, type FusionChoices, type FusionSelection } from "./models.ts";
import { FUSION_LEAD_GUIDANCE } from "./sidekick.ts";
import { DevinResponseStream } from "./stream.ts";
import { accountUsage, type AccountUsage } from "./usage.ts";

type LoginConfiguration = NonNullable<Parameters<typeof createDevinAccountAuth>[0]>["loginOptions"];

/** Like Pi's built-in providers: the caller option wins; otherwise only PI_CACHE_RETENTION=long (provider env first) means long retention. */
/** Node and Connect report these failures as codes ("read ECONNRESET", "unavailable: …") that Pi's host retry does not match. */
function hostRetryableMessage(error: unknown, message: string): string {
  return isTransientConnectionFailure(error) ? `Connection error (${message})` : message;
}

function resolveCacheRetention(options: SimpleStreamOptions): NonNullable<SimpleStreamOptions["cacheRetention"]> {
  if (options.cacheRetention) return options.cacheRetention;
  return (options.env?.PI_CACHE_RETENTION || process.env.PI_CACHE_RETENTION) === "long" ? "long" : "short";
}
export interface DevinProvider extends Provider<typeof DEVIN_API> {
  refreshModels: NonNullable<Provider<typeof DEVIN_API>["refreshModels"]>;
  readonly lifecycle: DevinLifecycle;
  attachSession(binding: SessionBinding): void;
  getFusionChoices(): FusionChoices | undefined;
  /** Rebuilds the model list from the current catalog without network after the saved Fusion choice or display settings change. */
  rebuildModels(): void;
  /** Quota from the last account status received. Makes no request; undefined if none was received. */
  getAccountUsage(): AccountUsage | undefined;
  shutdown(): void;
}

export function createDevinProvider(options: {
  fetch?: typeof fetch;
  fingerprint?: (credential: Credential) => FingerprintProvider;
  http?: DevinClientOptions["http"];
  loginOptions?: LoginConfiguration;
  maxModelCalls?: number;
  /** Reads the saved Fusion choice. false (sidekick process) creates no Fusion entry. */
  fusion?: false | (() => FusionSelection | undefined);
  /** Reads the saved recommended filter setting. */
  recommendedOnly?: () => boolean;
  /** Also lists exact UIDs that a group already covers. Used only by the sidekick child Pi. */
  listsAllExactModels?: boolean;
  now?: () => number;
} = {}): DevinProvider {
  const lifecycle = new DevinLifecycle(options.maxModelCalls);
  let lifetime = new AbortController();
  const clients = new Set<DevinClient>();
  const fingerprints = new Map<string, FingerprintProvider>();
  const accounts = new Map<string, { ownerHash: string; status: JsonObject }>();
  const now = options.now ?? Date.now;
  let latestUsage: AccountUsage | undefined;
  const clientFor = (credential: Credential, extra: DevinClientOptions = {}): DevinClient => {
    const key = catalogScope(credential);
    let fingerprint = fingerprints.get(key);
    if (!fingerprint) {
      if (fingerprints.size >= 16) fingerprints.delete(fingerprints.keys().next().value!);
      fingerprint = options.fingerprint?.(credential) ?? createFingerprintProvider(credential.sessionToken);
      fingerprints.set(key, fingerprint);
    }
    const fetch = extra.fetch ?? options.fetch;
    const client = new DevinClient(credential, { ...extra, fingerprint, fetch, ...(!fetch && options.http ? { http: options.http } : {}) });
    const close = client.transport.close.bind(client.transport);
    let hasClosed = false;
    client.transport.close = () => { if (!hasClosed) { hasClosed = true; clients.delete(client); close(); } };
    clients.add(client);
    return client;
  };
  const rememberAccount = (credential: Credential, ownerHash: string, status: JsonObject) => {
    if (lifetime.signal.aborted) return;
    if (accounts.size >= 16) accounts.delete(accounts.keys().next().value!);
    accounts.set(catalogScope(credential), { ownerHash, status });
    latestUsage = accountUsage(status, now());
  };
  const auth = createDevinAccountAuth({
    loginOptions: { ...options.loginOptions, fetch: options.loginOptions?.fetch ?? options.fetch },
    createClient: (credential) => clientFor(credential, { profile: "login" }),
    getSignal: () => lifetime.signal,
    isAccountChecked: (credential) => accounts.has(catalogScope(credential)),
    onValidated: rememberAccount,
    onInvalidated: (credential, error) => { accounts.delete(catalogScope(credential)); latestUsage = undefined; lifecycle.abort(error); },
    onLogin: () => {
      accounts.clear(); fingerprints.clear(); latestUsage = undefined; source.invalidate();
      lifecycle.abort(new DOMException("The Devin account was re-authenticated.", "AbortError"));
    },
  });
  const authenticationFailed = (credential: Credential, error: unknown, generation: number) => {
    if (!isAuthenticationError(error)) return;
    auth.invalidate(credential, error, generation);
  };
  const source = createDevinModelSource({
    fusion: options.fusion,
    recommendedOnly: options.recommendedOnly,
    listsAllExactModels: options.listsAllExactModels,
    credentialFromHost: (credential) => credential?.type === "oauth" ? auth.credentialFromHost(credential) : undefined,
    fetchCatalog: async (credential, signal) => {
      const generation = auth.generation;
      auth.assertUsable(credential);
      const client = clientFor(credential);
      try {
        const catalog = await client.catalog(signal);
        applyTeamModelPolicy(catalog.models, await client.teamSettings(signal));
        return catalog;
      } catch (error) { authenticationFailed(credential, error, generation); throw error; }
      finally { client.transport.close(); }
    },
  });
  const infer = (model: Model<typeof DEVIN_API>, context: TranscriptContext, requestOptions: SimpleStreamOptions = {}) => {
    const effectiveLevel = (requestOptions.reasoning ?? clampThinkingLevel(model, "off")) as EffectiveThinkingLevel;
    const response = new DevinResponseStream(model, "");
    void (async () => {
      let client: DevinClient | undefined, lease: RequestLease | undefined;
      let credential: Credential | undefined;
      const accumulator = new ChatAccumulator();
      let actualUID = "", isRedacted = false;
      const generation = auth.generation;
      const signal = AbortSignal.any([lifetime.signal, ...(requestOptions.signal ? [requestOptions.signal] : [])]);
      try {
        signal.throwIfAborted();
        credential = { version: 1, sessionToken: requiredString(requestOptions.apiKey, "Devin account authentication (/login required)"), apiServerURL: endpoint(model.baseUrl), createdAt: new Date().toISOString() };
        // Pi can override the OAuth value with an apiKey in models.json or a caller option. Only OAuth sessions are accepted.
        auth.assertOAuthSession(credential);
        auth.assertUsable(credential);
        let selected = source.resolve(model.id, effectiveLevel, credential);
        actualUID = selected.uid;
        response.message.providerThinkingLevel = actualUID;
        if (requestOptions.maxRetries !== undefined && requestOptions.maxRetries !== 0) throw new Error("Devin uses Pi host retries. Only provider maxRetries 0 is supported.");
        if (requestOptions.transport && !["auto", "sse"].includes(requestOptions.transport)) throw new Error("Devin supports HTTP Connect streams only.");
        const cacheRetention = resolveCacheRetention(requestOptions);
        const assertCacheRetention = (selection: BackendModelSelection) => {
          if (cacheRetention === "long" && !hasExtendedPromptCacheRetention(selection.variant)) {
            throw new Error("Long cache lifetime is not confirmed for this Devin model. Long retention is supported only for models whose catalog Prompt Cache Retention is 24h.");
          }
        };
        assertCacheRetention(selected);
        // The per-request account check (permission and quota) runs here, outside Pi's shared credential lock.
        let account = accounts.get(catalogScope(credential));
        const probe = clientFor(credential, { profile: "login", fetch: requestOptions.fetch, timeoutMs: requestOptions.timeoutMs });
        try {
          const status = await probe.status(signal);
          signal.throwIfAborted();
          if (generation !== auth.generation) throw new DOMException("The Devin authentication generation changed.", "AbortError");
          auth.assertUsable(credential);
          rememberAccount(credential, requiredString(probe.accountIdentityHash, "Devin account scope"), status);
          account = accounts.get(catalogScope(credential));
        } catch (error) {
          // A check that cannot reach the server keeps the last known account; the model request reports its own failure.
          if (!account || signal.aborted || !isTransientConnectionFailure(error)) throw error;
        } finally { probe.transport.close(); }
        if (!account) throw new Error("The Devin account check was interrupted.");
        assertCanInfer(account.status);
        lease = await lifecycle.acquire(account.ownerHash, signal);
        const currentLease = lease;
        const transcript = toDevinTranscript(context, selected.model);
        if (isFusionModelID(model.id)) transcript.systemPrompt = [transcript.systemPrompt, FUSION_LEAD_GUIDANCE].filter(Boolean).join("\n\n");
        const maximum = requestOptions.maxTokens === undefined ? selected.model.maxOutputTokens : tokenCount(requestOptions.maxTokens, "maxTokens");
        if (maximum < 1 || maximum > selected.model.maxOutputTokens) throw new Error("The output limit is outside the selected Devin model range.");
        client = clientFor(credential, { fetch: requestOptions.fetch, timeoutMs: requestOptions.timeoutMs,
          onRequest: (attempt) => { if (attempt.isMetered) currentLease.consume(); },
        });
        currentLease.addCleanup(() => client!.transport.close());
        const request = chatRequest({ metadata: client.metadata(), model: selected.uid, ...transcript, maxTokens: maximum,
          cascadeId: lease.cascadeId, trajectoryId: lease.trajectoryId, stepIndex: lease.stepIndex,
          executionId: lease.executionId, clientSessionId: requestOptions.sessionId ?? lease.sessionId,
          isAuxiliary: lease.isAuxiliary, isRecovery: lease.isRecovery, includeContext: false,
        });
        if (requestOptions.temperature !== undefined) {
          if (!Number.isFinite(requestOptions.temperature) || requestOptions.temperature < 0) throw new Error("temperature must be a finite value of 0 or more.");
          object(request.configuration, "configuration").temperature = requestOptions.temperature;
        }
        if (cacheRetention === "none") for (const prompt of request.chatMessagePrompts as JsonObject[]) delete prompt.promptCacheOptions;
        const identity = JSON.stringify([request.cascadeId, request.trajectoryReference, request.executionId, request.clientSessionId]);
        for await (const _frame of client.transport.stream(CHAT_METHOD, request, lease.signal, {
          headers: requestOptions.headers,
          onPayload: async (payload, scopeSignal) => {
            const replacement = requestOptions.onPayload ? await awaitWithSignal(Promise.resolve(requestOptions.onPayload(payload, model)), scopeSignal) : undefined;
            const finalPayload = replacement === undefined ? payload : object(replacement, "provider payload");
            if (JSON.stringify([finalPayload.cascadeId, finalPayload.trajectoryReference, finalPayload.executionId, finalPayload.clientSessionId]) !== identity) {
              throw new Error("A payload hook cannot change the owned run, session or step identifiers.");
            }
            actualUID = requiredString(finalPayload.chatModelUid, "chatModelUid");
            if (actualUID !== selected.uid) {
              // An exact UID hidden from the list is re-resolved at that UID's level when the current catalog has it.
              if (!source.exactLevel(actualUID)) throw new Error("A payload hook selected an unavailable model UID.");
              selected = source.resolveUID(actualUID, credential!);
              toDevinTranscript(context, selected.model); // A model change re-checks existing image and tool limits.
              assertCacheRetention(selected);
            }
            const outputLimit = tokenCount(object(finalPayload.configuration, "configuration").maxTokens, "maxTokens");
            if (outputLimit < 1 || outputLimit > selected.model.maxOutputTokens) throw new Error("The payload hook output limit is outside the model range.");
            response.message.providerThinkingLevel = actualUID;
            return finalPayload;
          },
          onResponse: async (info, scopeSignal) => {
            if (info.status === 401) authenticationFailed(credential!, new RPCError("unauthenticated", "HTTP 401", 401), generation);
            if (requestOptions.onResponse) await awaitWithSignal(Promise.resolve(requestOptions.onResponse(info, model)), scopeSignal);
          },
          onFrame: async (frame, scopeSignal) => {
            if (requestOptions.onProviderStreamEvent) await awaitWithSignal(Promise.resolve(requestOptions.onProviderStreamEvent(structuredClone(frame.data), model)), scopeSignal);
            if (frame.isEnd && frame.data.error) return; // Connect error classification belongs to the transport.
            if (frame.data.redact === true) { isRedacted = true; response.redact(); }
            accumulator.accept(frame.data, frame.isEnd);
            if (!frame.isEnd) response.accept(frame.data, accumulator);
          },
        })) { /* A frame handling failure also ends the request inside the transport first. */ }
        const result = accumulator.finish();
        result.message.modelUid = actualUID;
        response.finish(result);
      } catch (error) {
        if (credential) authenticationFailed(credential, error, generation);
        accumulator.message.modelUid = actualUID || undefined;
        response.fail(hostRetryableMessage(error, safeError(error, credential ? [credential.sessionToken] : [])), error instanceof Error && error.name === "AbortError", isRedacted ? undefined : accumulator.message);
      } finally { client?.transport.close(); lease?.release(); }
    })();
    return response.stream;
  };
  return {
    id: "devin", name: "Devin", auth: { oauth: auth }, lifecycle,
    getModels: source.getModels, filterModels: source.filterModels,
    getFusionChoices: source.getFusionChoices, rebuildModels: source.rebuildModels,
    getAccountUsage: () => latestUsage ? { ...latestUsage } : undefined,
    refreshModels: (context) => source.refreshModels({ ...context, signal: AbortSignal.any([context.signal, lifetime.signal]) }),
    stream: (model, context, requestOptions) => infer(model, context, requestOptions), streamSimple: (model, context, requestOptions) => infer(model, context, requestOptions),
    attachSession(binding) {
      if (lifetime.signal.aborted) lifetime = new AbortController();
      lifecycle.attach(binding);
    },
    shutdown() {
      lifetime.abort(new DOMException("The Devin provider shut down.", "AbortError"));
      lifecycle.shutdown();
      for (const client of [...clients]) client.transport.close();
      fingerprints.clear(); accounts.clear(); latestUsage = undefined;
    },
  };
}
