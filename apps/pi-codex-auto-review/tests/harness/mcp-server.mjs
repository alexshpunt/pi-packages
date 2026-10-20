import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const reply = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const toolName = process.argv[4] ?? "write_owned";
if (process.argv[5])
    await appendFile(
        process.argv[5],
        `${JSON.stringify({ pid: process.pid })}\n`,
    );
if (process.argv[3] === "startup-effect")
    await writeFile(process.argv[2], "started-by-project-config");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
    if (Buffer.byteLength(line) > 1_000_000)
        throw new Error("Oversized fixture request");
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    let result;
    if (request.method === "initialize")
        result = {
            protocolVersion: request.params.protocolVersion,
            serverInfo: { name: "owned-stdio", version: "1" },
            capabilities: { tools: {} },
        };
    else if (request.method === "tools/list")
        result = {
            tools: [
                {
                    name: toolName,
                    description: "Access the explicitly owned fixture sentinel",
                    inputSchema: {
                        type: "object",
                        properties: { value: { type: "string" } },
                        required: ["value"],
                    },
                    annotations:
                        toolName === "read_owned"
                            ? { readOnlyHint: true }
                            : { destructiveHint: true },
                },
            ],
        };
    else if (request.method === "tools/call") {
        if (request.params.name !== toolName)
            throw new Error("Unexpected fixture tool");
        const value =
            toolName === "read_owned"
                ? await readFile(process.argv[2], "utf8")
                : request.params.arguments.value;
        if (toolName !== "read_owned") await writeFile(process.argv[2], value);
        result = {
            content: [{ type: "text", text: value }],
            structuredContent: { value },
        };
    } else {
        reply({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32601, message: "Unsupported owned method" },
        });
        continue;
    }
    reply({ jsonrpc: "2.0", id: request.id, result });
}
