import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionRuntime } from "../../app/runtime.ts";
import type { DevinAPI } from "../../features/catalog/types.ts";

/** Pi's provider contract, and nothing else: extension features reach the services through the runtime. */
export interface DevinProvider extends Provider<DevinAPI> {
  refreshModels: NonNullable<Provider<DevinAPI>["refreshModels"]>;
}

/** A registered extension instance: the provider Pi holds and the runtime its handlers run on. */
export interface DevinExtension {
  readonly provider: DevinProvider;
  readonly runtime: ExtensionRuntime;
}
