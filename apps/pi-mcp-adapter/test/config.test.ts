import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMcpConfig } from "../src/config/files.ts";
import { validateMcpServerConfig } from "../src/config/schema.ts";

describe("maxOutputBytes in mcp.json", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(global: unknown, project: unknown) {
    const root = mkdtempSync(join(tmpdir(), "pi-mcp-adapter-config-"));
    dirs.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(global));
    writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify(project));
    return { agentDir, cwd };
  }

  it("validates maxOutputBytes and reads the top-level value with project precedence", () => {
    const paths = setup(
      {
        maxOutputBytes: 40_000,
        mcpServers: {
          large: { command: "x", maxOutputBytes: 100_000 },
          zero: { command: "x", maxOutputBytes: 0 },
          fraction: { command: "x", maxOutputBytes: 1.5 },
        },
      },
      { maxOutputBytes: 60_000, mcpServers: {} },
    );

    const untrusted = loadMcpConfig({ ...paths, isProjectTrusted: false });
    expect(untrusted.maxOutputBytes).toBe(40_000);
    expect(untrusted.servers.map((server) => [server.name, server.config.maxOutputBytes])).toEqual([
      ["large", 100_000],
    ]);
    expect(untrusted.errors).toEqual([
      expect.stringContaining('server "zero": maxOutputBytes must be a positive integer'),
      expect.stringContaining('server "fraction": maxOutputBytes must be a positive integer'),
    ]);
    expect(loadMcpConfig({ ...paths, isProjectTrusted: true }).maxOutputBytes).toBe(60_000);

    // An invalid project value is reported and leaves the global value in place.
    writeFileSync(join(paths.cwd, ".pi", "mcp.json"), JSON.stringify({ maxOutputBytes: "60000", mcpServers: {} }));
    const invalid = loadMcpConfig({ ...paths, isProjectTrusted: true });
    expect(invalid.maxOutputBytes).toBe(40_000);
    expect(invalid.errors).toContainEqual(expect.stringContaining("maxOutputBytes must be a positive integer"));
  });

  it("validates maxOutputBytes of a server config passed on its own, as registrations are", () => {
    expect(validateMcpServerConfig("docs", { url: "https://example.com/mcp", maxOutputBytes: 51_200 })).toEqual({
      url: "https://example.com/mcp",
      maxOutputBytes: 51_200,
    });
    expect(validateMcpServerConfig("docs", { command: "x", maxOutputBytes: "51200" })).toBe(
      'server "docs": maxOutputBytes must be a positive integer',
    );
  });
});
