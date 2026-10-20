import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
    AgentToolResult,
    ExtensionAPI,
    ToolAnnotations,
    ToolDefinition,
    ToolNamespace,
} from "@earendil-works/pi-coding-agent";
import {
    type CallToolResult,
    McpAbortError,
    type Tool,
    toLlmContent,
} from "@earendil-works/pi-mcp";
import type { ActiveCallTracker } from "./active-call.js";
import type { BridgeConnection } from "./connection.js";
import type { BridgeLog } from "./log.js";
import { BROWSER_BACKENDS_VARIABLE } from "./runtime.js";
import type { TSchema } from "./typebox.js";

export const SERVER_NAME = "cua_repl";
/** Tools the model may call; `turn_ended` and `js_add_node_module_dir` stay internal. */
export const EXPOSED_TOOLS: readonly string[] = ["js", "js_reset"];
export const NAMESPACE_NAME = `mcp__${SERVER_NAME}`;

export function bridgeToolName(tool: string): string {
    return `mcp__${SERVER_NAME}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

export const TOOL_NAMES: readonly string[] = EXPOSED_TOOLS.map(bridgeToolName);

/** Codex sets `output_token_limit: 25000`; a token is taken as four bytes. */
export const BYTES_PER_TOKEN = 4;

export interface CallMetaInput {
    callId: string;
    sessionId: string;
    turnId: string;
    turnStartedAtUnixMs?: number;
    model?: string;
}

/**
 * The `_meta` Codex puts on `tools/call` (core/src/mcp_tool_call.rs). Browser Use requires
 * `x-codex-turn-metadata.session_id` and `turn_id` (02-feasibility.json metaRequired).
 */
export function buildCallMeta(input: CallMetaInput): Record<string, unknown> {
    return {
        callId: input.callId,
        sessionId: input.sessionId,
        threadId: input.sessionId,
        "x-codex-turn-metadata": {
            session_id: input.sessionId,
            thread_id: input.sessionId,
            turn_id: input.turnId,
            ...(input.model ? { model: input.model } : {}),
            auto_review_enabled: false,
            node_repl_auto_review_required: false,
            node_repl_disabled: false,
            turn_started_at_unix_ms: input.turnStartedAtUnixMs ?? Date.now(),
        },
        "openai/confirmation_policies": {},
    };
}

export interface BridgeToolDetails {
    server: string;
    tool: string;
    durationMs: number;
    /** `_meta` the runtime attached to the result (for example `codex/toolSurface`). */
    resultMeta: Record<string, unknown> | null;
    fullOutputPath?: string;
    cancelled?: boolean;
}

export type BridgeToolResult = AgentToolResult<BridgeToolDetails>;

async function saveFullOutput(text: string): Promise<string> {
    const path = join(
        tmpdir(),
        `pi-codex-computer-use-${randomBytes(8).toString("hex")}.txt`,
    );
    await writeFile(path, text, { mode: 0o600 });
    return path;
}

/** Keeps the start and end of `text` within `maxBytes`, cutting the middle like Codex and pi do. */
export function truncateMiddle(
    text: string,
    maxBytes: number,
): {
    text: string;
    truncated: boolean;
    totalBytes: number;
    totalLines: number;
} {
    const totalBytes = Buffer.byteLength(text);
    const totalLines = text ? text.split("\n").length : 0;
    if (totalBytes <= maxBytes)
        return { text, truncated: false, totalBytes, totalLines };
    const buffer = Buffer.from(text);
    const half = Math.max(1, Math.floor(maxBytes / 2));
    const head = buffer
        .subarray(0, half)
        .toString("utf8")
        .replace(/\uFFFD+$/, "");
    const tail = buffer
        .subarray(buffer.length - half)
        .toString("utf8")
        .replace(/^\uFFFD+/, "");
    const omitted =
        totalBytes - Buffer.byteLength(head) - Buffer.byteLength(tail);
    return {
        text: `${head}\n\n[... ${omitted} bytes truncated ...]\n\n${tail}`,
        truncated: true,
        totalBytes,
        totalLines,
    };
}

export interface ConvertOptions {
    tool: string;
    limitBytes: number;
    durationMs: number;
    saveOutput?: (text: string) => Promise<string>;
}

/** Text and image blocks for the model, with Codex-style middle truncation past the limit. */
export async function convertCallToolResult(
    result: CallToolResult,
    options: ConvertOptions,
): Promise<BridgeToolResult> {
    const llmContent = toLlmContent(result);
    const texts = llmContent.filter((block) => block.type === "text");
    const images = llmContent.filter((block) => block.type === "image");
    let content: BridgeToolResult["content"] = [...texts, ...images];
    let fullOutputPath: string | undefined;
    const combined = texts.map((block) => block.text).join("\n");
    const truncation = truncateMiddle(combined, options.limitBytes);
    if (truncation.truncated) {
        let where: string;
        try {
            fullOutputPath = await (options.saveOutput ?? saveFullOutput)(
                combined,
            );
            where = `[Full output: ${fullOutputPath} (read it with offset/limit)]`;
        } catch (error) {
            where = `[Could not save the full output: ${error instanceof Error ? error.message : String(error)}]`;
        }
        const tokens = Math.ceil(truncation.totalBytes / BYTES_PER_TOKEN);
        content = [
            {
                type: "text",
                text: `Warning: truncated output (original token count: ${tokens})\nTotal output lines: ${truncation.totalLines}\n\n${truncation.text}\n\n${where}`,
            },
            ...images,
        ];
    }
    if (result.isError && texts.length === 0)
        content.unshift({
            type: "text",
            text: `MCP tool ${SERVER_NAME}/${options.tool} returned an error`,
        });
    return {
        content,
        details: {
            server: SERVER_NAME,
            tool: options.tool,
            durationMs: options.durationMs,
            resultMeta: result._meta ?? null,
            ...(fullOutputPath ? { fullOutputPath } : {}),
        },
        ...(result.isError ? { isError: true } : {}),
    };
}

function errorResult(
    tool: string,
    text: string,
    durationMs = 0,
    cancelled = false,
): BridgeToolResult {
    return {
        content: [{ type: "text", text }],
        details: {
            server: SERVER_NAME,
            tool,
            durationMs,
            resultMeta: null,
            ...(cancelled ? { cancelled: true } : {}),
        },
        isError: true,
    };
}

/** Input schemas must be objects with `properties` for every provider. */
function toParameters(schema: Record<string, unknown>): TSchema {
    return {
        ...schema,
        type: schema.type ?? "object",
        ...(schema.properties === undefined ? { properties: {} } : {}),
    } as unknown as TSchema;
}

const ANNOTATION_HINTS = [
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
] as const;

function toAnnotations(tool: Tool): ToolAnnotations | undefined {
    const annotations: ToolAnnotations = {};
    for (const hint of ANNOTATION_HINTS) {
        const value = tool.annotations?.[hint];
        if (typeof value === "boolean") annotations[hint] = value;
    }
    return Object.keys(annotations).length > 0 ? annotations : undefined;
}

export interface ToolBridgeDependencies {
    getConnection(): BridgeConnection | undefined;
    /** Current turn id, started on `agent_start` (a call outside a run starts one). */
    ensureTurn(): { turnId: string; startedAtUnixMs: number };
    log: BridgeLog;
    /** Why no server is running, for the model-facing error. */
    describeServer(): string;
    /** A bridged call was cancelled through pi's signal (the user interrupted the run). */
    onCancelled?(): void;
    /** Lets the confirmation handler reach the calling context and append notes to the result. */
    activeCalls?: ActiveCallTracker;
}

function describeError(error: unknown): string {
    if (error instanceof Error) {
        const rpc = (error as Error & { data?: unknown }).data;
        return rpc === undefined
            ? error.message
            : `${error.message} ${JSON.stringify(rpc)}`;
    }
    return String(error);
}

/** Codex's runtime supplies API docs; pi must also disclose its narrower enabled surfaces/backends. */
function toolPromptGuidelines(
    toolName: string,
    connection: BridgeConnection,
): string[] {
    if (toolName === "js_reset")
        return [
            "Resetting cua_repl clears its JavaScript bindings. After a reset, start with exactly one supported cua entry call and read its returned documentation before continuing.",
        ];
    const guidelines = [
        "cua_repl already initializes the global cua API. Do not bootstrap the legacy node_repl, @oai/sky, or browser-client skill setup; use only APIs in the current tool description or returned runtime documentation.",
        "On the first cua_repl js call, and after reset or a settings restart, execute exactly one supported cua entry call (optionally assigning its result). Do not combine it with other API calls, waits, or snapshots. Read the returned documentation/state before the next call.",
        "With their default options, cua entry APIs and getAXState already emit their documentation/UI state. Do not wrap those results again in nodeRepl.write or emitImage. Use nodeRepl.write for additional values and await nodeRepl.emitImage for additional images; bare JavaScript expression values are not output.",
        "The JavaScript REPL is persistent: reuse established app/tab bindings rather than repeatedly bootstrapping. After context compaction, call await cua.rewriteDocumentation() before continuing an existing UI task. After a reset/restart, reacquire bindings instead of reusing stale variables.",
    ];
    if (connection.state.browserUse) {
        const backends =
            connection.environment.env[BROWSER_BACKENDS_VARIABLE] ?? "chrome";
        guidelines.push(
            `Browser Use in this pi session has only these enabled backends: ${backends}. Codex Desktop examples mentioning other backends (iab, mcpapps, edge) do not make them available here. If a user requests an unavailable backend, explain the limit rather than invoking or silently substituting it.`,
        );
        if (backends.split(",").includes("chrome"))
            guidelines.push(
                'For a new browser page without an explicit backend request, use cua.createBrowserTab("chrome", url, { sessionName: "🔎 Task" }). For an existing tab, use cua.getTab with its known reference and browser; do not invent IDs or open a replacement for a missing/ambiguous reference.',
            );
    } else {
        guidelines.push(
            "Browser Use is disabled in this pi session; do not invoke browser entry APIs.",
        );
    }
    if (!connection.state.computerUse)
        guidelines.push(
            "Computer Use is disabled in this pi session; do not invoke native app entry APIs.",
        );
    return guidelines;
}

function createToolDefinition(
    tool: Tool,
    namespace: ToolNamespace,
    deps: ToolBridgeDependencies,
    connection: BridgeConnection,
): ToolDefinition<TSchema, BridgeToolDetails> {
    const name = bridgeToolName(tool.name);
    const annotations = toAnnotations(tool);
    const description =
        tool.description ??
        tool.title ??
        tool.annotations?.title ??
        `MCP tool ${tool.name} from server ${SERVER_NAME}`;
    const guidelines = toolPromptGuidelines(tool.name, connection);
    return {
        name,
        label: `${SERVER_NAME}/${tool.name}`,
        description,
        promptSnippet:
            tool.name === "js"
                ? "Use Codex's initialized cua API for UI automation in a persistent JavaScript REPL."
                : "Reset the cua JavaScript REPL and clear its bindings.",
        promptGuidelines: guidelines,
        // Keep the registered Codex description verbatim. Annotate the model-facing loadout so
        // host limits remain visible even with a caller's custom system prompt.
        prepareLoadout: () => ({
            descriptions: {
                [name]: `pi host guidance:\n${guidelines.map((line) => `- ${line}`).join("\n")}\n\nCodex runtime instructions:\n${description}`,
            },
        }),
        parameters: toParameters(tool.inputSchema),
        exposure: "direct",
        namespace,
        ...(annotations ? { annotations } : {}),
        executionMode: "sequential",
        async execute(toolCallId, params, signal, _onUpdate, ctx) {
            const connection = deps.getConnection();
            if (!connection || connection.isClosed())
                return errorResult(
                    tool.name,
                    `Codex Computer Use server is not running: ${deps.describeServer()}`,
                );
            const turn = deps.ensureTurn();
            const meta = buildCallMeta({
                callId: toolCallId,
                sessionId: ctx.sessionManager.getSessionId(),
                turnId: turn.turnId,
                turnStartedAtUnixMs: turn.startedAtUnixMs,
                model: ctx.model?.id,
            });
            const started = Date.now();
            const active = deps.activeCalls?.begin({
                toolName: tool.name,
                callId: toolCallId,
                ctx,
                signal,
            });
            const withNotes = (result: BridgeToolResult): BridgeToolResult =>
                active && active.notes.length > 0
                    ? {
                          ...result,
                          content: [
                              ...result.content,
                              {
                                  type: "text",
                                  text: `Approval requests during this call: ${active.notes.join(" ")}`,
                              },
                          ],
                      }
                    : result;
            try {
                const result = await connection.client.request<CallToolResult>(
                    "tools/call",
                    {
                        name: tool.name,
                        arguments: (params ?? {}) as Record<string, unknown>,
                        _meta: meta,
                    },
                    { timeoutMs: 0, signal },
                );
                return withNotes(
                    await convertCallToolResult(result, {
                        tool: tool.name,
                        limitBytes:
                            connection.plan.outputTokenLimit * BYTES_PER_TOKEN,
                        durationMs: Date.now() - started,
                    }),
                );
            } catch (error) {
                const durationMs = Date.now() - started;
                if (signal?.aborted || error instanceof McpAbortError) {
                    deps.log.write("tool-cancelled", {
                        tool: tool.name,
                        callId: toolCallId,
                        durationMs,
                    });
                    deps.onCancelled?.();
                    return errorResult(
                        tool.name,
                        `${tool.name} was cancelled`,
                        durationMs,
                        true,
                    );
                }
                deps.log.write("tool-error", {
                    tool: tool.name,
                    callId: toolCallId,
                    durationMs,
                    error: describeError(error),
                });
                return withNotes(
                    errorResult(
                        tool.name,
                        `${tool.name} failed: ${describeError(error)}`,
                        durationMs,
                    ),
                );
            } finally {
                if (active) deps.activeCalls?.end(active);
            }
        },
    };
}

function createHiddenDefinition(
    name: string,
    namespace: ToolNamespace,
    deps: ToolBridgeDependencies,
): ToolDefinition<TSchema, BridgeToolDetails> {
    return {
        name,
        label: `${SERVER_NAME}/${name.slice(NAMESPACE_NAME.length + 2)}`,
        description: "Codex Computer Use is off; this tool is unavailable.",
        parameters: toParameters({}),
        exposure: "hidden",
        namespace,
        async execute() {
            return errorResult(
                name,
                `Codex Computer Use server is not running: ${deps.describeServer()}`,
            );
        },
    };
}

/**
 * Registers `js` and `js_reset` from the server's `tools/list` verbatim (description, schema,
 * annotations, server instructions as the namespace description), with pi host guidance in the
 * model-facing loadout and prompt guidelines. Without a connection, every name
 * registered earlier is re-registered `hidden`, since pi cannot unregister tools. Returns the names
 * currently registered by this package.
 */
export function registerBridgeTools(
    pi: ExtensionAPI,
    connection: BridgeConnection | undefined,
    deps: ToolBridgeDependencies,
    previousNames: readonly string[] = [],
): string[] {
    const namespace: ToolNamespace = {
        name: NAMESPACE_NAME,
        ...(connection?.instructions
            ? { description: connection.instructions }
            : {}),
    };
    const registered: string[] = [];
    if (connection) {
        const allowed = new Set(
            EXPOSED_TOOLS.filter((name) =>
                connection.plan.enabledTools.includes(name),
            ),
        );
        for (const tool of connection.tools) {
            if (!allowed.has(tool.name)) continue;
            pi.registerTool(
                createToolDefinition(tool, namespace, deps, connection),
            );
            registered.push(bridgeToolName(tool.name));
        }
    }
    for (const name of previousNames)
        if (!registered.includes(name))
            pi.registerTool(createHiddenDefinition(name, namespace, deps));
    deps.log.write("tools-registered", {
        active: registered,
        hidden: previousNames.filter((name) => !registered.includes(name)),
    });
    return [...new Set([...registered, ...previousNames])];
}
