import { spawn } from "node:child_process";
import { Context, Layer } from "effect";
import { PACKAGE_ROOT, resolvePiCommand } from "./command.ts";
import type { SidekickLauncherShape } from "./types.ts";

/** How sidekick child Pi processes start. */
export class SidekickLauncher extends Context.Service<SidekickLauncher, SidekickLauncherShape>()("pi-devin/SidekickLauncher") {}

/** The same Node and Pi CLI as the lead, this process's environment and this package's own copy. */
export const NodeSidekickLauncher = Layer.sync(SidekickLauncher, () => ({
  resolveCommand: resolvePiCommand, spawn, env: process.env, packageRoot: PACKAGE_ROOT,
} satisfies SidekickLauncherShape));
