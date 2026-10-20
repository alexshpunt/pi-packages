import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { isSafeKey } from "../cache/data.ts";
import { fetchUsage, type UsageData } from "../usage/api.ts";
import { type AccountCredentialStore, createAccountCredentialStore, type StoredAccountKey } from "./credentials.ts";
import { classifyThrownError } from "./failure.ts";
import {
  type AccountChoice,
  accountUnavailableReason,
  chooseAccount,
  evaluatePurchaseGuard,
  exhaustedUntil,
  healthOf,
  limitResetAt,
  MODEL_BLOCK_MS,
} from "./policy.ts";
import type { SessionAccountBinding } from "./session.ts";
import { type AccountStateStore, createAccountStateStore } from "./state.ts";
import {
  type AccountFailure,
  type AccountHealth,
  type AccountState,
  DEFAULT_ACCOUNT_ID,
  type OllamaAccount,
} from "./types.ts";

export const NO_ACCOUNT_MESSAGE = "No Ollama Cloud API key configured. Set OLLAMA_API_KEY or add to auth.json.";

export function accountFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

export interface AccountProblem {
  id: string;
  error: string;
}

export interface AccountList {
  /** Rotation order: Pi's credential first, then the accounts file order. */
  accounts: OllamaAccount[];
  /** Entries that cannot be used, such as unresolved references or duplicate keys. */
  problems: AccountProblem[];
}

export type AccountAcquisition = { ok: true; account: OllamaAccount } | { ok: false; message: string };

export interface AcquireRequest {
  /** Key Pi resolved for the `ollama-cloud` provider; it becomes the `default` account. */
  primaryKey: string | undefined;
  binding: SessionAccountBinding;
  modelId?: string;
  /** Accounts that already failed for the current request. */
  excludedIds?: ReadonlySet<string>;
  signal?: AbortSignal;
}

export interface AccountRouter {
  readonly credentials: AccountCredentialStore;
  listAccounts(primaryKey: string | undefined, signal?: AbortSignal): Promise<AccountList>;
  /** Return the session's account, assigning the next round-robin account when needed. */
  acquire(request: AcquireRequest): Promise<AccountAcquisition>;
  reportFailure(account: OllamaAccount, failure: AccountFailure, options?: { modelId?: string }): Promise<void>;
  /** Fetch and record the account balance; failures are recorded and resolve to undefined. */
  refreshBalance(account: OllamaAccount, signal?: AbortSignal): Promise<UsageData | undefined>;
  recordBalance(account: OllamaAccount, data: UsageData): Promise<void>;
  readState(): AccountState;
  setDisabled(accountId: string, isDisabled: boolean): Promise<void>;
  resetHealth(accounts: readonly OllamaAccount[]): Promise<void>;
  /** Wait for background balance refreshes started by failure reports. */
  settle(): Promise<void>;
}

export interface AccountRouterOptions {
  credentials?: AccountCredentialStore;
  state?: AccountStateStore;
  fetchBalance?: (apiKey: string, signal?: AbortSignal) => Promise<UsageData>;
  now?: () => number;
}

function fileRevision(path: string): string | undefined {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
}

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function touchHealth(state: AccountState, account: OllamaAccount, nowMs: number): AccountHealth {
  const health = healthOf(state, account) ?? { updatedAtMs: nowMs };
  health.updatedAtMs = nowMs;
  state.health[account.fingerprint] = health;
  return health;
}

function accountReason(
  account: OllamaAccount,
  state: AccountState,
  nowMs: number,
  modelId: string | undefined,
  excludedIds: ReadonlySet<string> | undefined,
): string {
  return (
    accountUnavailableReason(account, state, nowMs, modelId) ??
    (excludedIds?.has(account.id) ? "failed for this request" : "unavailable")
  );
}

/**
 * The phrase "quota exceeded" marks the error as non-retryable for Pi, which
 * would otherwise retry a request that no account can serve.
 */
function unavailableMessage(
  accounts: readonly OllamaAccount[],
  state: AccountState,
  nowMs: number,
  modelId: string | undefined,
  excludedIds: ReadonlySet<string> | undefined,
): string {
  const details = accounts
    .map((account) => `${account.id}: ${accountReason(account, state, nowMs, modelId, excludedIds)}`)
    .join("; ");
  return (
    `Ollama Cloud quota exceeded or unavailable for every configured account (${details}). ` +
    "Wait for a reset, or review accounts in /ollama."
  );
}

export function createAccountRouter(options: AccountRouterOptions = {}): AccountRouter {
  const credentials = options.credentials ?? createAccountCredentialStore();
  const stateStore = options.state ?? createAccountStateStore({ now: options.now });
  const fetchBalance = options.fetchBalance ?? fetchUsage;
  const now = options.now ?? Date.now;
  let storedCache: { path: string; revision: string | undefined; entries: StoredAccountKey[] } | undefined;
  let storedLoad: { path: string; revision: string | undefined; promise: Promise<StoredAccountKey[]> } | undefined;
  const balanceRequests = new Map<string, Promise<UsageData | undefined>>();
  const background = new Set<Promise<unknown>>();
  let acquireTail: Promise<unknown> = Promise.resolve();

  async function storedAccounts(signal?: AbortSignal): Promise<StoredAccountKey[]> {
    const path = credentials.path;
    const revision = fileRevision(path);
    if (revision === undefined) return [];
    if (storedCache?.path === path && storedCache.revision === revision) return storedCache.entries;
    if (storedLoad?.path !== path || storedLoad.revision !== revision) {
      // A broken accounts file is reported as a problem so Pi's own credential keeps working.
      const promise = credentials
        .resolve()
        .catch((error: unknown): StoredAccountKey[] => [
          { id: "(accounts file)", error: error instanceof Error ? error.message : String(error) },
        ]);
      storedLoad = { path, revision, promise };
      promise.then(
        (entries) => {
          if (storedLoad?.promise === promise) {
            storedCache = { path, revision, entries };
            storedLoad = undefined;
          }
        },
        () => {
          if (storedLoad?.promise === promise) storedLoad = undefined;
        },
      );
    }
    return waitWithSignal(storedLoad.promise, signal);
  }

  async function listAccounts(primaryKey: string | undefined, signal?: AbortSignal): Promise<AccountList> {
    const accounts: OllamaAccount[] = [];
    const problems: AccountProblem[] = [];
    const fingerprints = new Set<string>();
    if (primaryKey) {
      const fingerprint = accountFingerprint(primaryKey);
      fingerprints.add(fingerprint);
      accounts.push({ id: DEFAULT_ACCOUNT_ID, apiKey: primaryKey, fingerprint, source: "pi" });
    }
    for (const entry of await storedAccounts(signal)) {
      if (!entry.apiKey) {
        problems.push({ id: entry.id, error: entry.error ?? "Unusable entry." });
        continue;
      }
      const fingerprint = accountFingerprint(entry.apiKey);
      if (fingerprints.has(fingerprint)) {
        problems.push({ id: entry.id, error: "Uses the same API key as another account; skipped." });
        continue;
      }
      fingerprints.add(fingerprint);
      accounts.push({ id: entry.id, apiKey: entry.apiKey, fingerprint, source: "accounts-file" });
    }
    return { accounts, problems };
  }

  async function recordBalance(account: OllamaAccount, data: UsageData): Promise<void> {
    await stateStore.update((state) => {
      const nowMs = now();
      const health = touchHealth(state, account, nowMs);
      health.balance = { checkedAtMs: nowMs, data };
      delete health.balanceFailedAtMs;
    });
  }

  function refreshBalance(account: OllamaAccount, signal?: AbortSignal): Promise<UsageData | undefined> {
    let request = balanceRequests.get(account.fingerprint);
    if (!request) {
      // Shared by concurrent callers, so it is not tied to one caller's cancellation.
      request = (async () => {
        try {
          const data = await fetchBalance(account.apiKey);
          await recordBalance(account, data);
          return data;
        } catch (error) {
          const failure = classifyThrownError(error);
          await stateStore.update((state) => {
            const health = touchHealth(state, account, now());
            health.balanceFailedAtMs = now();
            if (failure?.kind === "unauthorized") health.isUnauthorized = true;
          });
          return undefined;
        }
      })();
      const pending = request;
      balanceRequests.set(account.fingerprint, pending);
      void pending.finally(() => {
        if (balanceRequests.get(account.fingerprint) === pending) balanceRequests.delete(account.fingerprint);
      });
    }
    return waitWithSignal(request, signal);
  }

  function track(promise: Promise<unknown>) {
    const tracked = promise.catch(() => {});
    background.add(tracked);
    void tracked.finally(() => background.delete(tracked));
  }

  function serialized<T>(run: () => Promise<T>): Promise<T> {
    const result = acquireTail.then(run, run);
    acquireTail = result.catch(() => {});
    return result;
  }

  async function acquire(request: AcquireRequest): Promise<AccountAcquisition> {
    const { primaryKey, binding, modelId, excludedIds, signal } = request;
    return serialized(async () => {
      signal?.throwIfAborted();
      const { accounts } = await listAccounts(primaryKey, signal);
      if (accounts.length === 0) return { ok: false, message: NO_ACCOUNT_MESSAGE };
      // Each pass either returns or records a balance check, so a few passes per account suffice.
      for (let pass = 0; pass <= accounts.length * 2; pass++) {
        signal?.throwIfAborted();
        const previousAccountId = binding.accountId;
        const snapshot = stateStore.read();
        const nowMs = now();
        const input = { accounts, boundAccountId: previousAccountId, excludedIds, modelId, nowMs };
        const tentative = chooseAccount({ ...input, state: snapshot });
        if (!tentative) {
          return { ok: false, message: unavailableMessage(accounts, snapshot, nowMs, modelId, excludedIds) };
        }
        if (evaluatePurchaseGuard(healthOf(snapshot, tentative.account), nowMs).action === "refresh") {
          await refreshBalance(tentative.account, signal);
          continue;
        }
        if (!tentative.isNewAssignment) return { ok: true, account: tentative.account };

        // Re-choose under the lock so concurrent processes advance one shared rotation.
        const assigned = await stateStore.update<AccountChoice | undefined>((state) => {
          const choice = chooseAccount({ ...input, state });
          if (!choice || evaluatePurchaseGuard(healthOf(state, choice.account), nowMs).action === "refresh") {
            return choice;
          }
          if (choice.isNewAssignment) state.lastAssignedAccountId = choice.account.id;
          return choice;
        }, signal);
        if (!assigned) continue;
        const latest = stateStore.read();
        if (evaluatePurchaseGuard(healthOf(latest, assigned.account), nowMs).action === "refresh") {
          await refreshBalance(assigned.account, signal);
          continue;
        }
        binding.bind(assigned.account.id);
        if (previousAccountId !== undefined && previousAccountId !== assigned.account.id) {
          const previous = accounts.find((account) => account.id === previousAccountId);
          const reason = previous
            ? accountReason(previous, latest, nowMs, modelId, excludedIds)
            : "no longer configured";
          binding.notify(
            `Ollama Cloud account "${previousAccountId}" is unavailable (${reason}); ` +
              `this session now uses "${assigned.account.id}".`,
          );
        }
        return { ok: true, account: assigned.account };
      }
      return { ok: false, message: "Ollama Cloud account selection did not settle; try again shortly." };
    });
  }

  async function reportFailure(
    account: OllamaAccount,
    failure: AccountFailure,
    reportOptions: { modelId?: string } = {},
  ): Promise<void> {
    const nowMs = now();
    await stateStore.update((state) => {
      const health = touchHealth(state, account, nowMs);
      if (failure.kind === "usage-limit") {
        health.exhaustedUntilMs = exhaustedUntil(failure.window, nowMs, health.balance?.data);
        health.exhaustedWindow = failure.window;
      } else if (failure.kind === "unauthorized") {
        health.isUnauthorized = true;
      } else if (reportOptions.modelId && isSafeKey(reportOptions.modelId)) {
        health.blockedModels = { ...health.blockedModels, [reportOptions.modelId]: nowMs + MODEL_BLOCK_MS };
      }
    });
    if (failure.kind === "unauthorized") {
      // A rotated key behind a $ENV/!command reference is picked up on the next load.
      storedCache = undefined;
    }
    if (failure.kind === "usage-limit") {
      // Replace the provisional reset with the window boundary the balance endpoint reports.
      track(
        refreshBalance(account).then(async (data) => {
          const resetAt = data ? limitResetAt(failure.window, now(), data) : undefined;
          if (resetAt === undefined) return;
          await stateStore.update((state) => {
            const health = healthOf(state, account);
            if (health?.exhaustedUntilMs !== undefined) health.exhaustedUntilMs = resetAt;
          });
        }),
      );
    }
  }

  return {
    credentials,
    listAccounts,
    acquire,
    reportFailure,
    refreshBalance,
    recordBalance,
    readState: () => stateStore.read(),
    async setDisabled(accountId, isDisabled) {
      await stateStore.update((state) => {
        const disabled = new Set(state.disabledAccountIds);
        if (isDisabled) disabled.add(accountId);
        else disabled.delete(accountId);
        state.disabledAccountIds = [...disabled];
      });
    },
    async resetHealth(accounts) {
      await stateStore.update((state) => {
        for (const account of accounts) {
          const health = healthOf(state, account);
          if (!health) continue;
          delete health.exhaustedUntilMs;
          delete health.exhaustedWindow;
          delete health.isUnauthorized;
          delete health.blockedModels;
          delete health.balanceFailedAtMs;
        }
      });
      storedCache = undefined;
    },
    async settle() {
      while (background.size > 0) await Promise.all([...background]);
    },
  };
}
