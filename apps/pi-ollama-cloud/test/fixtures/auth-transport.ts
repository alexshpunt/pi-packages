/** Preloaded only by the script-consumer test subprocesses. No live network is possible. */
globalThis.fetch = async (url, init) => {
  const address = url instanceof Request ? url.url : String(url);
  const matches = new Headers(init?.headers).get("Authorization") === "Bearer fixture-consumer";
  console.log(`fixture-auth-match=${matches}`);
  if (!matches) throw new Error("Resolved credential did not reach the consumer.");
  if (address.endsWith("/api/web_search")) {
    return Response.json({ results: [{ title: "fixture", url: "https://example.test", content: "fixture" }] });
  }
  if (address.endsWith("/api/web_fetch")) return Response.json({ title: "fixture", content: "fixture", links: [] });
  if (address.endsWith("/chat/completions")) return Response.json({ error: "fixture rejection" }, { status: 503 });
  throw new Error("Unexpected fixture request.");
};
