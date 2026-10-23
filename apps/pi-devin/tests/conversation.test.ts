import { Effect } from "effect";
import { expect, test } from "vitest";
import { runConversation } from "../src/cli/conversation.ts";
import { addTool, executeTools } from "../src/cli/registered-tools.ts";
import { createSession } from "../src/cli/services/sessions.ts";
import { ASSIGN_MODEL_METHOD } from "../src/core/protocol/connect-client.ts";
import { CHAT_METHOD } from "../src/core/protocol/protobuf.ts";
import type { JsonObject } from "../src/core/types.ts";
import { object as objectEffect } from "../src/core/validation.ts";
import { credential, devinClient, finalFrames, fingerprint, model, requestBody, run, runSync, streamResponse, unaryResponse } from "./helpers.ts";

const object = (value: unknown, label: string) => runSync(objectEffect(value, label));

test("multiple tools, parallel execution, title and next-turn steps and IDs are checked in the final requests", async () => {
  const requests: JsonObject[] = [];
  let primary = 0;
  const client = devinClient(credential, { fingerprint: fingerprint(), fetch: async (_url, init) => {
    const body = requestBody(CHAT_METHOD, init!); requests.push(body);
    if (body.chatModelUid === "swe-1-6-fast") {
      expect(body.executionId).toBe(undefined);
      expect(object(body.trajectoryReference, "trajectory").stepType).toBe(undefined);
      expect((body.chatMessagePrompts as JsonObject[]).length).toBe(1);
      return streamResponse(finalFrames("Small sums"));
    }
    primary++;
    if (primary === 1) return streamResponse([
      { messageId: "server-id", actualModelUid: "swe-2-high", deltaThinking: "opaque", deltaSignature: "sig", deltaToolCalls: [
        { id: "call-a", name: "add", argumentsJson: '{"a":1,"b":2}' }, { id: "call-b", name: "add", argumentsJson: '{"a":5,"b":7}' },
      ] }, { stopReason: "STOP_REASON_FUNCTION_CALL" }, { usage: { inputTokens: 10, outputTokens: 2, modelUid: "swe-2-low" } },
    ]);
    const messages = body.chatMessagePrompts as JsonObject[];
    if (primary === 2) {
      expect(messages.length).toBe(6);
      expect(messages[3].modelUid).toBe(model.id);
      expect(messages[3].thinking).toBe("opaque");
      expect(messages[3].signature).toBe("sig");
      expect(messages[3].messageId).not.toBe("server-id");
      expect(messages.slice(4).map((m) => [m.toolCallId, m.prompt, m.promptCacheOptions])).toStrictEqual([
        ["call-a", "3", { type: "CACHE_CONTROL_TYPE_EPHEMERAL" }], ["call-b", "12", { type: "CACHE_CONTROL_TYPE_EPHEMERAL" }],
      ]);
    }
    return streamResponse(finalFrames(primary === 2 ? "3 and 12" : "next"));
  } });
  const state = createSession(model.id, "/fixture/workspace");
  const catalog = [{ ...model, id: "alias-shadow", familyId: "shadow", aliases: [model.id] }, model];
  await run(runConversation(client, state, catalog, { prompt: "add numbers", tools: [addTool] }));
  await run(runConversation(client, state, catalog, { prompt: "next turn", tools: [addTool] }));
  expect(requests.map((r) => object(r.trajectoryReference, "trajectory").stepIndex ?? 0)).toStrictEqual([0, 1, 2, 3]);
  expect(state.nextStepIndex).toBe(4);
  expect(state.title).toBe("Small sums");
  expect(requests[0].executionId).toBe(requests[2].executionId);
  expect(requests[0].executionId).not.toBe(requests[3].executionId);
  for (const r of requests) {
    if (r.executionId) expect(r.chatModelUid).toBe(model.id);
    expect(r.cascadeId).toBe(state.cascadeId);
    expect(r.clientSessionId).toBe(state.id);
    expect(object(r.trajectoryReference, "trajectory").trajectoryId).toBe(state.trajectoryId);
    expect(Number(object(r.configuration, "configuration").maxTokens)).toBe(model.maxOutputTokens);
  }
  const firstIds = (requests[0].chatMessagePrompts as JsonObject[]).map((m) => m.messageId);
  const nextIds = (requests[2].chatMessagePrompts as JsonObject[]).slice(0, 3).map((m) => m.messageId);
  expect(firstIds.every((id, index) => id !== nextIds[index])).toBeTruthy();
});

test("router preliminary and input-based assignment and the JWT apply to the real inference", async () => {
  const records: JsonObject[] = [];
  const client = devinClient(credential, { fingerprint: fingerprint(), fetch: async (url, init) => {
    const method = new URL(String(url)).pathname.slice(1);
    const body = requestBody(method, init!); records.push(body);
    if (method === ASSIGN_MODEL_METHOD) {
      expect(body.modelRouterUid).toBe("adaptive");
      expect(new Headers(init?.headers).get("sentry-trace")).toBe(null);
      return unaryResponse(method, { assignment: { modelUid: model.id, assignmentJwt: "mock-assignment-jwt" } });
    }
    expect(body.chatModelUid).toBe(model.id);
    expect(body.modelAssignmentJwt).toBe("mock-assignment-jwt");
    expect(Number(object(body.configuration, "configuration").maxTokens)).toBe(5000);
    return streamResponse(finalFrames());
  } });
  const state = createSession("adaptive");
  const catalog = [{ ...model, id: "alias-shadow", familyId: "shadow", aliases: ["adaptive", model.id] },
    model, { ...model, id: "adaptive", isRouter: true }];
  await run(runConversation(client, state, catalog, { prompt: "route this", maxTokens: 5000, generateTitle: false }));
  expect(records.length).toBe(3);
  expect(records[0].chatMessagePrompt).toBe(undefined);
  expect(object(records[1].chatMessagePrompt, "routing prompt").prompt).toBe("route this");
  expect(records[0].cascadeId).toBe(records[1].cascadeId);
  expect(records[1].cascadeId).toBe(records[2].cascadeId);
});

test("the title request starts even on a primary auth error and neither is retried", async () => {
  const models: unknown[] = [];
  const client = devinClient(credential, { fingerprint: fingerprint(), fetch: async (_url, init) => {
    models.push(requestBody(CHAT_METHOD, init!).chatModelUid);
    return Response.json({ code: "unauthenticated", message: "mock failure" }, { status: 401 });
  } });
  await expect(run(runConversation(client, createSession(model.id), [model], { prompt: "hello" }))).rejects.toThrow(/unauthenticated/);
  expect(models).toStrictEqual([model.id, "swe-1-6-fast"]);
});

test("the cancel signal reaches the concurrently running primary and title requests", async () => {
  const controller = new AbortController();
  const signals: AbortSignal[] = [];
  let started!: () => void;
  const bothStarted = new Promise<void>((resolve) => { started = resolve; });
  const client = devinClient(credential, { fingerprint: fingerprint(), fetch: async (_url, init) => {
    const signal = init!.signal!; signals.push(signal);
    if (signals.length === 2) started();
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  } });
  const pending = run(runConversation(client, createSession(model.id), [model], { prompt: "hello" }), controller.signal);
  const rejected = expect(pending).rejects.toThrow(/stop both/);
  await bothStarted;
  controller.abort(new Error("stop both"));
  await rejected;
  expect(signals.length).toBe(2);
  expect(signals.every((signal) => signal.aborted)).toBeTruthy();
});

test("tool parallelism, error results, unregistered tools and duplicate ID boundaries", async () => {
  const calls = [{ id: "one", name: "add", argumentsJson: '{"a":1,"b":2}' }, { id: "two", name: "add", argumentsJson: '{"a":3,"b":4}' }];
  let active = 0; let peak = 0;
  const tool = { ...addTool, execute: () => Effect.gen(function* () { peak = Math.max(peak, ++active); yield* Effect.yieldNow; active--; return "result"; }) };
  await run(executeTools(calls, [tool], { allowParallel: true }));
  expect(peak).toBe(2);
  peak = 0; await run(executeTools(calls, [tool], { allowParallel: false })); expect(peak).toBe(1);
  const errors = await run(executeTools([{ ...calls[0], argumentsJson: '{"a":"bad","b":2}' }], [addTool]));
  expect(errors[0].toolResultIsError).toBe(true);
  expect(errors[0].toolCallId).toBe("one");
  await expect(run(executeTools([...calls, { ...calls[0], id: "three", name: "bash" }], [tool]))).rejects.toThrow(/Arbitrary/);
  await expect(run(executeTools([calls[0], calls[0]], [tool]))).rejects.toThrow(/Duplicate/);
});
