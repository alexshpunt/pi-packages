/**
 * Model-facing content of MCP results.
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

import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent, JsonValue, TextContent } from "@earendil-works/pi-ai";
import { type AgentToolResult, formatSize } from "@earendil-works/pi-coding-agent";
import { type CallToolResult, type ContentBlock, toLlmContent } from "@earendil-works/pi-mcp";
import { Effect } from "effect";
import { errorMessage, fromPromise } from "../shared/effects.ts";

/** Model-facing text of an MCP result beyond this is cut in the middle, unless another limit is set. */
const MCP_OUTPUT_MAX_BYTES = 20 * 1024;

export interface McpToolDetails {
  server: string;
  tool: string;
  /** Temp file with the full text output, when the model-facing text was truncated. */
  fullOutputPath?: string;
}

type ModelContent = (TextContent | ImageContent)[];

/** Output can carry private data, so only the user may read the files. */
const OUTPUT_FILE_MODE = 0o600;

/**
 * Write `data` to a new file `<tmpdir>/pi-mcp-<random hex><extension>` and return its path. `extension`
 * includes the dot, for example `.txt`.
 */
function saveToTempFile(data: string | Uint8Array, extension: string): Effect.Effect<string, unknown> {
  return Effect.suspend(() => {
    const path = join(tmpdir(), `pi-mcp-${randomBytes(8).toString("hex")}${extension}`);
    // `wx` never follows a link someone else placed at the path.
    return Effect.as(
      fromPromise(() => writeFile(path, data, { mode: OUTPUT_FILE_MODE, flag: "wx" })),
      path,
    );
  });
}

function textOf(content: readonly (TextContent | ImageContent)[]): string {
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
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
  isTruncated: boolean;
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
  if (buf.length <= maxBytes) return { content, isTruncated: false, totalBytes: buf.length, totalLines };
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
    isTruncated: true,
    totalBytes: buf.length,
    totalLines,
  };
}

/**
 * Keep model-facing text within `maxOutputBytes`. Longer text becomes one text block in Codex's
 * truncation format, followed by the path of the file with the full text; images follow it.
 */
export function limitMcpContent(
  content: ModelContent,
  maxOutputBytes: number = MCP_OUTPUT_MAX_BYTES,
): Effect.Effect<{ content: ModelContent; fullOutputPath?: string }> {
  return Effect.gen(function* () {
    const combined = textOf(content);
    const truncation = truncateMiddle(combined, maxOutputBytes);
    if (!truncation.isTruncated) return { content };
    const saved = yield* Effect.result(saveToTempFile(combined, ".txt"));
    const fullOutputPath = saved._tag === "Success" ? saved.success : undefined;
    const where =
      saved._tag === "Success"
        ? `[Full output: ${saved.success} (read it with offset/limit)]`
        : `[Could not save the full output: ${errorMessage(saved.failure)}]`;
    const tokens = Math.ceil(truncation.totalBytes / 4);
    const text = `Warning: truncated output (original token count: ${tokens})\nTotal output lines: ${truncation.totalLines}\n\n${truncation.content}\n\n${where}`;
    return {
      content: [{ type: "text", text }, ...content.filter((block) => block.type === "image")],
      ...(fullOutputPath ? { fullOutputPath } : {}),
    };
  });
}

export interface ConvertMcpResultOptions {
  /** Tool that reads the server's resources, which resource links then name. Unset when none can. */
  resourceReaderTool?: string;
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
function blockToContent(
  server: string,
  block: ContentBlock,
  options: ConvertMcpResultOptions,
): Effect.Effect<ModelContent> {
  if (block.type === "resource_link") {
    const details = [block.mimeType, block.size === undefined ? undefined : formatSize(block.size)].filter(Boolean);
    const read = options.resourceReaderTool ? `. Read it with ${options.resourceReaderTool} (server "${server}")` : "";
    const description = block.description ? `: ${block.description}` : "";
    return Effect.succeed([
      {
        type: "text",
        text: `[Resource ${block.uri} "${block.title ?? block.name}"${details.length > 0 ? ` (${details.join(", ")})` : ""}${description}${read}]`,
      },
    ]);
  }
  if (block.type === "resource" && "blob" in block.resource && !block.resource.mimeType?.startsWith("image/")) {
    const { uri, mimeType, blob } = block.resource;
    const data = Buffer.from(blob, "base64");
    if (isTextMimeType(mimeType)) return Effect.succeed([{ type: "text", text: data.toString("utf8") }]);
    const kind = `${mimeType ?? "unknown type"}, ${formatSize(data.length)}`;
    return saveToTempFile(data, extensionOf(uri)).pipe(
      Effect.match({
        onSuccess: (path): ModelContent => [
          { type: "text", text: `[Binary resource ${uri} (${kind}) saved to ${path}]` },
        ],
        onFailure: (error): ModelContent => [
          { type: "text", text: `[Binary resource ${uri} (${kind}) could not be saved: ${errorMessage(error)}]` },
        ],
      }),
    );
  }
  return Effect.sync(() => toLlmContent({ content: [block] }));
}

/** Model-facing content of `server`'s content blocks, before the output limit. */
export function toModelContent(
  server: string,
  blocks: readonly ContentBlock[],
  options: ConvertMcpResultOptions = {},
): Effect.Effect<ModelContent> {
  return Effect.map(
    Effect.forEach(blocks, (block) => blockToContent(server, block, options), { concurrency: "unbounded" }),
    (contents) => contents.flat(),
  );
}

/** Convert an MCP result. `isError` results become error results that keep the structured result. */
export function convertMcpResult(
  server: string,
  tool: string,
  result: CallToolResult,
  options: ConvertMcpResultOptions = {},
): Effect.Effect<AgentToolResult<McpToolDetails>> {
  return Effect.gen(function* () {
    // Without content blocks, toLlmContent falls back to the structured content as JSON.
    const converted: ModelContent =
      result.content.length > 0 ? yield* toModelContent(server, result.content, options) : toLlmContent(result);
    if (result.isError && textOf(converted) === "") {
      converted.push({ type: "text", text: `MCP tool ${server}/${tool} returned an error` });
    }
    const { content, fullOutputPath } = yield* limitMcpContent(converted, options.maxOutputBytes);
    const { _meta: _ignored, ...scriptResult } = result;
    return {
      content,
      details: { server, tool, ...(fullOutputPath ? { fullOutputPath } : {}) },
      structuredContent: scriptResult as unknown as JsonValue,
      ...(result.isError ? { isError: true } : {}),
    };
  });
}
