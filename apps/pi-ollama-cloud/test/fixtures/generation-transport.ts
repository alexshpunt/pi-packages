import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import { fixtureDetails, fixtureIds, fixturePricing, fixtureReasoning } from "./generation-data.ts";

const mode = process.env.OLLAMA_GENERATION_FIXTURE;
if (!mode) throw new Error("Expected generator fixture mode");
const counts = { catalog: 0, details: 0, pricing: 0, reasoning: 0, probe: 0, unexpected: 0 };
const originalWrite = fs.writeFileSync;
const originalRename = fs.renameSync;
fs.writeFileSync = (path, ...args) => {
  if (mode === "write-failure" && String(path).includes(".catalog.generated.ts.") && String(path).endsWith(".tmp"))
    throw new Error("fixture write failed");
  return originalWrite(path, ...args);
};
fs.renameSync = (from, to) => {
  if (basename(String(to)) !== "catalog.generated.ts") return originalRename(from, to);
  if (mode === "rename-failure") throw new Error("fixture rename failed");
  if (mode === "crash-before") {
    process.kill(process.pid, "SIGKILL");
    throw new Error("fixture stop");
  }
  originalRename(from, to);
  if (mode === "crash-after") {
    process.kill(process.pid, "SIGKILL");
    throw new Error("fixture stop");
  }
};
syncBuiltinESMExports();
globalThis.fetch = async (url, init) => {
  const address = String(url);
  if (address.endsWith("/v1/models")) {
    counts.catalog += 1;
    return Response.json({ data: mode === "empty" ? [] : fixtureIds.map((id) => ({ id })) });
  }
  if (address.endsWith("/api/show")) {
    counts.details += 1;
    const { model } = JSON.parse(String(init?.body)) as { model: string };
    if (mode === "all-failed" || (mode === "partial" && model === "fixture-b"))
      return new Response("fixture failure", { status: 500 });
    return Response.json(fixtureDetails());
  }
  if (address === "https://ollama.com/pricing") {
    counts.pricing += 1;
    return new Response(mode === "invalid-pricing" ? "<table>schema changed</table>" : fixturePricing);
  }
  if (address === "https://models.dev/api.json") {
    counts.reasoning += 1;
    return Response.json(mode === "invalid-reasoning" ? { changed: true } : fixtureReasoning);
  }
  if (address.endsWith("/v1/chat/completions")) {
    counts.probe += 1;
    return new Response("fixture probe unavailable", { status: 429 });
  }
  counts.unexpected += 1;
  throw new Error("Unexpected generator fixture request");
};
process.once("exit", () => {
  console.log(`fixture-counts=${JSON.stringify(counts)}`);
});
