import { runDirect } from "./cli/direct.ts";
import { runCLI } from "./cli/runner.ts";

runDirect(import.meta.url, runCLI);
