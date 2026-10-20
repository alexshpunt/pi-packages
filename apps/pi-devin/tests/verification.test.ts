import assert from "node:assert/strict";
import { test } from "node:test";
import { DevinClient } from "../src/core/client.ts";
import { toolRoundtrip } from "../src/cli/verification.ts";
import { object, type JsonObject } from "../src/core/types.ts";
import { CHAT_METHOD } from "../src/core/protocol/protobuf.ts";
import { credential, fingerprint, requestBody, STATUS_METHOD, streamResponse, unaryResponse } from "./helpers.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("a tool round trip keeps call IDs and signatures and regenerates only wire message IDs and fingerprints", async () => {
  const requests: JsonObject[] = [];
  const client = new DevinClient(credential, {
    fingerprint: fingerprint(),
    fetch: async (_url, init) => {
      const request = requestBody(CHAT_METHOD, init!);
      requests.push(request);
      assert.equal(Number(object(request.configuration, "configuration").maxTokens), 512);
      assert.equal(object(request.configuration, "configuration").topP, Math.fround(0.95));
      assert.equal(object(request.metadata, "metadata").apiKey, credential.sessionToken);
      if (requests.length === 1) return streamResponse([
        { messageId: "real-response", actualModelUid: "swe-2-high", deltaThinking: "opaque reasoning", deltaSignature: "opaque-signature", deltaSignatureType: "test-type" },
        { deltaToolCalls: [{ id: "actual-call-id", name: "add" }] },
        { deltaToolCalls: [{ argumentsJson: '{"a":17,"b":25}' }] },
        { stopReason: "STOP_REASON_FUNCTION_CALL" }, { usage: { inputTokens: 100, outputTokens: 50 } },
      ]);
      assert.equal(requests.length, 2);
      const messages = request.chatMessagePrompts as JsonObject[];
      const assistant = messages[1];
      const toolResult = messages[2];
      assert.equal(assistant.source, "CHAT_MESSAGE_SOURCE_SYSTEM");
      assert.match(String(assistant.messageId), UUID);
      assert.notEqual(assistant.messageId, "real-response");
      assert.equal(assistant.modelUid, "swe-2-medium");
      assert.equal((assistant.toolCalls as JsonObject[])[0].id, "actual-call-id");
      assert.equal(assistant.thinking, "opaque reasoning");
      assert.equal(assistant.signature, "opaque-signature");
      assert.equal(assistant.signatureType, "test-type");
      assert.equal(toolResult.source, "CHAT_MESSAGE_SOURCE_TOOL");
      assert.equal(toolResult.toolCallId, "actual-call-id");
      assert.equal(toolResult.prompt, "42");
      assert.deepEqual(toolResult.promptCacheOptions, { type: "CACHE_CONTROL_TYPE_EPHEMERAL" });
      assert.notEqual(messages[0].messageId, (requests[0].chatMessagePrompts as JsonObject[])[0].messageId);
      assert.notEqual(object(request.metadata, "metadata").f, object(requests[0].metadata, "metadata").f);
      for (const key of ["cascadeId", "executionId", "clientSessionId"]) assert.equal(request[key], requests[0][key]);
      const trajectory = object(request.trajectoryReference, "trajectory");
      const firstTrajectory = object(requests[0].trajectoryReference, "firstTrajectory");
      assert.equal(trajectory.trajectoryId, firstTrajectory.trajectoryId);
      assert.notEqual(trajectory.trajectoryId, request.cascadeId);
      assert.equal(trajectory.stepIndex, 1);
      assert.equal(trajectory.stepType, undefined);
      assert.equal(firstTrajectory.stepType, "CORTEX_STEP_TYPE_USER_INPUT");
      return streamResponse([{ deltaText: "42" }, { stopReason: "STOP_REASON_STOP_PATTERN" }, { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 100 } }]);
    },
  });
  const reports: JsonObject[] = [];
  const result = await toolRoundtrip(client, { model: "swe-2-medium", maxTokens: 512, onResult: (_stage, value) => reports.push(value) });
  assert.equal(result.toolResult, 42);
  assert.equal(requests.length, 2);
  const report = JSON.stringify(reports);
  for (const hidden of ["opaque reasoning", "opaque-signature", credential.sessionToken]) assert.ok(!report.includes(hidden));
});

test("only the account match is reported, and a different user ID is rejected", async () => {
  const client = new DevinClient(credential, { fingerprint: fingerprint(),
    fetch: async () => unaryResponse(STATUS_METHOD, { userStatus: { userId: "expected-id", name: "private-name", email: "private@example.invalid" } }),
  });
  const status = await client.status(undefined, "expected-id");
  assert.equal(status.identityVerified, true);
  assert.ok(!JSON.stringify(status).includes("private"));
  await assert.rejects(client.status(undefined, "another-id"), /differs from the requested account/);
});

test("a failed tool check sends no result and does not retry automatically", async () => {
  let calls = 0;
  const client = new DevinClient(credential, { fingerprint: fingerprint(), fetch: async () => {
    calls++;
    return streamResponse([
      { deltaToolCalls: [{ id: "call-1", name: "bash", argumentsJson: '{"command":"untrusted"}' }] },
      { stopReason: "STOP_REASON_FUNCTION_CALL" }, { usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
  } });
  await assert.rejects(toolRoundtrip(client, { model: "swe-2-medium", maxTokens: 512 }), /Arbitrary/);
  assert.equal(calls, 1);
});
