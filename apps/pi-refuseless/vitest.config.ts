import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * REFUSELESS_PI_SDK=<directory of an installed @earendil-works/pi-coding-agent> runs the tests on that Pi
 * instead of the workspace development copy. `cli verify` sets it to the `pi` on PATH.
 */
const sdk = process.env.REFUSELESS_PI_SDK;

/** Entry of a package that `sdk` depends on: nested under it, or beside it in the same node_modules. */
function dependencyEntry(name: string): string {
  for (const dir of [join(sdk!, "node_modules", name), join(dirname(dirname(sdk!)), name)]) {
    const entry = join(dir, "dist", "index.js");
    if (existsSync(entry)) return entry;
  }
  throw new Error(`${name} not found beside ${sdk}`);
}

export default defineConfig({
  resolve: sdk
    ? {
        alias: [
          { find: /^@earendil-works\/pi-coding-agent$/, replacement: join(sdk, "dist", "index.js") },
          { find: /^@earendil-works\/pi-tui$/, replacement: dependencyEntry("@earendil-works/pi-tui") },
        ],
      }
    : {},
});
