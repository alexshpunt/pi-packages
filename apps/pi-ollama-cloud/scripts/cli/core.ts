import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fetchModelIds } from "../../src/models/api.ts";
import { assembleModels } from "../../src/models/metadata.ts";
import { completeOllamaChat } from "../../src/pi/chat.ts";
import { chatResponse, withMockFetch } from "./mock-transport.ts";
import { runCLI } from "./runner.ts";
import { runFeature, type VerificationFeature } from "./verification.ts";

export const coreFeature: VerificationFeature = {
  id: "01-core-cli",
  cli: "scripts/cli/core.ts",
  shared: ["src/models/metadata.ts", "src/pi/chat.ts", "src/pi/lifecycle.ts", "src/pi/web-tools.ts"],
  consumers: ["src/index.ts", "src/models/catalog.ts", "src/pi/web-tools.ts", "scripts/cli.ts"],
  async verify({ check }) {
    await check("공용 모델 조립과 무인증 목록 조회", async () => {
      assert.equal(assembleModels({ fixture: { capabilities: ["tools"] } })[0].contextWindow, 128000);
      await withMockFetch(
        async (_url, init) => {
          assert.equal(new Headers(init?.headers).has("Authorization"), false);
          return Response.json({ data: [{ id: "fixture" }] });
        },
        async () => assert.deepEqual(await fetchModelIds(), ["fixture"]),
      );
    });
    await check("실제 Pi 전송의 모델 ID·질문·토큰 상한과 임시 폴더 정리", async () => {
      const before = readdirSync(tmpdir()).filter((name) => name.startsWith("pi-ollama-cli-"));
      let chatCalls = 0;
      await withMockFetch(
        async (url, init) => {
          const address = url instanceof Request ? url.url : String(url);
          const body: unknown = JSON.parse(String(init?.body));
          assert.ok(body && typeof body === "object");
          if (address.endsWith("/api/show")) {
            assert.equal((body as { model: string }).model, "glm-5.3-flash:cloud");
            return Response.json({ capabilities: ["tools"] });
          }
          assert.ok(address.endsWith("/chat/completions"));
          chatCalls += 1;
          const payload = body as { model: string; max_tokens: number; messages: { content: string }[] };
          assert.equal(payload.model, "glm-5.3-flash:cloud");
          assert.equal(payload.max_tokens, 4096);
          assert.equal(payload.messages.at(-1)?.content, "1+1");
          return chatResponse();
        },
        async () => {
          const controller = new AbortController();
          try {
            const result = await completeOllamaChat("glm-5.3-flash:cloud", controller.signal, async () => ({
              apiKey: "fixture-only",
              source: "auth.json",
            }));
            assert.equal(result.answer, "2");
          } finally {
            controller.abort();
          }
        },
      );
      assert.equal(chatCalls, 1);
      assert.deepEqual(
        readdirSync(tmpdir()).filter((name) => name.startsWith("pi-ollama-cli-")),
        before,
      );
    });
    await check("기존 메뉴·선택·직접 입력·종료와 SIGINT 정리", async () => {
      const actions = ["models", "chat", "fixture", "manual", "exit"];
      const chats: string[] = [];
      const initialListeners = process.listenerCount("SIGINT");
      const dependencies = {
        select: async () => actions.shift() ?? "exit",
        input: async () => "glm-5.3-flash:cloud",
        fetchModelIds: async () => ["fixture"],
        runChat: async (id: string) => {
          chats.push(id);
        },
        isTTY: true,
      };
      await runCLI([], dependencies);
      assert.deepEqual(chats, ["fixture", "glm-5.3-flash:cloud"]);
      assert.equal(process.listenerCount("SIGINT"), initialListeners);
      const previousExitCode = process.exitCode;
      try {
        await runCLI([], {
          ...dependencies,
          select: async () => {
            process.emit("SIGINT");
            throw new Error("fixture interrupt");
          },
        });
        assert.equal(process.exitCode, 130);
        assert.equal(process.listenerCount("SIGINT"), initialListeners);
      } finally {
        process.exitCode = previousExitCode;
      }
      await runCLI(["--help"], dependencies);
      await assert.rejects(runCLI([], { ...dependencies, isTTY: false }), /대화형 터미널/);
    });
  },
};
runFeature(import.meta.url, coreFeature);
