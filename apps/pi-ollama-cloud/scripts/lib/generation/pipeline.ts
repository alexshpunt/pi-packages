import { join } from "node:path";
import { type GenerationWriter, replaceGeneratedFile } from "./atomic.ts";
import { type CollectCatalogOptions, collectCatalog } from "./catalog.ts";
import { formatGeneratedSource } from "./format.ts";
import { collectLimits, type LimitProbe } from "./limits.ts";
import { renderCatalog, renderLimits } from "./render.ts";

export const CATALOG_SNAPSHOT_FILE = "catalog.generated.ts";
export interface GenerateLimitsOptions {
  ids: string[];
  existing: Readonly<Record<string, number>>;
  probe: LimitProbe;
  outputDir: string;
  signal?: AbortSignal;
  isDryRun?: boolean;
  writer?: GenerationWriter;
  measurementStartedAt?: string;
}
export async function generateLimits(options: GenerateLimitsOptions) {
  const result = await collectLimits(
    options.ids,
    options.existing,
    options.probe,
    options.signal,
    options.measurementStartedAt,
  );
  const source = formatGeneratedSource(renderLimits(result), "limits.generated.ts");
  const path = join(options.outputDir, "limits.generated.ts");
  options.signal?.throwIfAborted();
  if (!options.isDryRun) replaceGeneratedFile(path, source, options.signal, options.writer);
  return { ...result, source, path, isWritten: !options.isDryRun };
}
export interface GenerateCatalogOptions extends CollectCatalogOptions {
  outputDir: string;
  isDryRun?: boolean;
  writer?: GenerationWriter;
}
export async function generateCatalog(options: GenerateCatalogOptions) {
  const catalog = await collectCatalog(options);
  const source = formatGeneratedSource(renderCatalog(catalog), CATALOG_SNAPSHOT_FILE);
  const path = join(options.outputDir, CATALOG_SNAPSHOT_FILE);
  options.signal?.throwIfAborted();
  if (!options.isDryRun) replaceGeneratedFile(path, source, options.signal, options.writer);
  return { catalog, source, path, isWritten: !options.isDryRun };
}
