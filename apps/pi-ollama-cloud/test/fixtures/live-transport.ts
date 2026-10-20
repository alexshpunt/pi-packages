import { chatResponse } from "../../scripts/cli/mock-transport.ts";

const counts = { chat: 0, search: 0, fetch: 0, metadata: 0, balance: 0, unexpected: 0 };
globalThis.fetch = async (url) => {
  const address = String(url);
  if (address.endsWith("/api/show")) {
    counts.metadata++;
    return Response.json({ capabilities: ["tools"] });
  }
  if (address.endsWith("/chat/completions")) {
    counts.chat++;
    return chatResponse();
  }
  if (address.endsWith("/api/web_search")) {
    counts.search++;
    if (process.env.LIVE_FIXTURE_FAILURE === "search") return new Response("fixture", { status: 429 });
    return Response.json({ results: [{ title: "fixture", url: "https://example.test", content: "fixture body" }] });
  }
  if (address.endsWith("/api/balance")) {
    counts.balance++;
    return Response.json({ included: { balance_usd: 50, allowance_usd: 60 }, purchased: { balance_usd: 0 } });
  }
  if (address.endsWith("/api/web_fetch")) {
    counts.fetch++;
    return Response.json({ title: "fixture", content: "fixture ".repeat(1000), links: [] });
  }
  counts.unexpected++;
  throw new Error("Unexpected fixture endpoint");
};
process.once("exit", () => console.log("MOCK_LIVE_COUNTS=" + JSON.stringify(counts)));
