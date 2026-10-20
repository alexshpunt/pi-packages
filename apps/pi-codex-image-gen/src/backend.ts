import { STATUS_CODES } from "node:http";
import type { ImageRequestPlan } from "./arguments.js";
import type { OpenAiCredentials } from "./auth.js";

/**
 * Codex API-provider retry defaults (`ApiRetryConfig` in `model-provider-info/src/lib.rs`):
 * one initial attempt plus `maxRetries` retries, 200 ms base delay, 5xx and transport errors
 * only.
 */
export const RETRY_POLICY = {
    maxRetries: 4,
    baseDelayMs: 200,
    retry429: false,
    retry5xx: true,
    retryTransport: true,
} as const;

/** A reference image prepared for `/images/edits`. */
export interface ReferenceImage {
    bytes: Uint8Array;
    mimeType: string;
    fileName: string;
}

/** `ImageData` in Codex `codex-api/src/images.rs`. */
export interface ImageData {
    b64_json: string;
    generation_id?: string;
}

/** `ImageResponse` in Codex `codex-api/src/images.rs`. */
export interface ImageResponse {
    created: number;
    data: ImageData[];
    background?: "transparent" | "opaque" | "auto";
    quality?: "low" | "medium" | "high" | "auto";
    size?: string;
}

type TransportFailure =
    | {
          kind: "http";
          status: number;
          body: string | null;
          retryAfterDeadlineMs: number | null;
      }
    | { kind: "timeout" }
    | { kind: "connection"; message: string }
    | { kind: "network"; message: string }
    | { kind: "retryLimit" };

/** Transport-level failure with Codex's `TransportError` display text as `message`. */
class TransportError extends Error {
    constructor(readonly failure: TransportFailure) {
        super(formatTransportFailure(failure));
        this.name = "TransportError";
    }
}

/**
 * Failure of an image request. `message` is Codex's `ApiError` display text, to be prefixed
 * with `image generation failed: ` by the tool.
 */
export class ImageRequestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ImageRequestError";
    }
}

/** Rust `Debug` formatting of a `str`. */
function rustDebugString(text: string): string {
    let out = '"';
    for (const char of text) {
        switch (char) {
            case '"':
                out += '\\"';
                break;
            case "\\":
                out += "\\\\";
                break;
            case "\n":
                out += "\\n";
                break;
            case "\r":
                out += "\\r";
                break;
            case "\t":
                out += "\\t";
                break;
            case "\0":
                out += "\\0";
                break;
            default: {
                const code = char.codePointAt(0) ?? 0;
                out +=
                    code < 0x20 || code === 0x7f
                        ? `\\u{${code.toString(16)}}`
                        : char;
            }
        }
    }
    return `${out}"`;
}

/** `TransportError`'s `Display` in Codex `http-client/src/error.rs`. */
function formatTransportFailure(failure: TransportFailure): string {
    switch (failure.kind) {
        case "http": {
            const reason =
                STATUS_CODES[failure.status] ?? "<unknown status code>";
            const body =
                failure.body === null
                    ? "None"
                    : `Some(${rustDebugString(failure.body)})`;
            return `http ${failure.status} ${reason}: ${body}`;
        }
        case "timeout":
            return "timeout";
        case "connection":
            return `connection failed: ${failure.message}`;
        case "network":
            return `network error: ${failure.message}`;
        case "retryLimit":
            return "retry limit reached";
    }
}

const CONNECTION_ERROR_CODES = new Set([
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EAI_FAIL",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENETDOWN",
    "EADDRNOTAVAIL",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "CERT_HAS_EXPIRED",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "ERR_TLS_CERT_ALTNAME_INVALID",
]);
const TIMEOUT_ERROR_CODES = new Set([
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
]);

/** Mirrors `ReqwestTransport::map_error`: connect errors, then timeouts, then other failures. */
function classifyFetchError(error: unknown): TransportFailure {
    const cause =
        error instanceof Error && error.cause instanceof Error
            ? error.cause
            : error;
    const code =
        typeof cause === "object" && cause !== null && "code" in cause
            ? String((cause as { code: unknown }).code)
            : "";
    const message = cause instanceof Error ? cause.message : String(cause);
    if (
        CONNECTION_ERROR_CODES.has(code) ||
        code.startsWith("ERR_TLS") ||
        code.startsWith("ERR_SSL")
    ) {
        return { kind: "connection", message };
    }
    if (TIMEOUT_ERROR_CODES.has(code)) {
        return { kind: "timeout" };
    }
    return { kind: "network", message };
}

/** `RetryAfter::from_header`: nonnegative delay seconds or an HTTP date. */
function retryAfterDeadline(
    header: string | null,
    receivedAtMs: number,
): number | null {
    if (header === null) {
        return null;
    }
    const value = header.trim();
    if (value !== "" && /^[0-9]+$/.test(value)) {
        return receivedAtMs + Number(value) * 1000;
    }
    const date = Date.parse(value);
    if (Number.isNaN(date)) {
        return null;
    }
    return receivedAtMs + Math.max(0, date - receivedAtMs);
}

function shouldRetry(failure: TransportFailure, attempt: number): boolean {
    if (attempt >= RETRY_POLICY.maxRetries) {
        return false;
    }
    switch (failure.kind) {
        case "http":
            return (
                (RETRY_POLICY.retry429 && failure.status === 429) ||
                (RETRY_POLICY.retry5xx &&
                    failure.status >= 500 &&
                    failure.status <= 599)
            );
        case "timeout":
        case "connection":
        case "network":
            return RETRY_POLICY.retryTransport;
        case "retryLimit":
            return false;
    }
}

/** `backoff` in Codex `codex-client/src/retry.rs`: base × 2^(attempt−1) with ±10% jitter. */
function backoffMs(attempt: number, random: () => number): number {
    if (attempt === 0) {
        return RETRY_POLICY.baseDelayMs;
    }
    const raw = RETRY_POLICY.baseDelayMs * 2 ** (attempt - 1);
    const jitter = 0.9 + random() * 0.2;
    return Math.floor(raw * jitter);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException("This operation was aborted", "AbortError");
    }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
        throwIfAborted(signal);
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        function onAbort(): void {
            clearTimeout(timer);
            try {
                throwIfAborted(signal);
            } catch (error) {
                reject(error);
            }
        }
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

interface SerdeField {
    present: boolean;
    value: unknown;
}

function field(object: Record<string, unknown>, name: string): SerdeField {
    return { present: name in object, value: object[name] };
}

/** Mirrors serde's `Unexpected` display for a JSON value. */
function describeUnexpected(value: unknown): string {
    if (value === null) {
        return "null";
    }
    if (typeof value === "boolean") {
        return `boolean \`${value}\``;
    }
    if (typeof value === "number") {
        return Number.isInteger(value)
            ? `integer \`${value}\``
            : `floating point \`${value}\``;
    }
    if (typeof value === "string") {
        return `string ${JSON.stringify(value)}`;
    }
    if (Array.isArray(value)) {
        return "sequence";
    }
    return "map";
}

function decodeError(value: unknown, expected: string): Error {
    return new Error(
        `invalid type: ${describeUnexpected(value)}, expected ${expected}`,
    );
}

function expectEnum<T extends string>(
    name: string,
    value: unknown,
    variants: readonly T[],
): T | undefined {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (typeof value !== "string") {
        throw decodeError(value, `enum ${name}`);
    }
    if (!variants.includes(value as T)) {
        throw new Error(
            `unknown variant \`${value}\`, expected one of ${variants.map((variant) => `\`${variant}\``).join(", ")}`,
        );
    }
    return value as T;
}

function decodeImageData(value: unknown): ImageData {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw decodeError(value, "struct ImageData");
    }
    const object = value as Record<string, unknown>;
    const b64 = field(object, "b64_json");
    if (!b64.present) {
        throw new Error("missing field `b64_json`");
    }
    if (typeof b64.value !== "string") {
        throw decodeError(b64.value, "a string");
    }
    const result: ImageData = { b64_json: b64.value };
    const generationId = field(object, "generation_id");
    if (generationId.present && generationId.value !== null) {
        if (typeof generationId.value !== "string") {
            throw decodeError(generationId.value, "a string");
        }
        result.generation_id = generationId.value;
    }
    return result;
}

/** Deserializes `ImageResponse` with serde's required/optional semantics and messages. */
function decodeImageResponse(text: string): ImageResponse {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw decodeError(value, "struct ImageResponse");
    }
    const object = value as Record<string, unknown>;
    const created = field(object, "created");
    if (!created.present) {
        throw new Error("missing field `created`");
    }
    if (typeof created.value !== "number" || !Number.isInteger(created.value)) {
        throw decodeError(created.value, "u64");
    }
    if (created.value < 0) {
        throw new Error(
            `invalid value: integer \`${created.value}\`, expected u64`,
        );
    }
    const data = field(object, "data");
    if (!data.present) {
        throw new Error("missing field `data`");
    }
    if (!Array.isArray(data.value)) {
        throw decodeError(data.value, "a sequence");
    }
    const response: ImageResponse = {
        created: created.value,
        data: data.value.map(decodeImageData),
    };
    const background = expectEnum("ImageBackground", object.background, [
        "transparent",
        "opaque",
        "auto",
    ]);
    if (background !== undefined) {
        response.background = background;
    }
    const quality = expectEnum("ImageQuality", object.quality, [
        "low",
        "medium",
        "high",
        "auto",
    ]);
    if (quality !== undefined) {
        response.quality = quality;
    }
    if (object.size !== undefined && object.size !== null) {
        if (typeof object.size !== "string") {
            throw decodeError(object.size, "a string");
        }
        response.size = object.size;
    }
    return response;
}

export interface ImagesClientOptions {
    /** Injected for tests; defaults to the global fetch. */
    fetch?: typeof fetch;
    /** Injected for tests; defaults to Math.random. */
    random?: () => number;
}

/** `ImageReference::Inline` data URL (`into_data_url` in Codex). */
function imageDataUrl(image: ReferenceImage): string {
    return `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`;
}

/**
 * Images client for the ChatGPT Images backend: JSON `POST {baseUrl}/images/generations` and
 * `POST {baseUrl}/images/edits`, with Codex's request bodies, retry policy, and failure text
 * (`ImagesClient` in Codex `codex-api/src/endpoint/images.rs`).
 */
export class ImagesClient {
    private readonly fetchImpl: typeof fetch;
    private readonly random: () => number;

    constructor(
        private readonly credentials: OpenAiCredentials,
        options: ImagesClientOptions = {},
    ) {
        this.fetchImpl = options.fetch ?? fetch;
        this.random = options.random ?? Math.random;
    }

    async generate(
        plan: ImageRequestPlan,
        signal?: AbortSignal,
    ): Promise<ImageResponse> {
        const body = JSON.stringify({
            prompt: plan.prompt,
            background: plan.background,
            model: plan.model,
            quality: plan.quality,
            size: plan.size,
        });
        return this.post(
            "images/generations",
            body,
            "image generation",
            signal,
        );
    }

    async edit(
        plan: ImageRequestPlan,
        images: readonly ReferenceImage[],
        signal?: AbortSignal,
    ): Promise<ImageResponse> {
        const body = JSON.stringify({
            images: images.map((image) => ({ image_url: imageDataUrl(image) })),
            prompt: plan.prompt,
            background: plan.background,
            model: plan.model,
            quality: plan.quality,
            size: plan.size,
        });
        return this.post("images/edits", body, "image edit", signal);
    }

    private async post(
        path: string,
        body: string,
        operation: string,
        signal: AbortSignal | undefined,
    ): Promise<ImageResponse> {
        const url = `${this.credentials.baseUrl}/${path}`;
        let text: string;
        try {
            text = await this.runWithRetry(
                () => this.send(url, body, signal),
                signal,
            );
        } catch (error) {
            if (error instanceof TransportError) {
                throw new ImageRequestError(
                    this.redactErrorText(error.message),
                );
            }
            throw error;
        }
        try {
            const response = decodeImageResponse(text);
            return response;
        } catch (error) {
            const detail =
                error instanceof Error ? error.message : String(error);
            throw new ImageRequestError(
                `stream error: failed to decode ${operation} response: ${this.redactErrorText(detail)}`,
            );
        }
    }

    /** Prevents reflected credentials/account IDs from escaping through error bodies. */
    private redactErrorText(text: string): string {
        let redacted = text;
        const secrets = [this.credentials.apiKey];
        for (const [name, value] of Object.entries(this.credentials.headers)) {
            if (/auth|account[-_]id|api[-_]key|token|secret/i.test(name)) {
                secrets.push(value);
            }
        }
        for (const secret of secrets) {
            if (secret !== "") {
                redacted = redacted.replaceAll(secret, "[REDACTED]");
            }
        }
        return redacted;
    }

    /** One HTTP attempt: returns the success body text or throws `TransportError`. */
    private async send(
        url: string,
        body: string,
        signal: AbortSignal | undefined,
    ): Promise<string> {
        throwIfAborted(signal);
        let response: Response;
        try {
            const headers = new Headers(this.credentials.headers);
            headers.set("Content-Type", "application/json");
            headers.set("Authorization", `Bearer ${this.credentials.apiKey}`);
            response = await this.fetchImpl(url, {
                method: "POST",
                headers,
                body,
                signal,
            });
        } catch (error) {
            throwIfAborted(signal);
            throw new TransportError(classifyFetchError(error));
        }
        const receivedAtMs = Date.now();
        let text: string;
        try {
            text = await response.text();
        } catch (error) {
            throwIfAborted(signal);
            throw new TransportError(classifyFetchError(error));
        }
        if (!response.ok) {
            throw new TransportError({
                kind: "http",
                status: response.status,
                body: this.redactErrorText(text),
                retryAfterDeadlineMs: retryAfterDeadline(
                    response.headers.get("retry-after"),
                    receivedAtMs,
                ),
            });
        }
        return text;
    }

    /** `run_with_retry` in Codex `codex-client/src/retry.rs`. */
    private async runWithRetry<T>(
        attemptOnce: () => Promise<T>,
        signal: AbortSignal | undefined,
    ): Promise<T> {
        for (let attempt = 0; attempt <= RETRY_POLICY.maxRetries; attempt++) {
            try {
                return await attemptOnce();
            } catch (error) {
                if (
                    !(error instanceof TransportError) ||
                    !shouldRetry(error.failure, attempt)
                ) {
                    throw error;
                }
                const retryAttempt = attempt + 1;
                const retryAfter =
                    error.failure.kind === "http"
                        ? error.failure.retryAfterDeadlineMs
                        : null;
                const delayMs =
                    retryAfter === null
                        ? backoffMs(retryAttempt, this.random)
                        : Math.max(0, retryAfter - Date.now());
                await sleep(delayMs, signal);
            }
        }
        throw new TransportError({ kind: "retryLimit" });
    }
}
