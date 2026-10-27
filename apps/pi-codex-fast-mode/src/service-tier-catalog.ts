import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord, type ServiceTier, writeJsonAtomically } from "./config.js";

export type AcceleratedTier = Exclude<ServiceTier, "standard">;
type TiersByModel = ReadonlyMap<string, ReadonlySet<AcceleratedTier>>;
type CatalogRegistry = Pick<
    ExtensionContext["modelRegistry"],
    "getProviderAuth" | "getProvider"
>;

/** Providers whose model IDs match the catalog slugs. */
const CATALOG_PROVIDERS: ReadonlySet<string> = new Set([
    "openai",
    "openai-codex",
]);
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
/**
 * The Codex backend requires `client_version` and omits models newer than it. Only tier metadata
 * is read, which does not depend on Codex client features, so request every model.
 */
const CODEX_CLIENT_VERSION = "999.0.0";
const CHATGPT_AUTH_CLAIM = "https://api.openai.com/auth";
const LOAD_TIMEOUT_MS = 5_000;

/** Used for models the catalog does not list, and when neither a lookup nor the cache succeeds. */
const FALLBACK_FAST_MODELS: ReadonlySet<string> = new Set([
    "openai/gpt-5.4",
    "openai/gpt-5.5",
    "openai/gpt-6-astra",
    "openai/gpt-6.1-sol",
    "openai/gpt-6-sol",
    "openai/gpt-6-luna",
    "openai-codex/gpt-6-astra",
    "openai-codex/gpt-6.1-sol",
    "openai-codex/gpt-6-sol",
    "openai-codex/gpt-6-luna",
    "openai-codex/gpt-5.6-sol",
    "openai-codex/gpt-5.6-terra",
    "openai-codex/gpt-5.6-luna",
    "openai-codex/gpt-5.4",
    "openai-codex/gpt-5.5",
]);
const FALLBACK_ULTRAFAST_MODEL_IDS: ReadonlySet<string> = new Set([
    "gpt-6-astra",
    "gpt-6.1-sol",
]);

function toAcceleratedTier(id: unknown): AcceleratedTier | undefined {
    if (id === "priority" || id === "fast") return "fast";
    if (id === "ultrafast") return "ultrafast";
    return undefined;
}

/** Reads `chatgpt_account_id` from the access token in memory; never logged or persisted. */
function readAccountId(token: string): string | undefined {
    const payload = token.split(".")[1];
    if (payload === undefined) return undefined;
    try {
        const claims: unknown = JSON.parse(
            Buffer.from(payload, "base64url").toString("utf8"),
        );
        const auth = isRecord(claims) ? claims[CHATGPT_AUTH_CLAIM] : undefined;
        const accountId = isRecord(auth) ? auth.chatgpt_account_id : undefined;
        return typeof accountId === "string" && accountId !== ""
            ? accountId
            : undefined;
    } catch {
        return undefined;
    }
}

/** `getProviderAuth` takes no signal, so stop waiting for it when the load ends. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        promise
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", onAbort));
    });
}

/** Maps each model slug to its advertised tiers; `undefined` for an unexpected response shape. */
function parseCatalog(value: unknown): TiersByModel | undefined {
    if (!isRecord(value) || !Array.isArray(value.models)) return undefined;
    const tiersByModel = new Map<string, ReadonlySet<AcceleratedTier>>();
    for (const entry of value.models) {
        if (!isRecord(entry) || typeof entry.slug !== "string") continue;
        const ids: unknown[] = [
            ...(Array.isArray(entry.service_tiers)
                ? entry.service_tiers.map((tier) =>
                      isRecord(tier) ? tier.id : undefined,
                  )
                : []),
            // Deprecated by `service_tiers`; still sent for older Codex clients.
            ...(Array.isArray(entry.additional_speed_tiers)
                ? entry.additional_speed_tiers
                : []),
        ];
        const tiers = new Set<AcceleratedTier>();
        for (const id of ids) {
            const tier = toAcceleratedTier(id);
            if (tier) tiers.add(tier);
        }
        tiersByModel.set(entry.slug, tiers);
    }
    return tiersByModel;
}

/** Resolves a provider's login through Pi; `undefined` when it has none. */
async function resolveProviderRequest(
    modelRegistry: CatalogRegistry,
    provider: string,
    defaultBaseUrl: string,
    signal: AbortSignal,
): Promise<{ token: string; baseUrl: string; headers: Headers } | undefined> {
    const result = await untilAborted(
        modelRegistry.getProviderAuth(provider),
        signal,
    );
    const token = result?.auth.apiKey;
    if (!token) return undefined;
    const headers = new Headers({ accept: "application/json" });
    for (const [name, value] of Object.entries(result.auth.headers ?? {}))
        if (typeof value === "string") headers.set(name, value);
    headers.set("authorization", `Bearer ${token}`);
    const baseUrl = (
        result.auth.baseUrl ??
        modelRegistry.getProvider(provider)?.baseUrl ??
        defaultBaseUrl
    )
        .trim()
        .replace(/\/+$/, "");
    return { token, baseUrl, headers };
}

/** Codex backend catalog through the ChatGPT login of the `openai-codex` provider. */
async function requestCodexCatalog(
    modelRegistry: CatalogRegistry,
    signal: AbortSignal,
): Promise<Response | undefined> {
    const request = await resolveProviderRequest(
        modelRegistry,
        "openai-codex",
        DEFAULT_CODEX_BASE_URL,
        signal,
    );
    const accountId = request ? readAccountId(request.token) : undefined;
    if (!request || !accountId) return undefined;
    const base = request.baseUrl.replace(/\/codex(?:\/responses)?$/, "");
    const url = new URL(`${base}/codex/models`);
    url.searchParams.set("client_version", CODEX_CLIENT_VERSION);
    if (!request.headers.has("originator"))
        request.headers.set("originator", "pi");
    request.headers.set("chatgpt-account-id", accountId);
    return fetch(url, { headers: request.headers, signal });
}

/** The same catalog from the OpenAI API, for API keys and ChatGPT OAuth; it lists every model. */
async function requestOpenAiCatalog(
    modelRegistry: CatalogRegistry,
    signal: AbortSignal,
): Promise<Response | undefined> {
    const request = await resolveProviderRequest(
        modelRegistry,
        "openai",
        DEFAULT_OPENAI_BASE_URL,
        signal,
    );
    if (!request) return undefined;
    return fetch(new URL(`${request.baseUrl}/models`), {
        headers: request.headers,
        signal,
    });
}

/** Tries the `openai-codex` login first, then `openai`; `undefined` when neither yields a catalog. */
async function fetchCatalog(
    modelRegistry: CatalogRegistry,
    signal: AbortSignal,
): Promise<TiersByModel | undefined> {
    for (const requestCatalog of [requestCodexCatalog, requestOpenAiCatalog]) {
        try {
            const response = await requestCatalog(modelRegistry, signal);
            if (response?.ok) {
                const tiersByModel = parseCatalog(await response.json());
                if (tiersByModel) return tiersByModel;
            }
        } catch {
            // A failed lookup falls through to the next login.
        }
        if (signal.aborted) return undefined;
    }
    return undefined;
}

/** Only the tier mapping is cached, not the catalog's instructions or other metadata. */
async function readCache(path: string): Promise<TiersByModel | undefined> {
    try {
        const value: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!isRecord(value) || !isRecord(value.models)) return undefined;
        const tiersByModel = new Map<string, ReadonlySet<AcceleratedTier>>();
        for (const [slug, ids] of Object.entries(value.models)) {
            if (!Array.isArray(ids)) continue;
            const tiers = new Set<AcceleratedTier>();
            for (const id of ids) {
                const tier = toAcceleratedTier(id);
                if (tier) tiers.add(tier);
            }
            tiersByModel.set(slug, tiers);
        }
        return tiersByModel;
    } catch {
        return undefined;
    }
}

async function writeCache(
    path: string,
    tiersByModel: TiersByModel,
): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeJsonAtomically(path, {
        fetchedAt: new Date().toISOString(),
        models: Object.fromEntries(
            [...tiersByModel].map(([slug, tiers]) => [slug, [...tiers]]),
        ),
    });
}

/** Service tiers each model advertises in the Codex `/models` catalog, like the Codex CLI. */
export class ServiceTierCatalog {
    private tiersByModel: TiersByModel | undefined;
    private loading: Promise<void> = Promise.resolve();

    /** Settles when the latest load finishes, fails, or times out; never rejects. */
    get ready(): Promise<void> {
        return this.loading;
    }

    /** Catalog entries decide listed models; others use the bundled snapshot. */
    getTiers(model: {
        readonly provider: string;
        readonly id: string;
    }): ReadonlySet<AcceleratedTier> {
        const advertised = CATALOG_PROVIDERS.has(model.provider)
            ? this.tiersByModel?.get(model.id)
            : undefined;
        if (advertised) return advertised;
        const tiers = new Set<AcceleratedTier>();
        if (FALLBACK_FAST_MODELS.has(`${model.provider}/${model.id}`))
            tiers.add("fast");
        if (FALLBACK_ULTRAFAST_MODEL_IDS.has(model.id)) tiers.add("ultrafast");
        return tiers;
    }

    /**
     * Looks up the catalog through Pi's `openai-codex`, then `openai` login, and saves its tiers to
     * `cachePath`. When both fail, the saved tiers are used; without them the previous catalog is
     * kept. Abort `signal` when its session ends.
     */
    load(
        modelRegistry: CatalogRegistry,
        cachePath: string,
        signal: AbortSignal,
    ): Promise<void> {
        const deadline = AbortSignal.any([
            signal,
            AbortSignal.timeout(LOAD_TIMEOUT_MS),
        ]);
        this.loading = (async () => {
            // Match Pi's model runtime, which skips catalog network refreshes when PI_OFFLINE is set.
            const fetched =
                process.env.PI_OFFLINE === undefined
                    ? await fetchCatalog(modelRegistry, deadline)
                    : undefined;
            const tiersByModel = fetched ?? (await readCache(cachePath));
            if (!tiersByModel || signal.aborted) return;
            this.tiersByModel = tiersByModel;
            if (fetched) await writeCache(cachePath, fetched);
        })().catch(() => undefined);
        return this.loading;
    }
}
