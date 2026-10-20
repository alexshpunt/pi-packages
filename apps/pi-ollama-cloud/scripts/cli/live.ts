import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runLiveVerification } from "../lib/verification/live.ts";
import { runDirect } from "./direct.ts";

runDirect(import.meta.url, async () => {
  const args = process.argv.slice(2);
  if (args.length !== 5 || args[0] !== "--live-minimal" || args[1] !== "--package-dir" || args[3] !== "--report")
    throw new Error(
      "Usage: --live-minimal --package-dir <extracted-package> --report <new-report.json>. One chat/search/fetch; no retries.",
    );
  const path = resolve(args[4]);
  if (existsSync(path)) throw new Error("Live report already exists; refusing to repeat a one-shot run.");
  mkdirSync(dirname(path), { recursive: true });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const report = await runLiveVerification({
      packageDir: resolve(args[2]),
      includeChat: true,
      signal: controller.signal,
      record: (value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }),
    });
    console.log(JSON.stringify({ status: report.status, apiCallCounts: report.apiCallCounts, checks: report.checks }));
    if (report.status !== "pass") process.exitCode = 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
});
