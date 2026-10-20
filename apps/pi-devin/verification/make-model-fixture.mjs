import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseModelCatalog } from "../src/core/models/catalog.ts";
import { projectModelVariants } from "../src/core/models/variants.ts";

const [sourcePath, destination, auditPath] = process.argv.slice(2);
if (!sourcePath || !destination || !auditPath) throw new Error("Usage: node verification/make-model-fixture.mjs <source.json> <fixture.json> <audit.json>");
const bytes = await readFile(resolve(sourcePath));
const audit = JSON.parse(await readFile(resolve(auditPath), "utf8"));
const source = JSON.parse(bytes.toString("utf8"));
const projection = projectModelVariants(parseModelCatalog(source));
const hash = (value) => createHash("sha256").update(value).digest("hex");
assert.equal(hash(bytes), audit.sourceSha256);
assert.equal(projection.variants.length, audit.summary.models);
assert.equal(projection.groups.length, audit.summary.groups);
assert.equal(projection.unsupported.length, audit.summary.unmappedModels);
for (const group of projection.groups) {
  const previous = audit.groups.find((item) => item.family === group.family && JSON.stringify(item.dimensions) === JSON.stringify(group.dimensions));
  assert.ok(previous, "missing historical group");
  assert.deepEqual(group.mappings, previous.mappings);
}
const fixture = { clientModelConfigs: projection.variants.map((variant) => variant.config) };
const output = JSON.stringify(fixture, null, 2) + "\n";
await writeFile(resolve(destination), output);
const result = {
  sourceSha256: hash(bytes), auditSha256: hash(await readFile(resolve(auditPath))), fixtureSha256: hash(output),
  models: projection.variants.length, groups: projection.groups.length,
  publishedGroups: projection.groups.filter((group) => group.canPublish).length,
  mapped: projection.variants.filter((variant) => variant.level !== undefined).length,
  unsupported: projection.unsupported,
  historicalMappingsEqual: true,
  transformation: "model identity, declared dimensions, context/output and capabilities only; no full source response, pricing inference or auth data",
};
await writeFile(resolve(destination) + ".provenance.json", JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
