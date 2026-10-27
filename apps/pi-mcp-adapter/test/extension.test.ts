/**
 * Tool results are cut at the tool's `pi/maxOutputBytes`, else the configured limit, and other extensions
 * get each tool's `_meta` over `pi.events`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoadedMcpConfig } from "../src/config/files.ts";
import { TOOL_META_CHANNEL } from "../src/tools/meta.ts";
import { type FakeServer, SCHEMA, startSession, type TestSession } from "./harness.ts";

/** Bytes of text the `dump` tools return, more than any output limit in the tests. */
const DUMP_BYTES = 100_000;

const TOOLS = [
  { name: "dump", inputSchema: SCHEMA },
  { name: "dump_declared", inputSchema: SCHEMA, _meta: { "pi/maxOutputBytes": 80_000 } },
  { name: "dump_other", inputSchema: SCHEMA, _meta: { "x/limit": 100_000, "x/nested": { list: [1] } } },
  { name: "dump_invalid", inputSchema: SCHEMA, _meta: { "pi/maxOutputBytes": 0 } },
  { name: "text_meta", inputSchema: SCHEMA, _meta: "ab" },
];

/** Every server offers {@link TOOLS}, whose results are {@link DUMP_BYTES} of text. */
const DUMP_SERVER: FakeServer = { tools: TOOLS, callText: "x".repeat(DUMP_BYTES) };

/** Bytes of a truncated result's text that reached the model, without header, marker, and file path. */
function keptBytes(text: string): number {
  const [, body = ""] = text.split("\n\n");
  return Buffer.byteLength(body.replace(/…\d+ chars truncated…/, ""));
}

function start(options: { config?: Partial<LoadedMcpConfig>; registered?: Record<string, unknown> } = {}) {
  return startSession({ ...options, servers: { docs: DUMP_SERVER, large: DUMP_SERVER, broken: DUMP_SERVER } });
}

describe("MCP tool output limit", () => {
  const sessions: TestSession[] = [];
  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.shutdown();
  });

  it.each([
    { config: {}, server: {}, configured: 20 * 1024 },
    { config: { maxOutputBytes: 30_000 }, server: {}, configured: 30_000 },
    { config: { maxOutputBytes: 30_000 }, server: { maxOutputBytes: 50_000 }, configured: 50_000 },
  ])(
    "cuts results at the tool's pi/maxOutputBytes, else the configured $configured bytes",
    async ({ config, server, configured }) => {
      const session = await start({
        config: {
          ...config,
          servers: [
            {
              name: "docs",
              config: { command: "docs", exposure: "direct", ...server },
              source: "test",
              scope: "global",
            },
          ],
        },
      });
      sessions.push(session);

      // The server entry's value wins over the top-level one, and the tool's `_meta` over both.
      expect(keptBytes(await session.call("mcp__docs__dump"))).toBe(configured);
      expect(keptBytes(await session.call("mcp__docs__dump_declared"))).toBe(80_000);
      // Other keys and an invalid pi/maxOutputBytes leave the configured limit in place.
      expect(keptBytes(await session.call("mcp__docs__dump_other"))).toBe(configured);
      expect(keptBytes(await session.call("mcp__docs__dump_invalid"))).toBe(configured);
    },
  );

  it("uses the maxOutputBytes of a registered server and rejects an invalid one", async () => {
    const session = await start({
      config: { servers: [] },
      registered: {
        large: { command: "docs", exposure: "direct", maxOutputBytes: 60_000 },
        broken: { command: "docs", exposure: "direct", maxOutputBytes: -1 },
      },
    });
    sessions.push(session);

    expect(keptBytes(await session.call("mcp__large__dump"))).toBe(60_000);
    expect(session.tools.has("mcp__broken__dump")).toBe(false);
    expect(session.notices.join("\n")).toContain(
      '/ext/registering.ts: server "broken": maxOutputBytes must be a positive integer',
    );
  });
});

describe("MCP tool _meta for other extensions", () => {
  const sessions: TestSession[] = [];
  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.shutdown();
  });

  it("puts each tool's _meta on its definition and answers tool-meta requests with it", async () => {
    const session = await start();
    sessions.push(session);
    const expected = {
      mcp__docs__dump_declared: { "pi/maxOutputBytes": 80_000 },
      mcp__docs__dump_other: { "x/limit": 100_000, "x/nested": { list: [1] } },
      mcp__docs__dump_invalid: { "pi/maxOutputBytes": 0 },
    };

    // Tools without `_meta`, or with one that is not an object, have none.
    expect(session.tools.get("mcp__docs__dump")?.meta).toBeUndefined();
    expect(session.tools.get("mcp__docs__text_meta")?.meta).toBeUndefined();
    expect(session.tools.get("mcp__docs__dump_other")?.meta).toEqual(expected.mcp__docs__dump_other);

    const [reply, ...others] = session.askToolMeta();
    expect(others).toEqual([]);
    expect(reply).toEqual(expected);
    // Each reply has its own copies.
    (reply.mcp__docs__dump_declared as Record<string, unknown>)["pi/maxOutputBytes"] = 1;
    expect(session.askToolMeta()).toEqual([expected]);
  });

  it("ignores requests without a reply function", async () => {
    const session = await start();
    sessions.push(session);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      session.events.emit(TOOL_META_CHANNEL, {});
      session.events.emit(TOOL_META_CHANNEL, null);
      // The event bus reports handler errors asynchronously.
      await new Promise((resolve) => setImmediate(resolve));
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
