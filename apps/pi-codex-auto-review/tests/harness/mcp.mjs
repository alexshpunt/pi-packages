import { randomUUID } from "node:crypto";

/** Protocol-shaped MCP transport; Pi's real client, registration and execute pipeline remain active. */
export class FixtureMcpTransport {
    messages = new Set();
    errors = new Set();
    closed = new Set();
    requests = new Map();
    calls = [];
    replies = [];
    methods = [];
    constructor(tools, call) {
        this.tools = tools;
        this.call = call;
    }
    async start() {}
    onMessage(listener) {
        this.messages.add(listener);
        return () => this.messages.delete(listener);
    }
    onError(listener) {
        this.errors.add(listener);
        return () => this.errors.delete(listener);
    }
    onClose(listener) {
        this.closed.add(listener);
        return () => this.closed.delete(listener);
    }
    emit(message) {
        for (const listener of this.messages) listener(message);
    }
    async close() {
        for (const listener of this.closed) listener();
        this.closed.clear();
    }
    async send(message) {
        if (message.method) this.methods.push(message.method);
        if (!message.method) {
            this.replies.push(message);
            this.requests.get(message.id)?.(message.result);
            this.requests.delete(message.id);
            return;
        }
        if (message.id === undefined) return;
        let result;
        if (message.method === "initialize")
            result = {
                protocolVersion: message.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "owned-fixture", version: "1" },
            };
        else if (message.method === "ping") result = {};
        else if (message.method === "tools/list")
            result = { tools: this.tools };
        else if (message.method === "tools/call") {
            this.calls.push(structuredClone(message));
            void Promise.resolve()
                .then(() => this.call(message.params, this))
                .then(
                    (result) =>
                        this.emit({ jsonrpc: "2.0", id: message.id, result }),
                    (error) =>
                        this.emit({
                            jsonrpc: "2.0",
                            id: message.id,
                            error: {
                                code: -32603,
                                message: String(error.message),
                            },
                        }),
                );
            return;
        } else {
            queueMicrotask(() =>
                this.emit({
                    jsonrpc: "2.0",
                    id: message.id,
                    error: {
                        code: -32601,
                        message: "Unsupported fixture method",
                    },
                }),
            );
            return;
        }
        queueMicrotask(() =>
            this.emit({ jsonrpc: "2.0", id: message.id, result }),
        );
    }
    async elicit(meta, schema = { type: "object", properties: {} }) {
        const id = randomUUID(),
            response = new Promise((resolve) => this.requests.set(id, resolve));
        this.emit({
            jsonrpc: "2.0",
            id,
            method: "elicitation/create",
            params: {
                mode: "form",
                message: "Owned approval fixture",
                requestedSchema: schema,
                _meta: meta,
            },
        });
        return response;
    }
}
export const mcpText = (text) => ({ content: [{ type: "text", text }] });
export function mcpFixture(server, transport) {
    return {
        loadConfig: () => ({
            servers: [
                {
                    name: server,
                    config: { command: "owned-fixture", exposure: "direct" },
                    source: "owned-test-fixture",
                    scope: "extension",
                },
            ],
            errors: [],
        }),
        createTransport: () => transport,
        startupWaitMs: 2000,
    };
}
