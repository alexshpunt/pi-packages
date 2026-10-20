import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Image requests use Pi's `openai-codex` (ChatGPT Plus/Pro) login: only that subscription token
 * is accepted by the ChatGPT Images backend. The chat provider/model is never changed.
 */
export const IMAGE_AUTH_PROVIDER = "openai-codex";
/** Fallback used only when neither Pi's resolved auth nor provider supplies a base URL. */
export const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api";
/** JWT claim namespace holding `chatgpt_account_id` (same claim Pi's Codex provider reads). */
const CHATGPT_AUTH_CLAIM = "https://api.openai.com/auth";
/** `originator` value Pi's own `openai-codex` requests send. */
const ORIGINATOR = "pi";
const USER_AGENT = "pi-codex-image-gen";
/** Model-facing guidance when Pi cannot resolve the ChatGPT subscription login at call time. */
export const MISSING_CREDENTIAL_MESSAGE =
    "image generation failed: no usable ChatGPT subscription credentials are configured for Pi's `openai-codex` provider. " +
    "Run `/login openai-codex` and sign in with ChatGPT Plus/Pro. " +
    "The current chat model does not need to change.";

export interface OpenAiCredentials {
    apiKey: string;
    headers: Record<string, string>;
    baseUrl: string;
}

export type CredentialResolution =
    | { ok: true; credentials: OpenAiCredentials }
    | { ok: false; error: string };

/** Reads `chatgpt_account_id` from the access token in memory; never logged or persisted. */
function chatgptAccountId(token: string): string | undefined {
    const payload = token.split(".")[1];
    if (payload === undefined) {
        return undefined;
    }
    try {
        const claims = JSON.parse(
            Buffer.from(payload, "base64url").toString("utf8"),
        ) as Record<string, { chatgpt_account_id?: unknown } | undefined>;
        const accountId = claims[CHATGPT_AUTH_CLAIM]?.chatgpt_account_id;
        return typeof accountId === "string" && accountId !== ""
            ? accountId
            : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Resolves the ChatGPT Images backend like Codex's `to_api_provider()` for ChatGPT auth:
 * `<backend-api>/codex` with the account header. Pi owns login, selection, and refresh.
 */
export async function resolveOpenAiCredentials(
    ctx: Pick<ExtensionContext, "modelRegistry">,
): Promise<CredentialResolution> {
    try {
        const result =
            await ctx.modelRegistry.getProviderAuth(IMAGE_AUTH_PROVIDER);
        const token = result?.auth.apiKey;
        if (!token) {
            return { ok: false, error: MISSING_CREDENTIAL_MESSAGE };
        }
        const accountId = chatgptAccountId(token);
        if (accountId === undefined) {
            return { ok: false, error: MISSING_CREDENTIAL_MESSAGE };
        }
        const provider = ctx.modelRegistry.getProvider(IMAGE_AUTH_PROVIDER);
        const base = (
            result.auth.baseUrl ??
            provider?.baseUrl ??
            DEFAULT_CHATGPT_BASE_URL
        ).replace(/\/+$/, "");
        const baseUrl = base.endsWith("/codex") ? base : `${base}/codex`;
        const headers: Record<string, string> = {
            originator: ORIGINATOR,
            "User-Agent": USER_AGENT,
        };
        for (const [name, value] of Object.entries(result.auth.headers ?? {})) {
            if (typeof value === "string") {
                headers[name] = value;
            }
        }
        headers["chatgpt-account-id"] = accountId;
        return { ok: true, credentials: { apiKey: token, headers, baseUrl } };
    } catch {
        return { ok: false, error: MISSING_CREDENTIAL_MESSAGE };
    }
}
