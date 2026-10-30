import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { ImagesClient } from "../dist/backend.js";

async function listen(server) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return `http://127.0.0.1:${server.address().port}`;
}

test("a redirect never forwards a prompt or reference image", async () => {
    let forwarded = 0;
    let attempts = 0;
    const destination = createServer((request, response) => {
        forwarded++;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }));
    });
    const destinationUrl = await listen(destination);
    const origin = createServer((request, response) => {
        attempts++;
        response.writeHead(307, { location: destinationUrl });
        response.end();
    });
    const baseUrl = await listen(origin);
    try {
        const client = new ImagesClient({ apiKey: "test-token", headers: {}, baseUrl });
        const plan = { prompt: "private prompt", background: "opaque", model: "gpt-image-2", quality: "auto", size: "auto" };
        await assert.rejects(client.edit(plan, [{ mimeType: "image/png", bytes: Buffer.from("private image") }]));
        assert.equal(attempts, 1);
        assert.equal(forwarded, 0);
    } finally {
        origin.closeAllConnections();
        destination.closeAllConnections();
        await Promise.all([new Promise((resolve) => origin.close(resolve)), new Promise((resolve) => destination.close(resolve))]);
    }
});
