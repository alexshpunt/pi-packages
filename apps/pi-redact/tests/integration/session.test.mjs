import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_FILE, leakedSecrets, SECRETS, temporaryTree } from "../support/fixtures.mjs";
import { conversationOf, startSession, systemOf } from "../support/pi.mjs";

const MARKER = "{{REDACTED}}";
const MASKED_ENV = `API_KEY=${MARKER}\nDB_PASSWORD=${MARKER}\nSHORT_PASSWORD=${MARKER}\nPORT=8080\n`;

function toolResultTexts(messages) {
  return messages
    .filter((message) => message.role === "toolResult")
    .map((message) => message.content.map((block) => block.text ?? "").join(""));
}

function messageEntries(entries, role) {
  return entries.filter((entry) => entry.type === "message" && entry.message.role === role);
}

describe("a Pi session with pi-redact", () => {
  it("masks file contents from tool calls before storage and in every model request", async (t) => {
    const pi = await startSession(t, {
      files: {
        ".env": ENV_FILE,
        "src/settings.ts": `export const token = "${SECRETS.sourceToken}";\n`,
        "AGENTS.md": `# Project\n\nDeploy key: ${SECRETS.agentsKey}\n`,
      },
    });
    pi.plan([
      [{ name: "read", args: { path: ".env" } }],
      [{ name: "bash", args: { command: "cat src/settings.ts; grep -Hn PASSWORD .env; cat -n .env" } }],
      [],
    ]);
    await pi.session.prompt(`Check the configuration. My deploy token is ${SECRETS.userToken}.`);

    expect(pi.extensionErrors).toEqual([]);
    expect(pi.requests).toHaveLength(3);
    for (const request of pi.requests) expect(leakedSecrets(conversationOf(request))).toEqual([]);

    const [readText, bashText] = toolResultTexts(conversationOf(pi.requests.at(-1)));
    // Short values get the marker too, never asterisks, and every line keeps its place.
    expect(readText).toBe(MASKED_ENV);
    expect(bashText).toContain(`export const token = "${MARKER}";`);
    expect(bashText).toContain(`.env:2:DB_PASSWORD=${MARKER}`);
    expect(bashText).toContain(`.env:3:SHORT_PASSWORD=${MARKER}`);
    expect(bashText).toMatch(/^\s+2\tDB_PASSWORD=\{\{REDACTED\}\}$/m);
    expect(bashText).not.toContain("*");

    const entries = pi.sessionEntries();
    const storedResults = messageEntries(entries, "toolResult");
    expect(storedResults).toHaveLength(2);
    expect(leakedSecrets(storedResults)).toEqual([]);
    expect(storedResults[0].message.content[0].text).toBe(MASKED_ENV);
    // Typed input is stored as typed and masked only when it is sent.
    expect(leakedSecrets(messageEntries(entries, "user"))).toEqual([SECRETS.userToken]);

    // The system prompt is left unchanged by design and carries the model guideline.
    const system = JSON.stringify(systemOf(pi.requests.at(-1)));
    expect(system).toContain(`Text shown as ${MARKER} replaces a sensitive value`);
    expect(leakedSecrets(system)).toEqual([SECRETS.agentsKey]);
  });

  it("masks the compaction request, which Pi sends without the context hooks", async (t) => {
    const pi = await startSession(t, { files: { ".env": ENV_FILE } });
    pi.plan([[{ name: "read", args: { path: ".env" } }], []]);
    await pi.session.prompt(`Store ${SECRETS.userToken} for later.`);
    const turnRequests = pi.requests.length;

    await pi.session.compact();

    const summaryRequests = pi.requests.slice(turnRequests);
    expect(summaryRequests).toHaveLength(1);
    expect(leakedSecrets(conversationOf(summaryRequests[0]))).toEqual([]);
    expect(JSON.stringify(conversationOf(summaryRequests[0]))).toContain(MARKER);
    expect(pi.extensionErrors).toEqual([]);
  });

  it("masks the branch summary request, including user shell output", async (t) => {
    const pi = await startSession(t, { files: { ".env": ENV_FILE } });
    pi.plan([[{ name: "read", args: { path: ".env" } }], []]);
    await pi.session.prompt(`Remember ${SECRETS.userToken}.`);
    await pi.session.executeBash("cat .env");

    const entries = pi.session.sessionManager.getEntries();
    // Shell commands the user runs are not tool calls; they are stored as run and masked when sent.
    expect(leakedSecrets(messageEntries(entries, "bashExecution"))).toEqual([SECRETS.envApiKey, SECRETS.envPassword]);
    const firstUser = messageEntries(entries, "user")[0];
    const turnRequests = pi.requests.length;

    const result = await pi.session.navigateTree(firstUser.parentId, { summarize: true });

    expect(result.cancelled).toBe(false);
    const summaryRequests = pi.requests.slice(turnRequests);
    expect(summaryRequests).toHaveLength(1);
    const summarized = JSON.stringify(conversationOf(summaryRequests[0]));
    expect(leakedSecrets(summarized)).toEqual([]);
    expect(summarized).toContain(`DB_PASSWORD=${MARKER}`);
    expect(pi.extensionErrors).toEqual([]);
  });

  it("blocks writes and commands that would store a masked value", async (t) => {
    const pi = await startSession(t, {
      files: { ".env": ENV_FILE, "docs/marker.md": `Placeholder: ${MARKER}\n` },
    });
    pi.plan([
      [{ name: "read", args: { path: ".env" } }],
      [
        { name: "write", args: { path: ".env", content: `API_KEY=${MARKER}\n` } },
        { name: "edit", args: { path: ".env", edits: [{ oldText: "PORT=8080", newText: `PORT=${MARKER}` }] } },
        { name: "bash", args: { command: `echo ${MARKER} > leaked.txt` } },
        // The file already contains the literal once, so keeping it is not a new masked value.
        { name: "write", args: { path: "docs/marker.md", content: `Placeholder: ${MARKER}\nMore text.\n` } },
      ],
      [],
    ]);
    await pi.session.prompt("Rotate the key.");

    expect(readFileSync(join(pi.workspace, ".env"), "utf8")).toBe(ENV_FILE);
    expect(existsSync(join(pi.workspace, "leaked.txt"))).toBe(false);
    expect(readFileSync(join(pi.workspace, "docs/marker.md"), "utf8")).toBe(`Placeholder: ${MARKER}\nMore text.\n`);
    const results = pi.session.messages.filter((message) => message.role === "toolResult").slice(1);
    expect(results.map((result) => result.isError)).toEqual([true, true, true, false]);
    for (const result of results.slice(0, 3)) expect(result.content[0].text).toContain("pi-redact blocked this call");
  });

  it("masks text that another extension adds in a context handler", async (t) => {
    const extensionDir = temporaryTree(t, {
      "inject.mjs": [
        "export default function (pi) {",
        '  pi.on("context", (event) => ({',
        "    messages: event.messages.map((message) =>",
        '      message.role === "user"',
        `        ? { ...message, content: [{ type: "text", text: "injected key ${SECRETS.injected}" }] }`,
        "        : message,",
        "    ),",
        "  }));",
        "}",
        "",
      ].join("\n"),
    });
    const pi = await startSession(t, { extensions: [join(extensionDir, "inject.mjs")] });
    pi.plan([[]]);
    await pi.session.prompt("Hello.");

    const conversation = JSON.stringify(conversationOf(pi.requests[0]));
    expect(conversation).toContain(`injected key ${MARKER}`);
    expect(leakedSecrets(conversation)).toEqual([]);
  });

  it("applies rules from the global settings file", async (t) => {
    const pi = await startSession(t, {
      files: { "keys.env": "OPENAI_KEY=fixture-custom-value\n" },
      globalSettings: { sensitiveFields: ["OPENAI_KEY"] },
    });
    pi.plan([[{ name: "read", args: { path: "keys.env" } }], []]);
    await pi.session.prompt("Read the keys.");

    expect(toolResultTexts(pi.session.messages)).toEqual([`OPENAI_KEY=${MARKER}\n`]);
    expect(pi.extensionErrors).toEqual([]);
  });
});
