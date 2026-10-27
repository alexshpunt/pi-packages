/**
 * OAuth state of MCP servers (client registration, tokens, pending PKCE verifier) in
 * `<agent-dir>/mcp-auth.json`, keyed by server name and URL. Several pi processes share the file, so
 * every change is a locked read and rewrite, and refreshes take a lock per server.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { McpOAuthState, McpOAuthStateStore } from "@earendil-works/pi-mcp/oauth";
import { Effect } from "effect";
import lockfile from "proper-lockfile";
import { mcpNamespace } from "../config/schema.ts";
import { fromPromise } from "../shared/effects.ts";

/** A refresh lock that its holder stopped renewing (the process was killed) is taken over after this. */
const REFRESH_LOCK_STALE_MS = 20_000;
/** How long to wait for another process's refresh: longer than a stale lock lives. */
const REFRESH_LOCK_WAIT_MS = 25_000;
const REFRESH_LOCK_RETRY_MS = 100;

type StoredStates = Record<string, McpOAuthState>;

function parseStates(content: string | undefined): StoredStates {
  if (!content?.trim()) return {};
  const parsed: unknown = JSON.parse(content);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as StoredStates) : {};
}

function serializeStates(states: StoredStates): string {
  return `${JSON.stringify(states, null, 2)}\n`;
}

/**
 * Keys of a server's state: by name and URL, so servers sharing a URL keep separate accounts, and the
 * legacy key by URL alone, written by older versions.
 */
function storeKeys(name: string, serverUrl: string): { key: string; legacyKey: string } {
  const legacyKey = String(new URL(serverUrl));
  return { key: `${mcpNamespace(name)}|${legacyKey}`, legacyKey };
}

export interface McpOAuthServerStore extends McpOAuthStateStore {
  /** Run `work` while no other process refreshes the server's tokens. */
  withRefreshLock<A, E>(work: Effect.Effect<A, E>): Effect.Effect<A, E | unknown>;
}

/** Where the stored states are read and written. */
export interface McpOAuthStorage {
  /**
   * Run `fn` with the current content while no other process changes it, and store `next` when `fn`
   * returns one.
   */
  withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T;
}

// Created with a mode that only the user may read; an existing file keeps its mode and ACLs.
const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

/**
 * `withLock` takes a proper-lockfile lock synchronously, which fails at once while another process holds
 * it. It is held only while the file is read and rewritten, so a few short waits are enough. On Windows,
 * a just-removed lock can briefly fail with EPERM while another process still has it open.
 */
function lockSyncWithRetry(path: string): () => void {
  const maxAttempts = 10;
  const delayMs = 20;
  for (let attempt = 1; ; attempt++) {
    try {
      return lockfile.lockSync(path, { realpath: false });
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      const isRetryable = code === "ELOCKED" || (code === "EPERM" && process.platform === "win32");
      if (!isRetryable || attempt === maxAttempts) throw error;
      const start = Date.now();
      while (Date.now() - start < delayMs) {
        // Wait synchronously, since callers are synchronous.
      }
    }
  }
}

/** `mcp-auth.json` itself, locked like pi's `auth.json`. */
class McpOAuthFileStorage implements McpOAuthStorage {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (!existsSync(this.path)) writeFileSync(this.path, "{}", AUTH_FILE_WRITE_OPTIONS);
    const release = lockSyncWithRetry(this.path);
    try {
      const current = existsSync(this.path) ? readFileSync(this.path, "utf-8") : undefined;
      const { result, next } = fn(current);
      if (next !== undefined) writeFileSync(this.path, next, AUTH_FILE_WRITE_OPTIONS);
      return result;
    } finally {
      release();
    }
  }
}

/** Per-server OAuth state in `mcp-auth.json`. */
export class McpOAuthCredentialStore {
  private readonly backend: McpOAuthStorage;
  /** Directory for the refresh lock files. Without one, refreshes are only serialized in this process. */
  private readonly lockDir: string | undefined;

  constructor(backend?: McpOAuthStorage, lockDir?: string) {
    this.backend = backend ?? new McpOAuthFileStorage(join(getAgentDir(), "mcp-auth.json"));
    this.lockDir = backend ? lockDir : getAgentDir();
  }

  forServer(name: string, serverUrl: string): McpOAuthServerStore {
    const { key, legacyKey } = storeKeys(name, serverUrl);
    return {
      // The first server to load legacy state takes it over; others with the same URL sign in again.
      load: () =>
        this.backend.withLock((current) => {
          const states = parseStates(current);
          if (states[key] || !states[legacyKey]) return { result: states[key] };
          states[key] = states[legacyKey];
          delete states[legacyKey];
          return { result: states[key], next: serializeStates(states) };
        }),
      save: (state) =>
        this.write((states) => {
          states[key] = state;
        }),
      withRefreshLock: (work) => this.withRefreshLock(key, work),
    };
  }

  /**
   * A lock file per server. When the process exits, proper-lockfile removes the locks it holds; when
   * it is killed, the lock goes stale because it is no longer renewed, and the next process takes it over.
   */
  private withRefreshLock<A, E>(key: string, work: Effect.Effect<A, E>): Effect.Effect<A, E | unknown> {
    const lockDir = this.lockDir;
    if (!lockDir) return work;
    return Effect.acquireUseRelease(
      fromPromise(async () => {
        mkdirSync(lockDir, { recursive: true, mode: 0o700 });
        const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
        return lockfile.lock(join(lockDir, `mcp-auth-refresh-${hash}`), {
          realpath: false,
          stale: REFRESH_LOCK_STALE_MS,
          retries: {
            retries: REFRESH_LOCK_WAIT_MS / REFRESH_LOCK_RETRY_MS,
            factor: 1,
            minTimeout: REFRESH_LOCK_RETRY_MS,
            maxTimeout: REFRESH_LOCK_RETRY_MS,
          },
          // The default throws from a timer. A lost lock at worst lets two refreshes overlap.
          onCompromised: () => {},
        });
      }),
      () => work,
      (release) => Effect.ignore(fromPromise(release)),
    );
  }

  /** The stored tokens of a server, for noticing sign-ins done by another process. Does not take over legacy state. */
  tokens(name: string, serverUrl: string): McpOAuthState["tokens"] {
    const { key, legacyKey } = storeKeys(name, serverUrl);
    const states = this.backend.withLock((current) => ({ result: parseStates(current) }));
    return (states[key] ?? states[legacyKey])?.tokens;
  }

  /** Returns whether credentials were stored for the server. Removes legacy state the server would take over. */
  remove(name: string, serverUrl: string): boolean {
    const { key, legacyKey } = storeKeys(name, serverUrl);
    return this.backend.withLock((current) => {
      const states = parseStates(current);
      const stored = key in states ? key : legacyKey in states ? legacyKey : undefined;
      if (!stored) return { result: false };
      delete states[stored];
      return { result: true, next: serializeStates(states) };
    });
  }

  private write(update: (states: StoredStates) => void): void {
    this.backend.withLock((current) => {
      const states = parseStates(current);
      update(states);
      return { result: undefined, next: serializeStates(states) };
    });
  }
}
