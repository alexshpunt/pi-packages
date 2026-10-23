import type { ProviderRuntime } from "../../app/runtime.ts";
import { ModelCatalog } from "../../features/catalog/service.ts";
import { Inference } from "../../features/inference/service.ts";
import { makeOAuthAuth } from "./oauth.ts";
import type { DevinProvider } from "./types.ts";

/**
 * The provider Pi registers. Building it builds the runtime's layers, which perform no I/O; work starts with Pi's first refresh or request.
 * Pi's synchronous calls run synchronous effects; `stream` returns at once while the request runs in a fiber the inference service owns.
 */
export function makeDevinProvider(runtime: ProviderRuntime): DevinProvider {
  const catalog = runtime.runSync(ModelCatalog);
  const inference = runtime.runSync(Inference);
  return {
    id: "devin", name: "Devin", auth: { oauth: makeOAuthAuth(runtime) },
    getModels: () => runtime.runSync(catalog.models),
    filterModels: (models, credential) => runtime.runSync(catalog.filter(models, credential)),
    refreshModels: (context) => runtime.runPromise(catalog.refresh(context)),
    stream: (model, context, options) => runtime.runSync(inference.start(model, context, options)),
    streamSimple: (model, context, options) => runtime.runSync(inference.start(model, context, options)),
  };
}
