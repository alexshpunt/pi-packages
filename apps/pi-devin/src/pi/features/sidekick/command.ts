import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { toDevinError, type DevinError } from "../../../core/errors.ts";
import type { SidekickCommand, SidekickLaunch } from "./types.ts";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** This package root. Passed to the child Pi with `-e` so it uses the same extension copy as the lead. Pi loads a path only once. */
export const PACKAGE_ROOT = dirname(fileURLToPath(new URL("../../../../package.json", import.meta.url)));


function piPackageRoot(start: string): string | undefined {
  let directory = dirname(start);
  while (directory !== dirname(directory)) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      try { if ((JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name === PI_PACKAGE) return directory; } catch { /* try the next parent */ }
    }
    directory = dirname(directory);
  }
  return undefined;
}

const EXTENSION_FLAGS = new Set(["-e", "--extension"]);
const EXTENSION_SWITCHES = new Set(["--no-extensions", "-ne", "--no-mcp"]);

/**
 * Passes only the extension selection from the lead CLI arguments to the child, so tools from extensions loaded only with `-e` work for the sidekick too.
 * Local paths become absolute paths from the lead's working directory. Source specifiers such as `builtin:` and `npm:` stay as they are.
 */
export function extensionArgs(argv: readonly string[], cwd: string): string[] {
  const forwarded: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (EXTENSION_SWITCHES.has(value)) forwarded.push(value);
    else if (EXTENSION_FLAGS.has(value) && index + 1 < argv.length) {
      const target = argv[++index];
      forwarded.push("-e", /^[a-z][a-z0-9+.-]*:/i.test(target) || isAbsolute(target) ? target : resolve(cwd, target));
    }
  }
  return forwarded;
}

function findPiCommand(): SidekickCommand {
  const candidates: { path: string; isRunningCLI: boolean }[] = [];
  try { if (process.argv[1]) candidates.push({ path: realpathSync(process.argv[1]), isRunningCLI: true }); } catch { /* missing path */ }
  try { candidates.push({ path: fileURLToPath(import.meta.resolve(PI_PACKAGE)), isRunningCLI: false }); } catch { /* cannot resolve */ }
  for (const candidate of candidates) {
    const root = piPackageRoot(candidate.path);
    if (!root) continue;
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
    if (bin && existsSync(join(root, bin))) {
      const execArgv = process.execArgv.filter((value) => !/^--(inspect|debug)/.test(value));
      const forwarded = candidate.isRunningCLI ? extensionArgs(process.argv.slice(2), process.cwd()) : [];
      return { command: process.execPath, args: [...execArgv, join(root, bin), ...forwarded] };
    }
  }
  throw new Error("Could not find a Pi CLI to run the sidekick.");
}

/**
 * Starts the child with the same Node, exec options and Pi CLI as the lead Pi. The running CLI is preferred so extension selection arguments carry over;
 * when Pi is embedded through the SDK, the installed Pi package's bin is used. Inspect options are not passed, to avoid port conflicts.
 */
export const resolvePiCommand: Effect.Effect<SidekickCommand, DevinError> = Effect.try({ try: findPiCommand, catch: toDevinError });

export function launchArgs(launch: SidekickLaunch, packageRoot: string): string[] {
  return [
    "--mode", "rpc",
    ...(launch.sessionFile ? ["--session", launch.sessionFile] : ["--no-session"]),
    "--model", `devin/${launch.modelID}`,
    ...(launch.thinking ? ["--thinking", launch.thinking] : []),
    "--append-system-prompt", launch.systemPrompt,
    "-e", packageRoot,
    ...(launch.tools.length ? ["--tools", launch.tools.join(",")] : ["--no-tools"]),
  ];
}
