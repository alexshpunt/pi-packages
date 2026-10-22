import { Context, Effect, Layer } from "effect";
import { makeDevinClient, type DevinClient } from "../../../core/client.ts";
import { makeFingerprintProvider, type FingerprintProvider } from "../../../core/protocol/fingerprint.ts";
import { DeviceIdentitySource } from "../../../core/services/device-identity.ts";
import { fetchTransport, HttpTransport } from "../../../core/services/http-transport.ts";
import type { Credential } from "../../../core/types.ts";
import { evictOldest } from "../bounded.ts";
import { catalogScope } from "../catalog/projection.ts";
import type { DevinClientsShape } from "./types.ts";

/**
 * Clients of one provider. A credential's device fingerprint is collected once and shared by its clients;
 * every open client is tracked so shutdown can stop in-flight requests. Each client still has its own connection pool.
 */
export class DevinClients extends Context.Service<DevinClients, DevinClientsShape>()("pi-devin/DevinClients") {}

export const DevinClientsLive = Layer.effect(DevinClients, Effect.gen(function* () {
  const transport = yield* HttpTransport;
  const device = yield* DeviceIdentitySource;
  const fingerprints = new Map<string, FingerprintProvider>();
  const clients = new Set<DevinClient>();

  const fingerprintFor = (credential: Credential) => Effect.suspend(() => {
    const key = catalogScope(credential);
    const cached = fingerprints.get(key);
    if (cached) return Effect.succeed(cached);
    evictOldest(fingerprints, 16);
    return Effect.tap(makeFingerprintProvider(credential.sessionToken, { collectIdentity: device.collect }), (created) => Effect.sync(() => {
      fingerprints.set(key, created);
    }));
  });

  return {
    open: (credential, options = {}) => Effect.gen(function* () {
      const { fetch, ...clientOptions } = options;
      const client = yield* makeDevinClient(credential, { ...clientOptions, fingerprint: yield* fingerprintFor(credential) }).pipe(
        Effect.provideService(HttpTransport, fetch ? fetchTransport(fetch) : transport),
        Effect.provideService(DeviceIdentitySource, device),
      );
      clients.add(client);
      yield* Effect.addFinalizer(() => Effect.sync(() => { clients.delete(client); }));
      return client;
    }),
    closeAll: Effect.suspend(() => Effect.forEach([...clients], (client) => client.close, { discard: true })),
    clearFingerprints: Effect.sync(() => fingerprints.clear()),
  } satisfies DevinClientsShape;
}));
