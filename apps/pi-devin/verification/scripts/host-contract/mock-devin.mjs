// Loopback Devin service for host-contract verification. Replies with the source checkout's codec and the de-identified fixture catalog,
// and records received requests as summaries without identifying data. Not shipped.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";

export const FAKE_OAUTH_TOKEN = "host-contract-fake-oauth-session";
const STATUS_METHOD = "exa.seat_management_pb.SeatManagementService/GetUserStatus";
const TEAM_METHOD = "exa.seat_management_pb.SeatManagementService/GetCliTeamSettings";
const MODELS_METHOD = "exa.api_server_pb.ApiServerService/GetCliModelConfigs";

const shortHash = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Chat plan: `{ frames, end }`. end is one of "ok" (normal trailer), "hang" (wait until the connection closes)
 * or `{ code, message }` (Connect error trailer). delayMs is the gap between frames.
 */
export async function startMockDevin({ sourceRoot, catalogPath }) {
  const protobuf = await import(new URL("src/core/protocol/protobuf.ts", sourceRoot).href);
  const transport = await import(new URL("src/core/protocol/transport.ts", sourceRoot).href);
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const requests = [];
  const sockets = new Set();
  let chatPlan = () => ({ frames: [{ messageId: "bot", deltaText: "OK" }, { stopReason: "STOP_REASON_STOP_PATTERN" }], end: "ok" });
  let chatIndex = 0;

  const encodeChat = (frame) => transport.encodeFrame(protobuf.chatResponseCodec.encode(frame));
  const trailer = (error) => transport.encodeFrame(Buffer.from(JSON.stringify(error ? { error } : {})), 2);

  const summarizeChat = (body) => {
    const prompts = Array.isArray(body.chatMessagePrompts) ? body.chatMessagePrompts : [];
    return {
      chatModelUid: body.chatModelUid,
      cascade: shortHash(body.cascadeId ?? ""),
      sources: prompts.map((prompt) => String(prompt.source ?? "").replace("CHAT_MESSAGE_SOURCE_", "")),
      cacheMarks: prompts.map((prompt) => prompt.promptCacheOptions?.type ? String(prompt.promptCacheOptions.type).replace("CACHE_CONTROL_TYPE_", "") : null),
      hasSystemPromptCacheOptions: "systemPromptCacheOptions" in body,
      tools: Array.isArray(body.tools) ? body.tools.map((tool) => tool.name) : [],
      toolResults: prompts.filter((prompt) => prompt.source === "CHAT_MESSAGE_SOURCE_TOOL").map((prompt) => String(prompt.prompt ?? "")),
      lastUserText: [...prompts].reverse().find((prompt) => prompt.source === "CHAT_MESSAGE_SOURCE_USER")?.prompt ?? null,
      lastPrompt: prompts.length ? { source: String(prompts.at(-1).source ?? "").replace("CHAT_MESSAGE_SOURCE_", ""), text: String(prompts.at(-1).prompt ?? "") } : null,
      hasFusionGuidance: typeof body.prompt === "string" && body.prompt.includes("Fusion mode: you are the lead."),
      hasSidekickPrompt: typeof body.prompt === "string" && body.prompt.includes("You are the sidekick"),
      maxTokens: body.configuration?.maxTokens === undefined ? null : String(body.configuration.maxTokens),
    };
  };

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const method = (req.url ?? "/").slice(1);
    const entry = { seq: requests.length + 1, atMs: Date.now(), method: method.split("/").pop(),
      tokenMatches: req.headers.authorization === `Basic ${FAKE_OAUTH_TOKEN}-${FAKE_OAUTH_TOKEN}` };
    requests.push(entry);
    try {
      if (method === protobuf.CHAT_METHOD) {
        const body = protobuf.chatRequestCodec.decode(bytes[0] & 1 ? gunzipSync(bytes.subarray(5)) : bytes.subarray(5));
        entry.metadataKeyMatches = body.metadata?.apiKey === FAKE_OAUTH_TOKEN;
        Object.assign(entry, summarizeChat(body));
        chatIndex++;
        const plan = chatPlan(entry, chatIndex);
        entry.plan = plan.label ?? null;
        res.on("close", () => { if (!res.writableFinished) entry.clientClosedEarly = true; });
        res.writeHead(200, { "content-type": "application/connect+proto" });
        for (const frame of plan.frames ?? []) {
          if (res.destroyed) return;
          res.write(encodeChat(frame));
          if (plan.delayMs) await sleep(plan.delayMs);
        }
        if (plan.end === "hang") {
          entry.hung = true;
          await new Promise((resolve) => res.on("close", resolve));
          return;
        }
        res.end(trailer(plan.end === "ok" || plan.end === undefined ? undefined : plan.end));
        return;
      }
      const codecs = protobuf.unaryCodecs(method);
      const request = codecs.request.decode(bytes);
      entry.metadataKeyMatches = request.metadata?.apiKey === FAKE_OAUTH_TOKEN;
      let response;
      if (method === STATUS_METHOD) response = { userStatus: { userId: "host-contract-user", planStatus: {
        planInfo: { billingStrategy: "BILLING_STRATEGY_QUOTA", devinInfo: { canUseCli: true, orgId: "host-contract-org" } },
        dailyQuotaRemainingPercent: 100, weeklyQuotaRemainingPercent: 100 } } };
      else if (method === MODELS_METHOD) response = catalog;
      else if (method === TEAM_METHOD) response = {};
      else throw new Error("unexpected method");
      res.writeHead(200, { "content-type": "application/proto" });
      res.end(Buffer.from(codecs.response.encode(response)));
    } catch (error) {
      entry.unexpected = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) res.writeHead(404);
      res.end();
    }
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    requests,
    setChat(plan) { chatPlan = plan; chatIndex = 0; },
    openConnections: () => sockets.size,
    async waitFor(predicate, timeoutMs, label) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(requests)) {
        if (Date.now() > deadline) throw new Error(`mock wait timed out: ${label}`);
        await sleep(20);
      }
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
