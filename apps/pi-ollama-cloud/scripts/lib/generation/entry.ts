import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCredential } from "../../../src/auth/resolver.ts";
import { MODEL_MAX_OUTPUT_TOKENS } from "../../../src/generated/limits.generated.ts";
import { fetchModelIds } from "../../../src/models/api.ts";
import { probeMaxTokens } from "./limits.ts";
import { generateCatalog, generateLimits } from "./pipeline.ts";

const defaultOutputDir = fileURLToPath(new URL("../../../src/generated/", import.meta.url));
interface Options {
  outputDir: string;
  isDryRun: boolean;
  hasHelp: boolean;
  targetId?: string;
}
function parseArgs(args: string[], isLimits: boolean): Options {
  const options: Options = { outputDir: defaultOutputDir, isDryRun: false, hasHelp: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--dry-run") options.isDryRun = true;
    else if (arg === "--help") options.hasHelp = true;
    else if (arg === "--output-dir") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("--output-dir requires a directory.");
      options.outputDir = resolve(value);
    } else if (isLimits && !arg.startsWith("-") && options.targetId === undefined) options.targetId = arg;
    else throw new Error(`Unknown generator argument: ${arg}`);
  }
  return options;
}
export async function runGeneration(kind: "catalog" | "limits", args = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args, kind === "limits");
  if (options.hasHelp) {
    console.log(
      kind === "catalog"
        ? "Usage: generate-models [--dry-run] [--output-dir <directory>]. All catalog/pricing/reasoning entrypoints validate and replace one complete snapshot."
        : "Usage: generate-limits [model-id] [--dry-run] [--output-dir <directory>]. WARNING: probes are billable even with --dry-run.",
    );
    return;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(new DOMException("Generation canceled", "AbortError"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (kind === "catalog") {
      const result = await generateCatalog({ ...options, signal: controller.signal });
      console.log(
        `${result.isWritten ? "Wrote" : "Dry run:"} ${result.path}: ${result.catalog.models.length} models; unknown prices ${result.catalog.info.unknownPricingIds.length}, unmeasured limits ${result.catalog.info.unknownLimitIds.length}.`,
      );
    } else {
      const { apiKey } = await resolveCredential(controller.signal);
      if (!apiKey) throw new Error("No Ollama Cloud API key found.");
      const ids = options.targetId ? [options.targetId] : await fetchModelIds(controller.signal);
      const result = await generateLimits({
        ...options,
        ids,
        existing: MODEL_MAX_OUTPUT_TOKENS,
        signal: controller.signal,
        probe: (id, signal) => probeMaxTokens(id, apiKey, signal),
      });
      console.log(
        `${result.isWritten ? "Wrote" : "Dry run:"} ${result.path}: ${Object.keys(result.info.measurements).length} measurements; preserved ${result.info.preservedIds.length}, unknown ${result.info.unknownIds.length}. Highest accepted tiers are lower bounds, not exact maxima.`,
      );
    }
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
