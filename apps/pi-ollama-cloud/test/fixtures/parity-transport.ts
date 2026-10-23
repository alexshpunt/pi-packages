import assert from "node:assert/strict";

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(url.origin, "https://ollama.com");
  assert.equal(init?.redirect, "error");
  const payload = init?.body ? JSON.parse(String(init.body)) : {};
  if (url.pathname === "/api/show") return Response.json({ capabilities: ["tools", "thinking"], model_info: {} });
  if (url.pathname === "/api/balance")
    return Response.json({ included: { balance_usd: 50, allowance_usd: 60 }, purchased: { balance_usd: 0 } });
  if (url.pathname === "/api/web_search")
    return Response.json({ results: [{ title: "Ollama Cloud", url: "https://ollama.com", content: "Cloud models." }] });
  if (url.pathname === "/api/web_fetch")
    return Response.json({ title: "Ollama", content: "Ollama Cloud models. ".repeat(200), links: [] });
  if (url.pathname !== "/v1/chat/completions") throw new Error("Unexpected endpoint");
  if (process.env.PARITY_FIXTURE_FAILURE === "chat") return new Response("fixture", { status: 401 });
  const messages = payload.messages as { role: string; content: unknown }[];
  const prompt = String(messages.filter((message) => message.role === "user").at(-1)?.content);
  const addition = /What is (\d+)\+(\d+)/.exec(prompt);
  const content = addition
    ? String(Number(addition[1]) + Number(addition[2]))
    : prompt.includes("token")
      ? "amber-kiwi-472"
      : prompt.includes("times")
        ? "42"
        : "Ollama provides cloud models.";
  const name = prompt.startsWith("Call ") ? payload.tools?.[0]?.function?.name : undefined;
  const delta = name
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "verification-call",
            type: "function",
            function: {
              name,
              arguments: JSON.stringify(
                name === "ollama_web_search"
                  ? { query: "Ollama Cloud", max_results: 3 }
                  : { url: "https://ollama.com" },
              ),
            },
          },
        ],
      }
    : { role: "assistant", content };
  const chunk = {
    id: "fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: payload.model,
    choices: [{ index: 0, delta, finish_reason: name ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
};
