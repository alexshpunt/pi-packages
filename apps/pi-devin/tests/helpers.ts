import { gunzipSync } from "node:zlib";
import { Effect, Scope, Stream, type Layer } from "effect";
import { abortWith, whenAborted } from "../src/core/cancellation.ts";
import { toDevinFailure } from "../src/core/errors.ts";
import { NodePlatformLayer } from "../src/core/services/platform.ts";
import { login, loginAccount, type LoginOptions } from "../src/core/auth/login.ts";
import { makeDevinClient, type DevinClient, type DevinClientOptions } from "../src/core/client.ts";
import { makeConnectClient, type ConnectClient, type ConnectClientOptions } from "../src/core/protocol/connect-client.ts";
import { makeFingerprintProvider } from "../src/core/protocol/fingerprint.ts";
import type { HTTPTransportOptions } from "../src/core/protocol/http.ts";
import type { DeviceIdentity } from "../src/core/protocol/device.ts";
import { DeviceIdentitySource } from "../src/core/services/device-identity.ts";
import { fetchTransport, HttpTransport, nodeTransport } from "../src/core/services/http-transport.ts";
import { encodeFrame } from "../src/core/protocol/frames.ts";
import { CHAT_METHOD, chatRequestCodec, chatResponseCodec, unaryCodecs } from "../src/core/protocol/protobuf.ts";
import type { Credential, JsonObject, ModelInfo } from "../src/core/types.ts";

export const STATUS_METHOD = "exa.seat_management_pb.SeatManagementService/GetUserStatus";
export const MODELS_METHOD = "exa.api_server_pb.ApiServerService/GetCliModelConfigs";
export const credential: Credential = {
  version: 1, sessionToken: "mock-offline-token", apiServerURL: "https://example.invalid", createdAt: "2026-01-01T00:00:00.000Z",
};
export const identity = { serial: "OFFLINE-SERIAL", macs: [], username: "offline-user" };
export const fingerprint = () => runSync(makeFingerprintProvider(credential.sessionToken, { collectIdentity: Effect.succeed(identity) }));
export const model: ModelInfo = {
  id: "swe-2-medium", name: "SWE-2 Medium", contextWindow: 131072, maxOutputTokens: 128000,
  supportsThinking: true, supportsImages: true, supportsToolCalls: true, supportsParallelToolCalls: true,
  isRouter: false, isDisabled: false, familyId: "swe-2", aliases: ["fixture-alias"],
};

/** Runs an effect as a promise; a caller signal fails it with the signal's reason, as host boundaries do. */
export function run<A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> {
  return Effect.runPromise(effect.pipe(abortWith(signal)));
}
export const runSync = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(effect);
/** Runs with the Node file system and process services, as the CLI does. */
export function runNode<A, E, R extends Layer.Success<typeof NodePlatformLayer>>(effect: Effect.Effect<A, E, R>, signal?: AbortSignal): Promise<A> {
  return run(effect.pipe(Effect.provide(NodePlatformLayer)) as Effect.Effect<A, E>, signal);
}

/** Wraps a promise-returning test callback; its signal aborts when the effect is interrupted. */
export const fromAsync = <A>(evaluate: (signal: AbortSignal) => A | PromiseLike<A>) =>
  Effect.tryPromise({ try: async (signal) => await evaluate(signal), catch: toDevinFailure });

/** How a test reaches the network: an injected fetch, or the built-in Node transport with optional TLS settings. */
export interface TransportChoice {
  fetch?: typeof fetch;
  http?: HTTPTransportOptions;
}
export const transportOf = (choice: TransportChoice = {}) => choice.fetch ? fetchTransport(choice.fetch) : nodeTransport(choice.http);
/** Provides the chosen transport and fixed device values, as an extension or the CLI would provide theirs. */
export const withTransport = (choice: TransportChoice = {}, device: Effect.Effect<DeviceIdentity> = Effect.succeed(identity)) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
    Effect.provideService(HttpTransport, transportOf(choice)),
    Effect.provideService(DeviceIdentitySource, { collect: device }),
  );

/** Sign-in with a test transport: `fetch` reaches the code exchange, as a host-injected fetch would. */
export const accountLogin = (options: LoginOptions & TransportChoice) => {
  const { fetch, http, ...rest } = options;
  return loginAccount(rest).pipe(withTransport({ fetch, http }));
};
export const legacyLogin = (options: LoginOptions & TransportChoice) => {
  const { fetch, http, ...rest } = options;
  return login(rest).pipe(withTransport({ fetch, http }));
};

/** A long-lived client for a test. It lives until `close`. */
export function connectClient(options: ConnectClientOptions & TransportChoice): ConnectClient {
  const { fetch, http, ...rest } = options;
  return Effect.runSync(makeConnectClient(rest).pipe(withTransport({ fetch, http }), Scope.provide(Effect.runSync(Scope.make()))));
}
export function devinClient(value: Credential, options: DevinClientOptions & TransportChoice & { device?: Effect.Effect<DeviceIdentity> } = {}): DevinClient {
  const { fetch, http, device, ...rest } = options;
  return Effect.runSync(makeDevinClient(value, rest).pipe(withTransport({ fetch, http }, device), Scope.provide(Effect.runSync(Scope.make()))));
}
export const close = (client: { close: Effect.Effect<void> } | { transport: { close: Effect.Effect<void> } }) =>
  Effect.runSync("close" in client ? client.close : client.transport.close);

/** Collects every element, failing like the stream does. */
export const collect = <A, E>(stream: Stream.Stream<A, E>, signal?: AbortSignal): Promise<A[]> => run(Stream.runCollect(stream), signal);
/** Fails the stream with the signal's reason once it aborts. */
export const abortStream = (signal: AbortSignal) => <A, E>(stream: Stream.Stream<A, E>) => Stream.interruptWhen(stream, whenAborted(signal));
/** Pulls a stream one element at a time, like an async iterator. */
export const iterate = <A, E>(stream: Stream.Stream<A, E>): AsyncIterator<A> => Stream.toAsyncIterable(stream)[Symbol.asyncIterator]();

export const frameBytes = (bytes: Uint8Array, flags = 0): Buffer => runSync(encodeFrame(bytes, flags));
export const encodeResponse = (frame: JsonObject): Uint8Array => runSync(chatResponseCodec.encode(frame));

export function streamResponse(frames: JsonObject[]): Response {
  return new Response(new Uint8Array(Buffer.concat([
    ...frames.map((frame) => frameBytes(encodeResponse(frame))), frameBytes(Buffer.from("{}"), 2),
  ])), { headers: { "content-type": "application/connect+proto" } });
}
export function errorStreamResponse(code: string, message: string, frames: JsonObject[] = []): Response {
  return new Response(new Uint8Array(Buffer.concat([
    ...frames.map((frame) => frameBytes(encodeResponse(frame))),
    frameBytes(Buffer.from(JSON.stringify({ error: { code, message } })), 2),
  ])), { headers: { "content-type": "application/connect+proto" } });
}

export function finalFrames(text = "OK"): JsonObject[] {
  return [{ messageId: "bot-response", deltaText: text }, { stopReason: "STOP_REASON_STOP_PATTERN" }, { usage: { inputTokens: 3, outputTokens: 2 } }];
}
export function unaryResponse(method: string, body: JsonObject): Response {
  return new Response(new Uint8Array(runSync(Effect.flatMap(unaryCodecs(method), (codecs) => codecs.response.encode(body)))), { headers: { "content-type": "application/proto" } });
}
export function requestBody(method: string, init: { body?: unknown }): JsonObject {
  const bytes = Buffer.from(init.body as Uint8Array);
  return runSync(method === CHAT_METHOD ? chatRequestCodec.decode(bytes[0] & 1 ? gunzipSync(bytes.subarray(5)) : bytes.subarray(5))
    : Effect.flatMap(unaryCodecs(method), (codecs) => codecs.request.decode(bytes)));
}
export function modelResponse(): JsonObject {
  return {
    clientModelConfigs: [{ modelUid: model.id, label: model.name, supportsImages: true,
      modelInfo: { modelUid: model.id, modelFamilyUid: model.familyId, aliases: model.aliases,
        maxTokens: model.contextWindow, maxOutputTokens: model.maxOutputTokens,
        modelFeatures: { supportsImages: true, supportsToolCalls: true, supportsParallelToolCalls: true, supportsThinking: true } } }],
    defaultOverrideModelConfig: { modelUid: model.id },
  };
}
export function statusResponse(restBaseURL?: string): JsonObject {
  return { userStatus: { userId: "offline-user-id", planStatus: {
    planInfo: { billingStrategy: "BILLING_STRATEGY_QUOTA", devinInfo: { canUseCli: true, orgId: "offline-org", ...(restBaseURL ? { apiUrl: restBaseURL } : {}) } },
    dailyQuotaRemainingPercent: 100, weeklyQuotaRemainingPercent: 100,
  } } };
}
/** Lets queued fibers and promise callbacks run. */
export const settle = async (rounds = 5) => { for (let index = 0; index < rounds; index++) await new Promise((resolve) => setImmediate(resolve)); };
