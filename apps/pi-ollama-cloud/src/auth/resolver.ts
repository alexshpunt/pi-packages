import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type CredentialOptions, resolvePiCredential } from "./pi-resolver.ts";

export type OllamaCloudApiKeySource = "auth.json" | "OLLAMA_API_KEY";

/** Inspect the raw stored value only. Never use this unresolved value as request authentication. */
export function readStoredOllamaCloudKey(authPath = join(getAgentDir(), "auth.json")): string | undefined {
  if (!existsSync(authPath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(authPath, "utf-8"));
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const entry = (parsed as Record<string, unknown>)["ollama-cloud"];
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const credential = entry as Record<string, unknown>;
    return credential.type === "api_key" && typeof credential.key === "string" ? credential.key : undefined;
  } catch {
    return undefined;
  }
}

/** Prefer Pi's stored credential, then fall back to the environment variable. */
export async function resolveOllamaCloudApiKey(
  authPath = join(getAgentDir(), "auth.json"),
  options: CredentialOptions = {},
): Promise<ResolvedCredential> {
  return resolvePiCredential(authPath, options);
}

export interface ResolvedCredential {
  apiKey: string | undefined;
  source: OllamaCloudApiKeySource | undefined;
  env?: Record<string, string>;
}
export type CredentialResolver = (signal?: AbortSignal) => Promise<ResolvedCredential>;
export const resolveCredential: CredentialResolver = (signal) => resolveOllamaCloudApiKey(undefined, { signal });
