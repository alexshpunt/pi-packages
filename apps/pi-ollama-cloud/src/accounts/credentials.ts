import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CredentialSynchronizationError, getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { OLLAMA_BASE } from "../models/base.ts";
import { isRecord } from "../models/types.ts";
import { DEFAULT_ACCOUNT_ID } from "./types.ts";

/**
 * Additional accounts live in their own file with Pi's auth.json format:
 * `{ "<account-id>": { "type": "api_key", "key": "<literal | $ENV | !command>" } }`.
 * Reads, writes, locking, file mode 0600, and key-reference resolution all go
 * through Pi's own credential storage via a private ModelRuntime, so the file
 * behaves exactly like auth.json without touching it.
 */
export const ACCOUNTS_FILE_NAME = "ollama-cloud-accounts.json";
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const RESERVED_ACCOUNT_IDS = new Set([DEFAULT_ACCOUNT_ID, "ollama-cloud"]);
const UNRESOLVED_KEY_ERROR = "The API key or its $ENV/!command reference could not be resolved.";

export function accountsFilePath(agentDir = getAgentDir()): string {
  return join(agentDir, ACCOUNTS_FILE_NAME);
}

/** Validate the syntax of a user-chosen account ID. Built-in provider collisions are checked by the store. */
export function validateAccountIdFormat(id: string): string | undefined {
  if (!ACCOUNT_ID_PATTERN.test(id)) {
    return "Account IDs use 1-32 lowercase letters, digits, '-' or '_', starting with a letter or digit.";
  }
  if (RESERVED_ACCOUNT_IDS.has(id)) return `"${id}" is reserved for Pi's own ollama-cloud credential.`;
  return undefined;
}

export interface StoredAccountKey {
  id: string;
  apiKey?: string;
  /** Present when the entry cannot be used; never contains the key or a configured command. */
  error?: string;
}

export interface AccountCredentialStore {
  /** Current file path; follows PI_CODING_AGENT_DIR unless a path was injected. */
  readonly path: string;
  /** Account IDs in file order without resolving any key. */
  list(signal?: AbortSignal): Promise<string[]>;
  /** Resolve every entry through Pi's credential resolver. */
  resolve(signal?: AbortSignal): Promise<StoredAccountKey[]>;
  add(id: string, value: string, signal?: AbortSignal): Promise<void>;
  remove(id: string, signal?: AbortSignal): Promise<boolean>;
}

interface PrivateRuntime {
  runtime: ModelRuntime;
  builtinProviderIds: ReadonlySet<string>;
  register(id: string): void;
}

function unreadableFileError(path: string): Error {
  return new Error(`Could not read the Ollama Cloud accounts file (${path}). It must be valid auth.json-format JSON.`);
}

function isValidCredential(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "api_key") {
    const isValidEnv =
      value.env === undefined ||
      (isRecord(value.env) && Object.values(value.env).every((entry) => typeof entry === "string"));
    return (value.key === undefined || typeof value.key === "string") && isValidEnv;
  }
  return (
    value.type === "oauth" &&
    typeof value.access === "string" &&
    typeof value.refresh === "string" &&
    typeof value.expires === "number"
  );
}

/**
 * Pi's credential storage treats an unreadable file as empty and only fails on
 * write, so check the file first. Messages name the file or entry, never content.
 */
function assertReadableFile(path: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw unreadableFileError(path);
  }
  if (!isRecord(parsed)) throw unreadableFileError(path);
  for (const [id, credential] of Object.entries(parsed)) {
    if (!isValidCredential(credential)) {
      throw new Error(`Account "${id}" in ${path} is not a valid auth.json credential entry.`);
    }
  }
}

async function openRuntime(path: string, signal?: AbortSignal): Promise<PrivateRuntime> {
  if (existsSync(path)) assertReadableFile(path);
  let runtime: ModelRuntime;
  try {
    runtime = await ModelRuntime.create({
      authPath: path,
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
      signal,
    });
  } catch {
    signal?.throwIfAborted();
    // Parse errors can quote file content, so report only the location.
    throw unreadableFileError(path);
  }
  const builtinProviderIds = new Set(runtime.getProviders().map((provider) => provider.id));
  return {
    runtime,
    builtinProviderIds,
    register(id) {
      // An empty provider gives each account its own credential slot; it is never used for requests.
      runtime.registerProvider(id, { baseUrl: `${OLLAMA_BASE}/v1`, api: "openai-completions", models: [] });
    },
  };
}

/**
 * The private runtime has no models to refresh, so a post-write synchronization
 * failure still means success. Other storage errors can quote file content.
 */
async function writeCredential(path: string, operation: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof CredentialSynchronizationError) return;
    signal?.throwIfAborted();
    throw new Error(`Could not update the Ollama Cloud accounts file (${path}).`);
  }
}

function entryError(id: string, type: string, builtinProviderIds: ReadonlySet<string>): string | undefined {
  const formatError = validateAccountIdFormat(id);
  if (formatError) return formatError;
  // A built-in provider would contribute its own ambient credentials (for example its API-key env var).
  if (builtinProviderIds.has(id)) return `"${id}" matches a built-in Pi provider name; rename this account.`;
  if (type !== "api_key") return "Only API-key credentials are supported.";
  return undefined;
}

export function createAccountCredentialStore(path?: string): AccountCredentialStore {
  const filePath = () => path ?? accountsFilePath();
  return {
    get path() {
      return filePath();
    },
    async list(signal) {
      const file = filePath();
      if (!existsSync(file)) return [];
      const { runtime } = await openRuntime(file, signal);
      return (await runtime.listCredentials({ signal })).map((credential) => credential.providerId);
    },
    async resolve(signal) {
      const file = filePath();
      if (!existsSync(file)) return [];
      const { runtime, builtinProviderIds, register } = await openRuntime(file, signal);
      const results: StoredAccountKey[] = [];
      for (const { providerId: id, type } of await runtime.listCredentials({ signal })) {
        const error = entryError(id, type, builtinProviderIds);
        if (error) {
          results.push({ id, error });
          continue;
        }
        register(id);
        try {
          const apiKey = (await runtime.getAuth(id, { signal }))?.auth.apiKey;
          results.push(apiKey ? { id, apiKey } : { id, error: UNRESOLVED_KEY_ERROR });
        } catch {
          signal?.throwIfAborted();
          // Host errors may include a configured command; keep them out of the report.
          results.push({ id, error: UNRESOLVED_KEY_ERROR });
        }
      }
      return results;
    },
    async add(id, value, signal) {
      const formatError = validateAccountIdFormat(id);
      if (formatError) throw new Error(formatError);
      if (!value.trim()) throw new Error("An API key or $ENV/!command reference is required.");
      const file = filePath();
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const { runtime, builtinProviderIds, register } = await openRuntime(file, signal);
      if (builtinProviderIds.has(id))
        throw new Error(`"${id}" matches a built-in Pi provider name; choose another ID.`);
      if ((await runtime.listCredentials({ signal })).some((credential) => credential.providerId === id)) {
        throw new Error(`Account "${id}" already exists.`);
      }
      register(id);
      await writeCredential(
        file,
        runtime.login(id, "api_key", {
          signal,
          prompt: async () => value.trim(),
          notify() {},
        }),
        signal,
      );
    },
    async remove(id, signal) {
      const file = filePath();
      if (!existsSync(file)) return false;
      const { runtime } = await openRuntime(file, signal);
      if (!(await runtime.listCredentials({ signal })).some((credential) => credential.providerId === id)) return false;
      await writeCredential(file, runtime.logout(id, { signal }), signal);
      return true;
    },
  };
}
