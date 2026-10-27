/**
 * Pi tool definitions of MCP tools: the input schema and annotations the server declares, an output
 * schema of the `CallToolResult` scripts receive, and the `_meta` other extensions read.
 */

import type { JsonValue } from "@earendil-works/pi-ai";
import type { ToolAnnotations, ToolDefinition, ToolNamespace } from "@earendil-works/pi-coding-agent";
import type { CallToolResult, McpRequestOptions, Tool as McpTool } from "@earendil-works/pi-mcp";
import { Effect } from "effect";
import type { TSchema } from "typebox";
import { isMaxOutputBytes, type McpExposure, toToolExposure } from "../config/schema.ts";
import type { ToolMeta } from "./meta.ts";
import { convertMcpResult, type McpToolDetails } from "./output.ts";
import { createMcpToolRenderers } from "./render.ts";
import { READ_MCP_RESOURCE_TOOL } from "./resources.ts";

/**
 * Key in the `_meta` of a tool's `tools/list` entry with the bytes of model-facing text the tool's
 * results may have. It takes precedence over the configured `maxOutputBytes`.
 */
const MAX_OUTPUT_BYTES_META_KEY = "pi/maxOutputBytes";

/**
 * A registered MCP tool. `meta` is not sent to the model; it is the `_meta` of the tool's `tools/list`
 * entry, for other extensions (see meta.ts).
 */
export type McpToolDefinition = ToolDefinition<TSchema, McpToolDetails> & { meta?: ToolMeta };

export interface McpToolCaller {
  callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpRequestOptions,
  ): Effect.Effect<CallToolResult, unknown>;
}

/** What a server's tools need of the server, read each time a call runs. */
export interface ToolTarget {
  /** The connection to call `tool` on. Fails when the server or the tool is no longer available. */
  caller(tool: string): Effect.Effect<McpToolCaller, Error>;
  /** Whether `read_mcp_resource` reaches the server's resources. */
  hasReadableResources(): boolean;
  /** The configured `maxOutputBytes` of the server's results, used when the tool's `_meta` declares none. */
  maxOutputBytes(): number | undefined;
}

/**
 * MCP content blocks as one compact type with the fields of text and image blocks, which scripts
 * read most (`image(block)` takes an image block as is). Rendered into every MCP tool's declaration.
 */
const CONTENT_BLOCK_SCHEMA = {
  type: "object",
  properties: {
    type: { enum: ["text", "image", "audio", "resource_link", "resource"] },
    text: { type: "string" },
    data: { type: "string" },
    mimeType: { type: "string" },
  },
  required: ["type"],
  additionalProperties: true,
};

/** Keywords whose values are data, so a `$ref` key in them is not a reference. */
const SCHEMA_DATA_KEYWORDS: ReadonlySet<string> = new Set(["const", "enum", "default", "examples"]);
/** Keywords whose values map names to schemas, so their keys are names, not keywords. */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
  "$defs",
  "definitions",
]);

/**
 * `schema` as a subschema at the JSON pointer `pointer` (`#/properties/structuredContent`) of
 * another schema: its local references (`#`, `#/$defs/Item`) are rewritten to point below
 * `pointer`, so they resolve to the same subschemas as before.
 */
function relocateSchema(schema: unknown, pointer: string): unknown {
  if (Array.isArray(schema)) return schema.map((item) => relocateSchema(item, pointer));
  if (typeof schema !== "object" || schema === null) return schema;
  const relocated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$ref" && typeof value === "string" && (value === "#" || value.startsWith("#/"))) {
      relocated[key] = `${pointer}${value.slice(1)}`;
    } else if (SCHEMA_DATA_KEYWORDS.has(key)) {
      relocated[key] = value;
    } else if (SCHEMA_MAP_KEYWORDS.has(key) && typeof value === "object" && value !== null && !Array.isArray(value)) {
      relocated[key] = Object.fromEntries(
        Object.entries(value).map(([name, subschema]) => [name, relocateSchema(subschema, pointer)]),
      );
    } else {
      relocated[key] = relocateSchema(value, pointer);
    }
  }
  return relocated;
}

/**
 * Output schema of every MCP tool: the `CallToolResult` scripts receive (without `_meta`, which
 * {@link convertMcpResult} drops), with the tool's own output schema as `structuredContent`.
 */
function createMcpResultSchema(structuredContentSchema: Record<string, unknown> | undefined): TSchema {
  return {
    type: "object",
    properties: {
      content: { type: "array", items: CONTENT_BLOCK_SCHEMA },
      // Servers may send structured content without declaring a schema for it, and it may be any JSON value.
      structuredContent: structuredContentSchema
        ? relocateSchema(structuredContentSchema, "#/properties/structuredContent")
        : {},
      isError: { type: "boolean" },
    },
    required: ["content"],
    // Fields newer protocol versions add.
    additionalProperties: true,
  } as unknown as TSchema;
}

/**
 * Tool input schemas must be objects. MCP servers may omit `type`, and some providers reject object
 * schemas without `properties`.
 */
function toParameters(schema: Record<string, unknown>): TSchema {
  return {
    ...schema,
    type: schema.type ?? "object",
    ...(schema.properties === undefined ? { properties: {} } : {}),
  } as unknown as TSchema;
}

const ANNOTATION_HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

/** The boolean hints of an MCP tool's annotations, or undefined when it has none. */
function toToolAnnotations(tool: McpTool): ToolAnnotations | undefined {
  const annotations: ToolAnnotations = {};
  for (const hint of ANNOTATION_HINTS) {
    const value = tool.annotations?.[hint];
    if (typeof value === "boolean") annotations[hint] = value;
  }
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

export function createMcpToolDefinition(options: {
  server: string;
  tool: McpTool;
  name: string;
  exposure: McpExposure;
  namespace: ToolNamespace;
  timeoutMs: number;
  target: ToolTarget;
}): McpToolDefinition {
  const { server, tool, target } = options;
  const title = tool.title ?? tool.annotations?.title;
  const annotations = toToolAnnotations(tool);
  const declared = tool._meta?.[MAX_OUTPUT_BYTES_META_KEY];
  const declaredMaxOutputBytes = isMaxOutputBytes(declared) ? declared : undefined;
  // Passed on to extensions as the server sent it. The type is not checked when the list arrives;
  // it arrived as JSON, so the values of an object are JSON values.
  const meta =
    typeof tool._meta === "object" && tool._meta !== null && !Array.isArray(tool._meta)
      ? (tool._meta as Record<string, JsonValue>)
      : undefined;
  const label = `${server}/${tool.name}`;
  return {
    name: options.name,
    label,
    description: tool.description?.trim() || title || `MCP tool ${tool.name} from server ${server}`,
    parameters: toParameters(tool.inputSchema),
    outputSchema: createMcpResultSchema(tool.outputSchema),
    exposure: toToolExposure(options.exposure),
    namespace: options.namespace,
    ...(annotations ? { annotations } : {}),
    ...(meta ? { meta } : {}),
    ...createMcpToolRenderers(label),
    // Pi's abort signal goes to the MCP request, which fails with the client's own error.
    execute: (_toolCallId, params, signal, onUpdate) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* target.caller(tool.name);
          const result = yield* client.callTool(tool.name, (params ?? {}) as Record<string, unknown>, {
            signal,
            timeoutMs: options.timeoutMs,
            onProgress: (progress) => {
              const total = progress.total === undefined ? "" : `/${progress.total}`;
              const text = progress.message ?? `Progress ${progress.progress}${total}`;
              onUpdate?.({ content: [{ type: "text", text }], details: { server, tool: tool.name } });
            },
          });
          return yield* convertMcpResult(server, tool.name, result, {
            resourceReaderTool: target.hasReadableResources() ? READ_MCP_RESOURCE_TOOL : undefined,
            maxOutputBytes: declaredMaxOutputBytes ?? target.maxOutputBytes(),
          });
        }),
      ),
  };
}
