import { Context, Effect, Layer } from "effect";
import { applyTeamModelPolicy } from "../../../core/models/access.ts";
import { DevinClients } from "../clients/service.ts";
import type { RemoteCatalogShape } from "./types.ts";

/** The remote side of the catalog query: one lookup of the catalog and the team settings for a credential. */
export class RemoteCatalog extends Context.Service<RemoteCatalog, RemoteCatalogShape>()("pi-devin/RemoteCatalog") {}

export const RemoteCatalogLive = Layer.effect(RemoteCatalog, Effect.map(DevinClients, (clients) => ({
  fetch: (credential) => Effect.scoped(Effect.gen(function* () {
    const client = yield* clients.open(credential);
    const catalog = yield* client.catalog;
    return { ...catalog, models: applyTeamModelPolicy(catalog.models, yield* client.teamSettings) };
  })),
} satisfies RemoteCatalogShape)));
