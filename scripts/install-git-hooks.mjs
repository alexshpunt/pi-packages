import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// A source archive has no repository configuration to update.
if (existsSync(".git")) {
  const current = spawnSync("git", ["config", "--get", "core.hooksPath"], { encoding: "utf8" });
  if (current.status === 1 && !current.error) {
    const install = spawnSync("git", ["config", "--local", "core.hooksPath", ".githooks"], {
      stdio: "inherit",
    });
    if (install.status !== 0) throw install.error ?? new Error("Could not install Git hooks.");
  } else if (current.status !== 0) {
    throw current.error ?? new Error(current.stderr.trim());
  } else if (current.stdout.trimEnd() !== ".githooks") {
    console.warn("Existing core.hooksPath kept; the repository pre-commit hook was not installed.");
  }
}
