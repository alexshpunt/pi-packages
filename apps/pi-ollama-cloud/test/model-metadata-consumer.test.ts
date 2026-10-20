import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelsPublication } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatResponse, withMockFetch } from "../scripts/cli/mock-transport.ts";
import { modelsFeature } from "../scripts/cli/models.ts";
import extension from "../src/index.ts";
import { isRecord } from "../src/models/types.ts";
import { completeOllamaChat } from "../src/pi/chat.ts";

const fixture: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/models/live-2026-10-18.json", import.meta.url), "utf8"),
);
if (!isRecord(fixture) || !isRecord(fixture.models)) throw new Error("Invalid public model fixture");
const raw = fixture.models;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir: string;
beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "ollama-metadata-consumer-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

describe("model metadata consumers", () => {
  it("passes source and payload assertions with the real Pi transport", async () => {
    await modelsFeature.verify({
      check: async (_name, run) => {
        await run();
      },
    });
  });

  it("publishes live metadata from the actual registered provider callback", async () => {
    const registrations = new Map<string, ProviderConfig>();
    await extension({
      registerProvider: (id: string, config: ProviderConfig) => registrations.set(id, config),
      registerCommand() {},
      on() {},
    } as unknown as ExtensionAPI);
    const refresh = registrations.get("ollama-cloud")?.refreshModels;
    expect(refresh).toBeDefined();
    if (!refresh) throw new Error("Provider refresh callback missing");
    const controller = new AbortController();
    const publications: ModelsPublication[] = [];
    try {
      await withMockFetch(
        async (url, init) => {
          if (String(url).endsWith("/v1/models"))
            return Response.json({ data: Object.keys(raw).map((id) => ({ id })) });
          const payload: unknown = JSON.parse(String(init?.body));
          if (!isRecord(payload) || typeof payload.model !== "string") throw new Error("Invalid model request");
          return Response.json(raw[payload.model]);
        },
        async () => {
          const models = await refresh({
            allowNetwork: true,
            force: true,
            signal: controller.signal,
            publish: async (value) => {
              publications.push(value);
              value.update?.();
              return true;
            },
          });
          expect(models).toHaveLength(5);
          expect(models.some((model) => model.id === "clef:27b")).toBe(false);
          expect(models.find((model) => model.id === "beam")).toMatchObject({
            thinkingLevelMap: { xhigh: "xhigh", max: "max" },
            maxTokens: 32768,
          });
          expect(publications[0].persist?.models.find((model) => model.id === "glm-5.3-flash:cloud")).toMatchObject({
            id: "glm-5.3-flash:cloud",
            thinkingLevelMap: { low: "low", medium: null },
            maxTokens: 32768,
          });
        },
      );
    } finally {
      controller.abort();
    }
  });

  it("keeps a valid unlisted alias unchanged through the actual chat service", async () => {
    const controller = new AbortController();
    const requestedId = "glm-5.3-flash:cloud";
    let calls = 0;
    try {
      await withMockFetch(
        async (url, init) => {
          const payload: unknown = JSON.parse(String(init?.body));
          if (!isRecord(payload)) throw new Error("Invalid payload");
          expect(payload.model).toBe(requestedId);
          if (String(url).endsWith("/api/show")) return Response.json(raw[requestedId]);
          calls += 1;
          expect(payload.max_tokens).toBe(4096);
          expect(payload.reasoning_effort).not.toBe("none");
          return chatResponse();
        },
        async () => {
          expect(
            (
              await completeOllamaChat(requestedId, controller.signal, async () => ({
                apiKey: "fixture",
                source: "auth.json",
              }))
            ).answer,
          ).toBe("2");
        },
      );
      expect(calls).toBe(1);
    } finally {
      controller.abort();
    }
  });
});
