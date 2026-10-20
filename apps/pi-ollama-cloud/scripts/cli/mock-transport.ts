/** Offline diagnostics install an explicit transport and restore it even on failure. */
export async function withMockFetch<T>(mock: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const originalKey = process.env.OLLAMA_API_KEY;
  globalThis.fetch = mock;
  delete process.env.OLLAMA_API_KEY;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
    if (originalKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = originalKey;
  }
}
export function chatResponse(): Response {
  const chunk = {
    id: "fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture",
    choices: [{ index: 0, delta: { role: "assistant", content: "2" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}
