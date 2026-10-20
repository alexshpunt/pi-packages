import { join } from "node:path";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { getAgentDir, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { createCatalogDiagnosticsStore } from "./catalog-diagnostics.ts";
import { createCatalogService } from "./catalog-service.ts";

let active: { path: string; service: ReturnType<typeof createCatalogService> } | undefined;
function currentCatalog() {
  const path = join(getAgentDir(), "cache", "pi-ollama-cloud", "catalog-state.json");
  if (active?.path !== path)
    active = { path, service: createCatalogService({ diagnostics: createCatalogDiagnosticsStore(path) }) };
  return active.service;
}

/** Pi calls restore before auth; only a resolved credential enables its network phase. */
export async function refreshOllamaCatalog(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
  return currentCatalog().refresh(context);
}
export function getCatalogDiagnostics() {
  return currentCatalog().getDiagnostics();
}
