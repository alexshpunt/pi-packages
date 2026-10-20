import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../models/types.ts";

/**
 * Session-to-account bindings are stored as custom session entries, so they
 * survive Pi restarts and resume with the session file. Each entry records the
 * session ID it belongs to: a fork copies its parent's entries but has a new
 * session ID, so it ignores them and receives its own round-robin assignment.
 */
export const SESSION_ACCOUNT_ENTRY_TYPE = "ollama-cloud-account";

export interface SessionAccountEntryData {
  sessionId: string;
  accountId: string;
}

export type SessionAccountSource = Pick<ExtensionContext["sessionManager"], "getSessionId" | "getEntries">;

/** Latest account recorded for this session ID, in file order. */
export function findSessionAccount(entries: readonly SessionEntry[], sessionId: string): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== SESSION_ACCOUNT_ENTRY_TYPE) continue;
    const data: unknown = entry.data;
    if (isRecord(data) && data.sessionId === sessionId && typeof data.accountId === "string") return data.accountId;
  }
  return undefined;
}

export interface SessionAccountBinding {
  readonly sessionId: string | undefined;
  readonly accountId: string | undefined;
  /** Load the binding recorded for the current session. */
  start(source: SessionAccountSource): void;
  /** Bind the session to an account and record it in the session file. */
  bind(accountId: string): void;
  setNotifier(notify: ((message: string) => void) | undefined): void;
  notify(message: string): void;
}

export function createSessionAccountBinding(
  appendEntry: (customType: string, data: SessionAccountEntryData) => void,
): SessionAccountBinding {
  let sessionId: string | undefined;
  let accountId: string | undefined;
  let notifier: ((message: string) => void) | undefined;
  return {
    get sessionId() {
      return sessionId;
    },
    get accountId() {
      return accountId;
    },
    start(source) {
      sessionId = source.getSessionId();
      accountId = findSessionAccount(source.getEntries(), sessionId);
    },
    bind(nextAccountId) {
      if (nextAccountId === accountId) return;
      accountId = nextAccountId;
      if (sessionId === undefined) return;
      try {
        appendEntry(SESSION_ACCOUNT_ENTRY_TYPE, { sessionId, accountId: nextAccountId });
      } catch {
        // A replaced or shutting-down runtime rejects writes; the binding still applies in memory.
      }
    },
    setNotifier(notify) {
      notifier = notify;
    },
    notify(message) {
      try {
        notifier?.(message);
      } catch {
        // Notifications from a stale context are best effort.
      }
    },
  };
}
