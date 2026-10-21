// Vitest setup: every test process reads settings from a disposable agent directory,
// never from the developer's ~/.pi/agent.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const suiteRoot = mkdtempSync(join(tmpdir(), "pi-redact-suite-"));
process.env.PI_CODING_AGENT_DIR = join(suiteRoot, "agent");
process.once("exit", () => rmSync(suiteRoot, { recursive: true, force: true }));
