import { type ChildProcess, fork } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function waitForMessage(child: ChildProcess, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Cache worker timeout: ${event}`)), 15000);
    function finish(error?: Error) {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    }
    function onError(error: Error) {
      finish(error);
    }
    function onExit() {
      finish(new Error(`Cache worker exited before ${event}`));
    }
    function onMessage(message: unknown) {
      if (typeof message !== "object" || message === null || !("event" in message)) return;
      if (message.event === "error") finish(new Error("Cache worker failed"));
      else if (message.event === event) finish();
    }
    child.on("message", onMessage);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}
function startWorker(path: string, key: string, fixture: string) {
  const child = fork(fileURLToPath(new URL(fixture, import.meta.url)), [path, key], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    execArgv: ["--import", "tsx"],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: join(dirname(path), key),
      PI_OFFLINE: "1",
      OLLAMA_API_KEY: "",
      OLLAMA_API_BASE: "",
      PI_OLLAMA_SEARCH_CACHE_PATH: path,
      PI_OLLAMA_WEB_TOOLS: "1",
    },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  return {
    ready: waitForMessage(child, "ready"),
    async write() {
      const done = waitForMessage(child, "done");
      child.send("write");
      await done;
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
      });
    },
  };
}
export async function writeFromTwoProcesses(
  path: string,
  isConcurrent = false,
  fixture = "../../test/fixtures/cache-worker.ts",
): Promise<void> {
  const first = startWorker(path, "first", fixture);
  const second = startWorker(path, "second", fixture);
  try {
    await Promise.all([first.ready, second.ready]);
    if (isConcurrent) await Promise.all([first.write(), second.write()]);
    else {
      await first.write();
      await second.write();
    }
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
}
