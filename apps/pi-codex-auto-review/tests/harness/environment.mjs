// Vitest setup file: runs before Pi imports in each isolated test process.
// Provider discovery only sees synthetic configuration explicitly supplied by fixtures.
// Vitest's own worker variables (`VITEST*`) stay so the runner keeps working.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { environmentKeys } from "./shell.mjs";

const parentTmp = tmpdir();
const keep = [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TERM",
    "TMPDIR",
    "NODE_CHANNEL_FD",
    "NODE_CHANNEL_SERIALIZATION_MODE",
    "PI_GUARD_RUN_DIR",
    "PI_GUARD_KERNEL_ARCH",
];
// Windows names are case-insensitive (`Path`); Git Bash, PowerShell and Node need the system set.
const isKept = environmentKeys(keep);
for (const key of Object.keys(process.env))
    if (!isKept(key) && !key.startsWith("VITEST")) delete process.env[key];
// Exercise the ambient temporary-root contract without scanning unrelated host worktrees.
const suiteTmp = mkdtempSync(join(parentTmp, "pi-guard-suite-"));
process.env.TMPDIR = suiteTmp;
process.env.TMP = suiteTmp;
process.env.TEMP = suiteTmp;
process.once("exit", () => rmSync(suiteTmp, { recursive: true, force: true }));
