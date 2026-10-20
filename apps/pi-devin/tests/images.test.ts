import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runConversation } from "../src/cli/conversation.ts";
import { DevinClient } from "../src/core/client.ts";
import { imageMimeType, loadImageFiles, MAX_IMAGE_BYTES } from "../src/cli/images.ts";
import { CHAT_METHOD } from "../src/core/protocol/protobuf.ts";
import { createSession } from "../src/cli/session-store.ts";
import type { JsonObject } from "../src/core/types.ts";
import { credential, finalFrames, fingerprint, model, requestBody, streamResponse } from "./helpers.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK9sAAAAASUVORK5CYII=", "base64");

test("local image → Base64 → final protobuf request, including image-only input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devin-image-"));
  try {
    const path = join(directory, "actually a PNG.jpg");
    await writeFile(path, PNG);
    const images = await loadImageFiles([path, path]);
    let calls = 0;
    const client = new DevinClient(credential, { fingerprint: fingerprint(), fetch: async (_url, init) => {
      calls++;
      const request = requestBody(CHAT_METHOD, init!);
      const messages = request.chatMessagePrompts as JsonObject[];
      assert.equal(messages.length, 3);
      assert.equal(messages[1].prompt, undefined);
      assert.deepEqual(messages[1].images, [
        { mimeType: "image/png", base64Data: PNG.toString("base64") },
        { mimeType: "image/png", base64Data: PNG.toString("base64") },
      ]);
      assert.ok(!JSON.stringify(messages[1].images).includes("data:image"));
      return streamResponse(finalFrames());
    } });
    await runConversation(client, createSession(model.id), [model], { prompt: "", images, generateTitle: false });
    assert.equal(calls, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("image support by model, format, regular files, per-image/total size and cancellation boundaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devin-image-"));
  try {
    const bad = join(directory, "bad.png");
    await writeFile(bad, "not an image");
    await assert.rejects(loadImageFiles([bad]), /Unsupported image/);
    await assert.rejects(loadImageFiles([directory]), /regular file/);
    const large = join(directory, "large.png");
    await writeFile(large, Buffer.alloc(MAX_IMAGE_BYTES + 1));
    await assert.rejects(loadImageFiles([large]), /Each image/);
    const multiple = join(directory, "three-mib.png");
    const bytes = Buffer.alloc(3 * 1024 * 1024); PNG.copy(bytes);
    await writeFile(multiple, bytes);
    await assert.rejects(loadImageFiles([multiple, multiple]), /Images must total/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(loadImageFiles([bad], controller.signal), /abort/i);
    const client = new DevinClient(credential, { fingerprint: fingerprint(), fetch: async () => assert.fail("images must not be sent to an unsupported model.") });
    await assert.rejects(runConversation(client, createSession(model.id), [{ ...model, supportsImages: false }], {
      prompt: "", images: [{ mimeType: "image/png", base64Data: PNG.toString("base64") }], generateTitle: false,
    }), /does not support image input/);
    const history = createSession(model.id);
    history.messages.push({ messageId: "old", source: "CHAT_MESSAGE_SOURCE_USER", prompt: "", images: [{ mimeType: "image/png", base64Data: PNG.toString("base64") }] });
    await assert.rejects(runConversation(client, history, [{ ...model, supportsImages: false }], { prompt: "continue", generateTitle: false }), /does not support image input/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("MIME detection uses PNG/JPEG/GIF/WebP magic bytes, not file extensions", () => {
  assert.equal(imageMimeType(PNG), "image/png");
  assert.equal(imageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0])), "image/jpeg");
  assert.equal(imageMimeType(Buffer.from("GIF89a")), "image/gif");
  assert.equal(imageMimeType(Buffer.from("RIFF0000WEBP")), "image/webp");
  assert.throws(() => imageMimeType(Buffer.from("<svg/>")), /Unsupported/);
});
