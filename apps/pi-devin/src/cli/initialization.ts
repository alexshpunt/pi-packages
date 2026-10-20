import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { arch, release, type as osType } from "node:os";
import { credentialPath } from "./credentials.ts";
import { CLIENT_VERSION, DevinClient } from "../core/client.ts";
import { assertCanInfer } from "../core/auth/access.ts";
import { applyTeamModelPolicy } from "../core/models/access.ts";
import { isAuthenticationError, safeError } from "../core/protocol/transport.ts";
import type { JsonObject, ModelInfo } from "../core/types.ts";

export async function installationId(): Promise<string> {
  const path = join(dirname(credentialPath()), "installation-id");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, randomUUID() + "\n", { flag: "wx", mode: 0o600 });
    try { await link(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { await rm(temporary, { force: true }); }
  if ((await stat(path)).size > 128) throw new Error("Invalid installation ID file.");
  const value = (await readFile(path, "utf8")).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new Error("Invalid installation ID format.");
  return value;
}

export async function initializeClient(client: DevinClient, options: {
  signal?: AbortSignal; expectedUserId?: string; expectedOwnerHash?: string;
  onWarning?: (message: string) => void;
} = {}): Promise<{ models: ModelInfo[]; status: JsonObject; auxiliary: JsonObject }> {
  const status = await client.status(options.signal, options.expectedUserId);
  assertCanInfer(status);
  if (options.expectedOwnerHash && client.accountIdentityHash !== options.expectedOwnerHash) throw new Error("A session of a different account cannot be sent.");
  const models = await client.models(options.signal);
  const team = await client.teamSettings(options.signal);
  applyTeamModelPolicy(models, team);
  const auxiliary: JsonObject = {};
  for (const [name, fetch] of [
    ["managedPlugins", () => client.managedPlugins(options.signal)],
    ["self", () => client.self(options.signal)],
    ["integrations", () => client.integrations(options.signal)],
  ] as const) {
    try { auxiliary[name] = (await fetch()) !== undefined; }
    catch (error) {
      options.signal?.throwIfAborted();
      if (isAuthenticationError(error)) throw error;
      auxiliary[name] = false;
      options.onWarning?.(`Failed to fetch ${name}: ${safeError(error, [client.credential.sessionToken])}`);
    }
  }
  return { models, status, auxiliary };
}

let osVersion: string | undefined;
function analyticsOSVersion(): string {
  if (osVersion !== undefined) return osVersion;
  osVersion = release();
  if (process.platform === "darwin") {
    try { osVersion = execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 3000, maxBuffer: 1024 }).trim(); }
    catch { /* On unsupported environments, only the kernel version is reported. */ }
  }
  return osVersion;
}

/** Builds only session/message/tool events that actually happened. Installation or external agent detection events are never faked. */
export function analyticsEvent(client: DevinClient, name: "SESSION_CREATED" | "USER_MESSAGE_SENT" | "AGENT_TOOL_CALLED", options: {
  installationId: string; model: string; toolName?: string;
}): JsonObject {
  const isTool = name === "AGENT_TOOL_CALLED";
  return {
    eventName: name,
    ...(!isTool ? { installationId: options.installationId } : {}),
    ideName: isTool ? "devin-cli" : "chisel",
    ...(isTool ? { ideType: "chisel" } : {}),
    os: process.platform === "darwin" ? "mac" : process.platform,
    ideVersion: CLIENT_VERSION,
    deviceFingerprint: client.fingerprint.device(),
    extra: {
      os_name: osType(), os_version: analyticsOSVersion(), os_arch: arch(), terminal_type: process.env.TERM ?? "unknown",
      model_name: options.model,
      ...(name === "SESSION_CREATED" ? { headless: "true" } : {}),
      ...(name === "USER_MESSAGE_SENT" ? { mode: "normal" } : {}),
      ...(isTool ? { tool_name: options.toolName ?? "", auto_approved: "true" } : {}),
    },
  };
}
