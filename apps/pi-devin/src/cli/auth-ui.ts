import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { awaitWithSignal } from "../core/protocol/transport.ts";

export function openLoginURL(url: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (process.platform !== "darwin") return Promise.reject(new Error("Opening the browser automatically is supported on macOS only. Open the shown URL yourself."));
  return new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/open", [url], { stdio: "ignore", signal });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error("Could not open the browser. Open the shown URL yourself.")));
  });
}

/** Does not echo input. The code value never goes into logs, errors or structured events. */
export async function readAuthorizationCode(signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (process.stdin.readableEnded) throw new Error("Authorization code input ended.");
  process.stderr.write("Paste the authorization code or callback URL from the browser (input is hidden): ");
  const silentOutput = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const input = createInterface({ input: process.stdin, output: silentOutput, terminal: Boolean(process.stdin.isTTY) });
  let onClose!: () => void;
  const closed = new Promise<never>((_resolve, reject) => { onClose = () => reject(new Error("Authorization code input ended.")); input.once("close", onClose); });
  try { return await awaitWithSignal(Promise.race([input.question("", { signal }), closed]), signal); }
  finally { input.off("close", onClose); input.close(); silentOutput.end(); process.stderr.write("\n"); }
}
