/**
 * Adapts MCP tools to pi tool definitions.
 *
 * Results map onto pi's model-facing content (text and images). Text over the output limit (20KB
 * unless the tool's `_meta` or the config sets another) keeps its start and end with the middle cut
 * out, like Codex does, and the full text is saved to a temp file the model can read. Binary
 * resources other than images are saved to temp files too, and resource links name
 * the `read_mcp_resource` tool. Codemode scripts receive the whole `CallToolResult` without `_meta`
 * (`content` blocks as sent by the server, `structuredContent`, `isError`), never truncated: it is
 * the tool's `structuredContent`, and every MCP tool declares a `CallToolResult` output schema. MCP
 * errors (`isError`) are error results for the model, but scripts still resolve to the result.
 */

import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent, JsonValue, TextContent } from "@earendil-works/pi-ai";
import {
  type AgentToolResult,
  formatSize,
  type ToolAnnotations,
  type ToolDefinition,
  type ToolExposure,
  type ToolNamespace,
} from "@earendil-works/pi-coding-agent";
import {
  type CallToolResult,
  type ContentBlock,
  type McpRequestOptions,
  type Tool as McpTool,
  toLlmContent,
} from "@earendil-works/pi-mcp";
import type { TSchema } from "typebox";
import { isMaxOutputBytes, type McpExposure } from "./config.ts";
import { createMcpToolRenderers } from "./render.ts";
import type { ToolMeta } from "./tool-meta.ts";

/** MCP resource tools, which reach every server with resources. */
export const LIST_MCP_RESOURCES_TOOL = "list_mcp_resources";
export const LIST_MCP_RESOURCE_TEMPLATES_TOOL = "list_mcp_resource_templates";
/** Tool that reads the resources named by resource links. */
export const READ_MCP_RESOURCE_TOOL = "read_mcp_resource";

/**
 * Tool exposure of an MCP exposure. `codemode` and `deferred` both leave tools out of the codemode
 * description; they differ only in which tool the MCP extension activates to reach them.
 */
export function toToolExposure(exposure: McpExposure): ToolExposure {
  return exposure === "codemode" ? "deferred" : exposure;
}

/** Provider tool names are limited to 64 characters of `[A-Za-z0-9_-]`. */
const MAX_TOOL_NAME_LENGTH = 64;
/** Model-facing text of an MCP result beyond this is cut in the middle, unless another limit is set. */
export const MCP_OUTPUT_MAX_BYTES = 20 * 1024;
/**
 * Key in the `_meta` of a tool's `tools/list` entry with the bytes of model-facing text the tool's
 * results may have. It takes precedence over the configured `maxOutputBytes`.
 */
const MAX_OUTPUT_BYTES_META_KEY = "pi/maxOutputBytes";

export interface McpToolDetails {
  server: string;
  tool: string;
  /** Temp file with the full text output, when the model-facing text was truncated. */
  fullOutputPath?: string;
}

/**
 * A registered MCP tool. `meta` is not sent to the model; it is the `_meta` of the tool's `tools/list`
 * entry, for other extensions (see tool-meta.ts).
 */
export type McpToolDefinition = ToolDefinition<TSchema, McpToolDetails> & { meta?: ToolMeta };

/**
 * Saves the full text of a truncated result, or a binary resource, and returns the file path.
 * `extension` includes the dot, for example `.txt`.
 */
export type McpOutputSaver = (data: string | Uint8Array, extension: string) => Promise<string>;

/** Output can carry private data, so only the user may read the files. */
const OUTPUT_FILE_MODE = 0o600;

/** Write `data` to a new file `<tmpdir>/pi-mcp-<random hex><extension>` and return its path. */
export async function saveToTempFile(data: string | Uint8Array, extension: string): Promise<string> {
  const path = join(tmpdir(), `pi-mcp-${randomBytes(8).toString("hex")}${extension}`);
  // `wx` never follows a link someone else placed at the path.
  await writeFile(path, data, { mode: OUTPUT_FILE_MODE, flag: "wx" });
  return path;
}

export interface McpToolCaller {
  callTool(name: string, args: Record<string, unknown>, options: McpRequestOptions): Promise<CallToolResult>;
}

/**
 * `mcp__<server>__<tool>`, sanitized and shortened with a hash suffix when too long. Like Codex,
 * everything but `[A-Za-z0-9_]` becomes `_`, so the name is also the identifier codemode scripts
 * call it by. `isTaken` reports names used by a different MCP tool: sanitizing can map two tools to
 * one name (`a-b` and `a_b`), which then get the hash suffix.
 */
export function createMcpToolName(
  server: string,
  tool: string,
  isTaken: (name: string) => boolean = () => false,
): string {
  const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
  if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
  const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

function textOf(content: readonly (TextContent | ImageContent)[]): string {
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
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
export function createMcpResultSchema(structuredContentSchema: Record<string, unknown> | undefined): TSchema {
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

/** Number of lines, without the empty line after a final newline. */
function countLines(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.split("\n").length;
  return content.endsWith("\n") ? lines - 1 : lines;
}

interface MiddleTruncation {
  /** The start and end of the content with a `…N chars truncated…` marker between them. */
  content: string;
  truncated: boolean;
  totalBytes: number;
  totalLines: number;
}

/**
 * Keep the start and the end of `content`, half of `maxBytes` each, and replace the middle with a
 * `…N chars truncated…` marker, like Codex does for tool output. Cuts only at character boundaries.
 */
function truncateMiddle(content: string, maxBytes: number): MiddleTruncation {
  const buf = Buffer.from(content, "utf-8");
  const totalLines = countLines(content);
  if (buf.length <= maxBytes) return { content, truncated: false, totalBytes: buf.length, totalLines };
  // Continuation bytes (10xxxxxx) are not character starts.
  const isBoundary = (index: number) => index >= buf.length || (buf[index] & 0xc0) !== 0x80;
  let headEnd = Math.floor(maxBytes / 2);
  while (headEnd > 0 && !isBoundary(headEnd)) headEnd--;
  let tailStart = buf.length - (maxBytes - Math.floor(maxBytes / 2));
  while (tailStart < buf.length && !isBoundary(tailStart)) tailStart++;
  const head = buf.subarray(0, headEnd).toString("utf-8");
  const tail = buf.subarray(tailStart).toString("utf-8");
  const removedChars = Array.from(buf.subarray(headEnd, tailStart).toString("utf-8")).length;
  return {
    content: `${head}…${removedChars} chars truncated…${tail}`,
    truncated: true,
    totalBytes: buf.length,
    totalLines,
  };
}

/**
 * Keep model-facing text within `maxOutputBytes`. Longer text becomes one text block in Codex's
 * truncation format, followed by the path of the file with the full text; images follow it.
 */
export async function limitMcpContent(
  content: (TextContent | ImageContent)[],
  saveOutput: McpOutputSaver = saveToTempFile,
  maxOutputBytes: number = MCP_OUTPUT_MAX_BYTES,
): Promise<{ content: (TextContent | ImageContent)[]; fullOutputPath?: string }> {
  const combined = textOf(content);
  const truncation = truncateMiddle(combined, maxOutputBytes);
  if (!truncation.truncated) return { content };
  let fullOutputPath: string | undefined;
  let where: string;
  try {
    fullOutputPath = await saveOutput(combined, ".txt");
    where = `[Full output: ${fullOutputPath} (read it with offset/limit)]`;
  } catch (error) {
    where = `[Could not save the full output: ${error instanceof Error ? error.message : String(error)}]`;
  }
  const tokens = Math.ceil(truncation.totalBytes / 4);
  const text = `Warning: truncated output (original token count: ${tokens})\nTotal output lines: ${truncation.totalLines}\n\n${truncation.content}\n\n${where}`;
  return {
    content: [{ type: "text", text }, ...content.filter((block) => block.type === "image")],
    ...(fullOutputPath ? { fullOutputPath } : {}),
  };
}

export interface ConvertMcpResultOptions {
  /** Saves truncated text and binary resources. Default: a temp file. */
  saveOutput?: McpOutputSaver;
  /** Whether the server's resources can be read with `read_mcp_resource`, which resource links then name. */
  readableResources?: boolean;
  /** Bytes of model-facing text the result may have. Default: {@link MCP_OUTPUT_MAX_BYTES}. */
  maxOutputBytes?: number;
}

/** File extension for a saved binary resource: the one its URI ends in, else `.bin`. */
function extensionOf(uri: string): string {
  const path = URL.canParse(uri) ? new URL(uri).pathname : uri;
  return /\.[A-Za-z0-9]{1,8}$/.exec(path)?.[0] ?? ".bin";
}

/** Blobs of these types are shown as text. */
function isTextMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  const type = mimeType.split(";", 1)[0].trim().toLowerCase();
  return type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type.endsWith("+xml");
}

/** Model-facing content of one block of `server`'s result. */
async function blockToContent(
  server: string,
  block: ContentBlock,
  options: ConvertMcpResultOptions,
): Promise<(TextContent | ImageContent)[]> {
  if (block.type === "resource_link") {
    const details = [block.mimeType, block.size === undefined ? undefined : formatSize(block.size)].filter(Boolean);
    const read = options.readableResources ? `. Read it with ${READ_MCP_RESOURCE_TOOL} (server "${server}")` : "";
    const description = block.description ? `: ${block.description}` : "";
    return [
      {
        type: "text",
        text: `[Resource ${block.uri} "${block.title ?? block.name}"${details.length > 0 ? ` (${details.join(", ")})` : ""}${description}${read}]`,
      },
    ];
  }
  if (block.type === "resource" && "blob" in block.resource && !block.resource.mimeType?.startsWith("image/")) {
    const { uri, mimeType, blob } = block.resource;
    const data = Buffer.from(blob, "base64");
    if (isTextMimeType(mimeType)) return [{ type: "text", text: data.toString("utf8") }];
    const kind = `${mimeType ?? "unknown type"}, ${formatSize(data.length)}`;
    try {
      const path = await (options.saveOutput ?? saveToTempFile)(data, extensionOf(uri));
      return [{ type: "text", text: `[Binary resource ${uri} (${kind}) saved to ${path}]` }];
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return [{ type: "text", text: `[Binary resource ${uri} (${kind}) could not be saved: ${reason}]` }];
    }
  }
  return toLlmContent({ content: [block] });
}

/** Model-facing content of `server`'s content blocks, before the output limit. */
export async function toModelContent(
  server: string,
  blocks: readonly ContentBlock[],
  options: ConvertMcpResultOptions = {},
): Promise<(TextContent | ImageContent)[]> {
  return (await Promise.all(blocks.map((block) => blockToContent(server, block, options)))).flat();
}

/** Convert an MCP result. `isError` results become error results that keep the structured result. */
export async function convertMcpResult(
  server: string,
  tool: string,
  result: CallToolResult,
  options: ConvertMcpResultOptions = {},
): Promise<AgentToolResult<McpToolDetails>> {
  // Without content blocks, toLlmContent falls back to the structured content as JSON.
  const converted: (TextContent | ImageContent)[] =
    result.content.length > 0 ? await toModelContent(server, result.content, options) : toLlmContent(result);
  if (result.isError && textOf(converted) === "") {
    converted.push({ type: "text", text: `MCP tool ${server}/${tool} returned an error` });
  }
  const { content, fullOutputPath } = await limitMcpContent(converted, options.saveOutput, options.maxOutputBytes);
  const { _meta: _ignored, ...scriptResult } = result;
  return {
    content,
    details: { server, tool, ...(fullOutputPath ? { fullOutputPath } : {}) },
    structuredContent: scriptResult as unknown as JsonValue,
    ...(result.isError ? { isError: true } : {}),
  };
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
  getClient: () => Promise<McpToolCaller>;
  /** Whether `read_mcp_resource` can read the server's resources. */
  readableResources?: () => boolean;
  /** The configured `maxOutputBytes` of the tool's results, used when the tool's `_meta` declares none. */
  maxOutputBytes?: () => number | undefined;
}): McpToolDefinition {
  const { server, tool } = options;
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
    async execute(_toolCallId, params, signal, onUpdate) {
      const client = await options.getClient();
      const result = await client.callTool(tool.name, (params ?? {}) as Record<string, unknown>, {
        signal,
        timeoutMs: options.timeoutMs,
        onProgress: (progress) => {
          const total = progress.total === undefined ? "" : `/${progress.total}`;
          const text = progress.message ?? `Progress ${progress.progress}${total}`;
          onUpdate?.({ content: [{ type: "text", text }], details: { server, tool: tool.name } });
        },
      });
      return convertMcpResult(server, tool.name, result, {
        readableResources: options.readableResources?.(),
        maxOutputBytes: declaredMaxOutputBytes ?? options.maxOutputBytes?.(),
      });
    },
  };
}
