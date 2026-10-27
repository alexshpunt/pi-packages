/**
 * Local stand-in for https://api.refuseless.com/v1, used by the tests and `pnpm cli mock|pi --mock`.
 * It follows the documented wire shapes (docs.refuseless.com: authentication, api/chat-completions, api/models,
 * api/credits, guides/*) and accepts any key that starts with `abl_`. It never contacts Refuseless.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * `GET https://api.refuseless.com/v1/models` as it answered on 2026-10-27, plus the `abliterated` flag the catalog
 * added later. The flag values are not from the real catalog: the mock sets true for the IDs that end in
 * `-abliterated`.
 */
export const MOCK_CATALOG = [
  ["glm-5.3-abliterated", 1_048_576, ["low", "high", "max"]],
  ["glm-5.3-flash-abliterated", 1_048_576, ["low", "high", "max"]],
  ["deepseek-v4.1-flash-abliterated", 1_048_576, ["off", "low", "high", "max"]],
  ["deepseek-v4.1-flash-fast", 1_048_576, ["off", "low", "high", "max"]],
  ["minimax-m3.1-flash", 1_048_576, ["low", "high", "max"]],
  ["deepseek-v4.1-flash-free", 524_288, ["low", "high", "max"]],
].map(([id, contextLength, efforts]) => ({
  id: id as string,
  object: "model",
  created: 1_793_061_929,
  owned_by: "refuseless",
  abliterated: (id as string).endsWith("-abliterated"),
  context_length: contextLength as number,
  reasoning_efforts: efforts as string[],
  reasoning_default: "low",
}));

/** `GET /v1/credits`: the example in docs.refuseless.com/api/credits. */
export const MOCK_CREDITS = {
  object: "credits",
  balance: 42.5,
  reserved: 1.2,
  available: 41.3,
  key_limit: null,
  unit: "usd",
  updated_at: 1_793_836_800,
};

/** One request as the mock received it. `authorization` is kept for assertions; `describeRequest` redacts it. */
export interface MockRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: any;
}

/** Writes a reply and returns true, or returns false to use the default reply. */
export type MockResponder = (request: MockRequest, response: ServerResponse) => boolean | Promise<boolean>;

export interface MockOptions {
  /** 0 or omitted picks a free port. */
  port?: number;
  respond?: MockResponder;
  onRequest?: (request: MockRequest) => void;
  /** Pause between stream chunks, so a client can cancel mid-stream. */
  chunkDelayMs?: number;
  /** `GET /v1/models` entries; defaults to MOCK_CATALOG. Chat requests accept only these IDs. */
  catalog?: readonly { id: string; reasoning_efforts?: string[] }[];
}

export interface MockRefuseless {
  /** Base URL including `/v1`, as Pi's `baseUrl` expects. */
  baseUrl: string;
  requests: MockRequest[];
  /** Requests whose client disconnected before the reply finished. */
  disconnects: MockRequest[];
  close(): Promise<void>;
}

export function apiError(response: ServerResponse, status: number, code: string, message: string, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify({ error: { code, message, type: "api_error" } }));
}

/** Streams `data:` frames, optionally pausing between them, and ends with `[DONE]` unless `done` is false. */
export async function streamFrames(
  response: ServerResponse,
  frames: readonly (object | string)[],
  { delayMs = 0, done = true }: { delayMs?: number; done?: boolean } = {},
) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const frame of frames) {
    if (response.destroyed) return;
    response.write(`data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (done && !response.destroyed) response.write("data: [DONE]\n\n");
  response.end();
}

/** A `chat.completion.chunk` with one choice. */
export function chunk(model: string, delta: object, finishReason: string | null = null, extra: object = {}) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra,
  };
}

export function usageChunk(model: string, promptTokens: number, completionTokens: number, cachedTokens?: number) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model,
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      ...(cachedTokens === undefined ? {} : { prompt_tokens_details: { cached_tokens: cachedTokens } }),
    },
  };
}

/** One log line per request, without the key or message contents. */
export function describeRequest(request: MockRequest): string {
  const key = request.authorization?.startsWith("Bearer ")
    ? `Bearer ${request.authorization.slice(7, 11)}…`
    : (request.authorization ?? "no Authorization");
  const body = request.body ?? {};
  const details = [
    body.model && `model=${body.model}`,
    body.reasoning_effort !== undefined && `reasoning_effort=${body.reasoning_effort}`,
    Array.isArray(body.messages) && `messages=${body.messages.length}`,
    Array.isArray(body.tools) && `tools=${body.tools.length}`,
  ].filter(Boolean);
  return `${request.method} ${request.path} (${key}${details.length ? `, ${details.join(", ")}` : ""})`;
}

function lastUserText(messages: any[]): string {
  const user = [...messages].reverse().find((message) => message.role === "user");
  if (!user) return "";
  if (typeof user.content === "string") return user.content;
  return Array.isArray(user.content)
    ? user.content.map((part: any) => (part.type === "text" ? part.text : "")).join(" ")
    : "";
}

/**
 * Default chat replies, chosen by the last message:
 * - after a tool result: a text reply that quotes the result;
 * - user text containing "credits": partial text, then the documented mid-stream `insufficient_credits` error;
 * - user text containing "busy": `429 model_busy`;
 * - user text containing "tool" when the request declares `bash`: one `bash` call that runs `echo`;
 * - otherwise: reasoning (unless reasoning_effort is "off") and a text reply naming the model and effort.
 */
async function defaultChat(request: MockRequest, response: ServerResponse, delayMs: number) {
  const body = request.body;
  const model: string = body.model;
  const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
  const last = messages.at(-1);
  const text = lastUserText(messages).toLowerCase();
  const usage = body.stream_options?.include_usage ? [usageChunk(model, 12, 8)] : [];

  if (last?.role === "tool") {
    const result = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
    return streamFrames(
      response,
      [
        chunk(model, { role: "assistant", content: `Tool result: ${result.trim()}` }),
        chunk(model, {}, "stop"),
        ...usage,
      ],
      { delayMs },
    );
  }
  if (text.includes("credits")) {
    return streamFrames(
      response,
      [
        chunk(model, { role: "assistant", content: "Partial answer" }),
        { error: { code: "insufficient_credits", message: "Credits ran out. Generation stopped." } },
      ],
      { delayMs },
    );
  }
  if (text.includes("busy")) {
    return apiError(response, 429, "model_busy", "Model is busy. Retry shortly.", { "retry-after": "15" });
  }
  const tools: any[] = Array.isArray(body.tools) ? body.tools : [];
  if (text.includes("tool") && tools.some((tool) => tool.function?.name === "bash")) {
    const call = {
      index: 0,
      id: "call_mock_1",
      type: "function",
      function: { name: "bash", arguments: JSON.stringify({ command: "echo refuseless-mock-tool" }) },
    };
    return streamFrames(
      response,
      [
        chunk(model, { role: "assistant", content: null, tool_calls: [call] }),
        chunk(model, {}, "tool_calls"),
        ...usage,
      ],
      { delayMs },
    );
  }
  const effort = body.reasoning_effort ?? "unset";
  const reasoning = effort === "off" ? [] : [chunk(model, { role: "assistant", reasoning_content: "Mock reasoning." })];
  return streamFrames(
    response,
    [
      ...reasoning,
      chunk(model, { content: `Mock Refuseless reply from ${model} (reasoning_effort: ${effort}).` }),
      chunk(model, {}, "stop"),
      ...usage,
    ],
    { delayMs },
  );
}

async function handle(request: MockRequest, response: ServerResponse, options: MockOptions) {
  const catalog = options.catalog ?? MOCK_CATALOG;
  if (options.respond && (await options.respond(request, response))) return;
  if (!request.authorization?.startsWith("Bearer ") || request.authorization.length <= 7) {
    return apiError(response, 401, "invalid_key", "Missing bearer API key.");
  }
  if (!request.authorization.startsWith("Bearer abl_")) {
    return apiError(response, 401, "invalid_key", "Invalid API key.");
  }
  if (request.method === "GET" && request.path === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: catalog }));
    return;
  }
  if (request.method === "GET" && request.path === "/v1/credits") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(MOCK_CREDITS));
    return;
  }
  if (request.method !== "POST" || request.path !== "/v1/chat/completions") {
    return apiError(response, 404, "not_found", `No mock route for ${request.method} ${request.path}.`);
  }
  const body = request.body;
  if (!body || typeof body.model !== "string") return apiError(response, 400, "bad_request", "Missing model.");
  const entry = catalog.find((model) => model.id === body.model);
  if (!entry) return apiError(response, 404, "model_not_found", `Unknown model '${body.model}'.`);
  const offered = entry.reasoning_efforts ?? [];
  if (body.reasoning_effort !== undefined && !offered.includes(body.reasoning_effort)) {
    return apiError(
      response,
      400,
      "bad_request",
      `Unsupported reasoning_effort '${body.reasoning_effort}' for ${body.model}. Use one of: ${offered.join(", ")}.`,
    );
  }
  return defaultChat(request, response, options.chunkDelayMs ?? 0);
}

async function readBody(incoming: IncomingMessage): Promise<any> {
  const parts: Buffer[] = [];
  for await (const part of incoming) parts.push(part as Buffer);
  const text = Buffer.concat(parts).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { invalidJson: text };
  }
}

export async function startMockRefuseless(options: MockOptions = {}): Promise<MockRefuseless> {
  const requests: MockRequest[] = [];
  const disconnects: MockRequest[] = [];
  const server = createServer(async (incoming, response) => {
    const request: MockRequest = {
      method: incoming.method ?? "GET",
      path: new URL(incoming.url ?? "/", "http://mock").pathname,
      authorization: incoming.headers.authorization,
      body: await readBody(incoming),
    };
    requests.push(request);
    options.onRequest?.(request);
    response.on("close", () => {
      if (!response.writableFinished) disconnects.push(request);
    });
    try {
      if (request.body?.invalidJson !== undefined) {
        return apiError(response, 400, "bad_request", "Request body is not JSON.");
      }
      await handle(request, response, options);
    } catch (error) {
      if (!response.headersSent) apiError(response, 500, "mock_error", String(error));
      else response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    disconnects,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
