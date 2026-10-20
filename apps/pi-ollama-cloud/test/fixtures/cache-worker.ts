import { createCache } from "../../src/cache/storage.ts";

const [path, key] = process.argv.slice(2);
if (!path || !key || !process.send) throw new Error("Expected cache path, key and IPC.");
const cache = createCache({ path });
const snapshot = cache.loadCache();
process.send({ event: "ready" });
process.on("message", (message: unknown) => {
  if (message !== "write") return;
  snapshot.pages[key] = { ts: Date.now(), title: key, content: "fixture" };
  cache.saveCache();
  process.send?.({ event: "done", writeFailed: cache.getDiagnostics?.().hasWriteFailed });
});
