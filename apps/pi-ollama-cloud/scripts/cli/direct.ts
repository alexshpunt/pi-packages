import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Importing a feature must not start prompts, requests or file writes. */
export function isDirectRun(moduleURL: string): boolean {
  return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(moduleURL);
}
export function runDirect(moduleURL: string, run: () => Promise<void>): void {
  if (!isDirectRun(moduleURL)) return;
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
