import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDirect } from "./cli/direct.ts";
import { runLiveVerification } from "./lib/verification/live.ts";

runDirect(import.meta.url, async () => {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--package-dir"))
    throw new Error("Usage: smoke:web-tools [--package-dir <extracted-package>]. Uses one live search and fetch.");
  const packageDir = args.length ? resolve(args[1]) : fileURLToPath(new URL("../", import.meta.url));
  const report = await runLiveVerification({ packageDir, includeChat: false, signal: new AbortController().signal });
  if (report.status !== "pass")
    throw new Error(`Web tools smoke failed (${report.checks.at(-1)?.observed.category ?? "unknown"}); not retried.`);
  console.log("PASS: registered web tools, bounded output, and retained cache replay.");
});
