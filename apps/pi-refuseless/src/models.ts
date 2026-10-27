import type { Model, ModelThinkingLevel, RefreshModelsContext, ThinkingLevelMap } from "@earendil-works/pi-ai";

export const REFUSELESS_PROVIDER_ID = "refuseless";
export const REFUSELESS_BASE_URL = "https://api.refuseless.com/v1";

/** `reasoning_effort` values Refuseless accepts; "none" is an alias of "off" (docs.refuseless.com/guides/reasoning). */
const EFFORTS = ["off", "low", "high", "max"] as const;
type Effort = (typeof EFFORTS)[number];

/**
 * A Refuseless chat model. `reasoningDefault` is the catalog's `reasoning_default`, the level Refuseless uses
 * when a request sets no `reasoning_effort`; each effort has the Pi thinking level of the same name. Pi saves
 * and restores the field with the rest of the model.
 */
export type RefuselessModel = Model<"openai-completions"> & { reasoningDefault?: ModelThinkingLevel };

/**
 * Values the catalog does not carry. A missing `context_length` uses Pi's default context for custom models.
 * The output limit is the one the Pi setup in docs.refuseless.com/sdks gives; input is text only because the
 * catalog reports no modalities, and cost stays zero because it reports no prices.
 */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const MAX_OUTPUT_TOKENS = 131_072;

function effort(value: unknown): Effort | undefined {
  return value === "none" ? "off" : EFFORTS.find((entry) => entry === value);
}

/**
 * Pi thinking levels from the catalog's `reasoning_efforts` and `reasoning_default`. A model without
 * `reasoning_efforts` may take every documented value. Levels a model does not offer map to `null`, so Pi
 * never shows or sends a value Refuseless rejects. A default the model does not offer is ignored.
 */
function thinkingLevels(
  reported: unknown,
  reportedDefault: unknown,
): Pick<RefuselessModel, "reasoning" | "thinkingLevelMap" | "reasoningDefault"> {
  const offered = Array.isArray(reported)
    ? EFFORTS.filter((entry) => reported.some((value) => effort(value) === entry))
    : EFFORTS;
  const level = (entry: Effort) => (offered.includes(entry) ? entry : null);
  const thinkingLevelMap: ThinkingLevelMap = {
    off: level("off"),
    minimal: null,
    low: level("low"),
    medium: null,
    high: level("high"),
    xhigh: null,
    max: level("max"),
  };
  const reasoning = offered.some((entry) => entry !== "off");
  const fallback = effort(reportedDefault);
  return {
    reasoning,
    thinkingLevelMap,
    ...(reasoning && fallback && offered.includes(fallback) ? { reasoningDefault: fallback } : {}),
  };
}

/** A Pi chat model from one `GET /v1/models` entry, or undefined when the entry has no ID. */
function chatModel(entry: unknown): RefuselessModel | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const {
    id,
    context_length: contextLength,
    reasoning_efforts: efforts,
    reasoning_default: reportedDefault,
  } = entry as Record<string, unknown>;
  if (typeof id !== "string" || !id) return undefined;
  const contextWindow = typeof contextLength === "number" && contextLength > 0 ? contextLength : DEFAULT_CONTEXT_WINDOW;
  return {
    id,
    name: id,
    provider: REFUSELESS_PROVIDER_ID,
    api: "openai-completions",
    baseUrl: REFUSELESS_BASE_URL,
    ...thinkingLevels(efforts, reportedDefault),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.min(MAX_OUTPUT_TOKENS, contextWindow),
    // Chat messages take the system, user, assistant and tool roles (openapi.json, ChatMessage).
    compat: { supportsDeveloperRole: false },
  };
}

/** Pi chat models for the entries of `GET /v1/models`; entries without an ID are skipped. */
export function catalogModels(entries: readonly unknown[]): RefuselessModel[] {
  return entries.map(chatModel).filter((model) => model !== undefined);
}

/** The `data` entries of `GET <baseUrl>/models`. Throws with the HTTP status and Refuseless error on failure. */
export async function requestCatalog(baseUrl: string, key: string, signal?: AbortSignal): Promise<unknown[]> {
  const url = `${baseUrl}/models`;
  const response = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal });
  const body = (await response.json().catch(() => undefined)) as { data?: unknown; error?: any } | undefined;
  if (!response.ok) {
    const reason = [body?.error?.code, body?.error?.message].filter(Boolean).join(": ");
    throw new Error(`GET ${url} failed with HTTP ${response.status}${reason ? ` (${reason})` : ""}`);
  }
  if (!Array.isArray(body?.data)) throw new Error(`GET ${url} returned no model list`);
  return body.data;
}

/**
 * Pi's model refresh for Refuseless: every model in `GET /v1/models`, fetched with the key Pi resolved
 * (the saved key, else REFUSELESS_API_KEY). Without a key it returns the last saved list unchanged and
 * sends nothing. Pi keeps the previous list when this throws and reports the error where it shows refresh failures.
 */
export async function fetchRefuselessModels(context: RefreshModelsContext): Promise<RefuselessModel[]> {
  const stored = (context.stored?.models ?? []).filter(
    (model): model is RefuselessModel => model.provider === REFUSELESS_PROVIDER_ID,
  );
  const key = context.credential?.type === "api_key" ? context.credential.key : undefined;
  if (!key) return stored;
  return catalogModels(await requestCatalog(context.baseUrl ?? REFUSELESS_BASE_URL, key, context.signal));
}
