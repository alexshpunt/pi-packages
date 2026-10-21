import { expect, test } from "vitest";
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
      expect(Number(object(request.configuration, "configuration").maxTokens)).toBe(512);
      expect(object(request.configuration, "configuration").topP).toBe(Math.fround(0.95));
      expect(object(request.metadata, "metadata").apiKey).toBe(credential.sessionToken);
      if (requests.length === 1) return streamResponse([
        { messageId: "real-response", actualModelUid: "swe-2-high", deltaThinking: "opaque reasoning", deltaSignature: "opaque-signature", deltaSignatureType: "test-type" },
        { deltaToolCalls: [{ id: "actual-call-id", name: "add" }] },
        { deltaToolCalls: [{ argumentsJson: '{"a":17,"b":25}' }] },
        { stopReason: "STOP_REASON_FUNCTION_CALL" }, { usage: { inputTokens: 100, outputTokens: 50 } },
      ]);
      expect(requests.length).toBe(2);
      const messages = request.chatMessagePrompts as JsonObject[];
      const assistant = messages[1];
      const toolResult = messages[2];
      expect(assistant.source).toBe("CHAT_MESSAGE_SOURCE_SYSTEM");
      expect(String(assistant.messageId)).toMatch(UUID);
      expect(assistant.messageId).not.toBe("real-response");
      expect(assistant.modelUid).toBe("swe-2-medium");
      expect((assistant.toolCalls as JsonObject[])[0].id).toBe("actual-call-id");
      expect(assistant.thinking).toBe("opaque reasoning");
      expect(assistant.signature).toBe("opaque-signature");
      expect(assistant.signatureType).toBe("test-type");
      expect(toolResult.source).toBe("CHAT_MESSAGE_SOURCE_TOOL");
      expect(toolResult.toolCallId).toBe("actual-call-id");
      expect(toolResult.prompt).toBe("42");
      expect(toolResult.promptCacheOptions).toStrictEqual({ type: "CACHE_CONTROL_TYPE_EPHEMERAL" });
      expect(messages[0].messageId).not.toBe((requests[0].chatMessagePrompts as JsonObject[])[0].messageId);
      expect(object(request.metadata, "metadata").f).not.toBe(object(requests[0].metadata, "metadata").f);
      for (const key of ["cascadeId", "executionId", "clientSessionId"]) expect(request[key]).toBe(requests[0][key]);
      const trajectory = object(request.trajectoryReference, "trajectory");
      const firstTrajectory = object(requests[0].trajectoryReference, "firstTrajectory");
      expect(trajectory.trajectoryId).toBe(firstTrajectory.trajectoryId);
      expect(trajectory.trajectoryId).not.toBe(request.cascadeId);
      expect(trajectory.stepIndex).toBe(1);
      expect(trajectory.stepType).toBe(undefined);
      expect(firstTrajectory.stepType).toBe("CORTEX_STEP_TYPE_USER_INPUT");
      return streamResponse([{ deltaText: "42" }, { stopReason: "STOP_REASON_STOP_PATTERN" }, { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 100 } }]);
    },
  });
  const reports: JsonObject[] = [];
  const result = await toolRoundtrip(client, { model: "swe-2-medium", maxTokens: 512, onResult: (_stage, value) => reports.push(value) });
  expect(result.toolResult).toBe(42);
  expect(requests.length).toBe(2);
  const report = JSON.stringify(reports);
  for (const hidden of ["opaque reasoning", "opaque-signature", credential.sessionToken]) expect(report.includes(hidden)).toBeFalsy();
});

test("only the account match is reported, and a different user ID is rejected", async () => {
  const client = new DevinClient(credential, { fingerprint: fingerprint(),
    fetch: async () => unaryResponse(STATUS_METHOD, { userStatus: { userId: "expected-id", name: "private-name", email: "private@example.invalid" } }),
  });
  const status = await client.status(undefined, "expected-id");
  expect(status.identityVerified).toBe(true);
  expect(JSON.stringify(status).includes("private")).toBeFalsy();
  await expect(client.status(undefined, "another-id")).rejects.toThrow(/differs from the requested account/);
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
  await expect(toolRoundtrip(client, { model: "swe-2-medium", maxTokens: 512 })).rejects.toThrow(/Arbitrary/);
  expect(calls).toBe(1);
});
