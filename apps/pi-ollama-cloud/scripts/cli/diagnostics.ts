import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { VerificationFeature } from "./verification.ts";

/** Fixture diagnostics must not alter the interactive parent's environment, theme or signal handlers. */
export async function runDiagnostic(feature: VerificationFeature, signal: AbortSignal): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ollama-diagnostic-"));
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", feature.cli, "--offline"], {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        stdio: "inherit",
        signal,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: join(directory, "agent"),
          TMPDIR: directory,
          OLLAMA_API_KEY: "",
          OLLAMA_API_BASE: "",
          PI_OFFLINE: "1",
        },
      });
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`검증 종료 코드: ${code ?? "signal"}`)),
      );
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
