import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getJson } from "./api.ts";
import { REFUSELESS_BASE_URL, REFUSELESS_PROVIDER_ID } from "./models.ts";

/** The balance `GET /v1/credits` reports, in US dollars (docs.refuseless.com/api/credits). */
export interface Credits {
  /** Paid credits on the account, including what in-flight requests hold. */
  balance: number;
  /** What in-flight requests hold right now. */
  reserved: number;
  /** What a new request can reserve: `balance` minus `reserved`, capped by `keyLimit`. */
  available: number;
  /** What the key's spend budget still allows, or null when the key has no budget. */
  keyLimit: number | null;
}

const isAmount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The balance from `GET <baseUrl>/credits`. The call charges nothing. Throws with the HTTP status and Refuseless
 * error on failure.
 */
export async function requestCredits(baseUrl: string, key: string, signal?: AbortSignal): Promise<Credits> {
  const url = `${baseUrl}/credits`;
  const body = await getJson(url, key, signal);
  const { balance, reserved, available, key_limit: keyLimit } = body ?? {};
  if (!isAmount(balance) || !isAmount(reserved) || !isAmount(available)) {
    throw new Error(`GET ${url} returned no credit balance`);
  }
  return { balance, reserved, available, keyLimit: isAmount(keyLimit) ? keyLimit : null };
}

/**
 * The balance for the key Pi uses for Refuseless (the saved key, else REFUSELESS_API_KEY), from the endpoint Pi
 * sends Refuseless requests to, including a models.json override. Undefined, with nothing sent, without a key.
 */
export async function readCredits(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  signal?: AbortSignal,
): Promise<Credits | undefined> {
  const key = await ctx.modelRegistry.getApiKeyForProvider(REFUSELESS_PROVIDER_ID);
  if (!key) return undefined;
  const baseUrl = ctx.modelRegistry.getProvider(REFUSELESS_PROVIDER_ID)?.baseUrl ?? REFUSELESS_BASE_URL;
  return requestCredits(baseUrl, key, signal);
}

// Refuseless reports amounts with up to 6 decimal places.
const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

/** `41.3` as `$41.30`; smaller amounts keep their decimals, as in `$0.000125`. */
export const formatUsd = (amount: number) => usd.format(amount);
