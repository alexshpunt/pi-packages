import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));
/** Format stdin before commit; never rewrite the published snapshot in place. */
export function formatGeneratedSource(source: string, filename: string): string {
  try {
    return execFileSync(
      process.execPath,
      [require.resolve("@biomejs/biome/bin/biome"), "format", "--stdin-file-path", filename],
      {
        cwd: packageRoot,
        input: source,
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch {
    throw new Error("Generated source formatting failed; previous snapshot kept.");
  }
}
