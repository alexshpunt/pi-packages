export const PARITY_MODEL_ID = "glm-5.3-flash:cloud";
export const PARITY_MAX_TOKENS = 1024;
export const PARITY_LIMITS = { chat: 50, search: 2, fetch: 2, balance: 4, metadata: 1 } as const;
export type ParitySlot = keyof typeof PARITY_LIMITS;

/** Counts before dispatch, including failed requests. Never retries or follows redirects. */
export function createParityBudget(options: { apiKey: string; fetch: typeof globalThis.fetch; record: () => void }) {
  const counts: Record<ParitySlot, number> = { chat: 0, search: 0, fetch: 0, balance: 0, metadata: 0 };
  const chatCases = new Set<string>();
  let activeCase: string | undefined;
  let blocked = 0;
  const refuse = (): never => {
    blocked += 1;
    options.record();
    throw new Error("Live verification endpoint, payload, or request budget rejected");
  };
  const guardedFetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://ollama.com" || url.search || url.username || url.password) return refuse();
    if (request.headers.get("Authorization") !== `Bearer ${options.apiKey}`) return refuse();
    const payload = request.method === "POST" ? await request.clone().json() : {};
    let slot: ParitySlot;
    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      if (
        !activeCase ||
        chatCases.has(activeCase) ||
        payload.model !== PARITY_MODEL_ID ||
        payload.max_tokens !== PARITY_MAX_TOKENS ||
        payload.stream !== true
      )
        return refuse();
      slot = "chat";
    } else if (
      url.pathname === "/api/web_search" &&
      request.method === "POST" &&
      payload.query === "Ollama Cloud" &&
      payload.max_results === 3
    )
      slot = "search";
    else if (url.pathname === "/api/web_fetch" && request.method === "POST" && payload.url === "https://ollama.com")
      slot = "fetch";
    else if (url.pathname === "/api/show" && request.method === "POST" && payload.model === PARITY_MODEL_ID)
      slot = "metadata";
    else if (url.pathname === "/api/balance" && request.method === "GET") slot = "balance";
    else return refuse();
    if (counts[slot] >= PARITY_LIMITS[slot]) return refuse();
    if (slot === "chat") chatCases.add(activeCase!);
    counts[slot] += 1;
    options.record();
    return options.fetch(input, { ...init, redirect: "error" });
  };
  return {
    counts,
    get blocked() {
      return blocked;
    },
    setCase(id: string | undefined) {
      activeCase = id;
    },
    fetch: guardedFetch,
  };
}
