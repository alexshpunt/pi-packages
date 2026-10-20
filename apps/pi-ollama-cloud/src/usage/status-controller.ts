import { fetchUsage, type UsageData } from "./api.ts";
import { createUsageStatusRefreshGuard } from "./status.ts";

export const USAGE_REFRESH_MS = 5 * 60_000;
export interface UsageStatusTarget {
  isTUI: boolean;
  isCurrent: () => boolean;
  resolveApiKey: (signal: AbortSignal) => Promise<string | undefined>;
  format: (data: UsageData) => string;
  setStatus: (text: string | undefined) => void;
  signal?: AbortSignal;
}
export interface UsageStatusOptions {
  now?: () => number;
  fetchUsage?: typeof fetchUsage;
  schedule?: (callback: () => void, intervalMs: number) => () => void;
}

/** Owns only footer requests, never the explicit one-shot usage command. */
export function createUsageStatusController(options: UsageStatusOptions = {}) {
  const guard = createUsageStatusRefreshGuard();
  const now = options.now ?? Date.now;
  const fetch = options.fetchUsage ?? fetchUsage;
  const schedule =
    options.schedule ??
    ((callback, intervalMs) => {
      const timer = setInterval(callback, intervalMs);
      return () => clearInterval(timer);
    });
  let isActive = false;
  let lastRefreshAtMs = 0;
  let cancelTimer: (() => void) | undefined;
  let target: UsageStatusTarget | undefined;
  async function refresh(current: UsageStatusTarget) {
    await guard.run(
      () => isActive && current.isCurrent(),
      async (stillCurrent, signal) => {
        const apiKey = await current.resolveApiKey(signal);
        if (!stillCurrent() || !apiKey) return undefined;
        lastRefreshAtMs = now();
        return current.format(await fetch(apiKey, signal));
      },
      current.setStatus,
      current.signal,
    );
  }
  return {
    start(current: UsageStatusTarget) {
      if (isActive || !current.isTUI) return;
      isActive = true;
      target = current;
      void refresh(current);
      cancelTimer = schedule(() => {
        void refresh(current);
      }, USAGE_REFRESH_MS);
    },
    stop(setStatus = target?.setStatus) {
      guard.invalidate();
      isActive = false;
      cancelTimer?.();
      cancelTimer = undefined;
      target = undefined;
      setStatus?.(undefined);
    },
    async afterTurn(current: UsageStatusTarget) {
      if (isActive && current.isCurrent() && now() - lastRefreshAtMs >= USAGE_REFRESH_MS) await refresh(current);
    },
  };
}
