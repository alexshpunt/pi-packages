/**
 * The `mcp_servers` system prompt section. The model learns of the servers whose tools are not
 * declared to it from this section, since neither codemode nor tool_search lists them.
 */

import { mcpNamespace } from "../config/schema.ts";
import { configuredExposures, hasIndirectTools, isEnabled, type McpServer } from "../servers/server.ts";

export const MCP_SERVERS_SECTION = "mcp_servers";
/** Characters of a server description in the section, as Codex allows for deferred namespaces. */
const MAX_SERVER_DESCRIPTION_CHARS = 250;
/**
 * Characters of the whole section. Descriptions shrink to fit; when the server lines alone do not
 * fit, the last servers are left out and counted in a closing line.
 */
const MAX_SERVERS_SECTION_CHARS = 4096;

/** The section's first line. It explains only the ways of reaching tools that the listed servers use. */
function serversSectionIntro(reaches: ReadonlySet<string>): string {
  let intro = "MCP servers whose tools are not declared to you.";
  if (reaches.has("codemode")) intro += " Call the tools of `codemode` servers from codemode scripts.";
  if (reaches.has("tool_search")) intro += " Load the tools of `tool_search` servers with `tool_search`.";
  return intro;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return maxChars <= 1 ? "" : `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

/** First line of the configured description, or of the server instructions once connected. */
function serverSummary(server: McpServer): string {
  const text = server.entry.config.description?.trim() || server.connection?.instructions || "";
  return (text.split("\n", 1)[0] ?? "").trim();
}

/**
 * Every enabled server with codemode or deferred tools, with how its tools are reached and a one-line
 * summary. Undefined when there are no such servers.
 */
export function renderServersSection(servers: readonly McpServer[]): string | undefined {
  const listed = servers
    .filter((server) => isEnabled(server) && hasIndirectTools(server.entry))
    .sort((a, b) => a.entry.name.localeCompare(b.entry.name));
  if (listed.length === 0) return undefined;
  const reaches = listed.map((server) =>
    configuredExposures(server.entry).has("codemode") ? "codemode" : "tool_search",
  );
  const intro = serversSectionIntro(new Set(reaches));
  const heads = listed.map((server, index) => `- ${mcpNamespace(server.entry.name)} (${reaches[index]})`);
  const omitted = (count: number) =>
    count > 0 ? [`- … ${count} more server${count === 1 ? "" : "s"}; find their tools with searchTools()`] : [];
  // Characters of the intro, the first `kept` server lines without descriptions, and the omission line.
  const size = (kept: number) => [intro, ...heads.slice(0, kept), ...omitted(listed.length - kept)].join("\n").length;
  let kept = listed.length;
  while (kept > 0 && size(kept) > MAX_SERVERS_SECTION_CHARS) kept--;
  // Each description also takes a ": " separator.
  const perServerChars =
    kept === 0
      ? 0
      : Math.min(MAX_SERVER_DESCRIPTION_CHARS, Math.floor((MAX_SERVERS_SECTION_CHARS - size(kept)) / kept) - 2);
  const lines = listed.slice(0, kept).map((server, index) => {
    const summary = perServerChars > 0 ? truncate(serverSummary(server), perServerChars) : "";
    return summary ? `${heads[index]}: ${summary}` : heads[index];
  });
  return [intro, ...lines, ...omitted(listed.length - kept)].join("\n");
}
