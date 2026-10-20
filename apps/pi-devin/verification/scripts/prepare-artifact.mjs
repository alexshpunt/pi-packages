#!/usr/bin/env node
// Source-only helper: prepare dependencies without interpreting packed dev-only catalog/workspace specs.
import assert from "node:assert/strict";
import { cp, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const [consumerArg, artifactArg] = process.argv.slice(2);
if (!consumerArg || !artifactArg) throw new Error("Usage: node prepare-artifact.mjs <fresh-consumer-dir> <extracted-package-dir>");
const consumer = resolve(consumerArg), artifact = resolve(artifactArg);
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const manifest = await json(join(artifact, "package.json"));
const consumerManifest = await json(join(consumer, "package.json"));
const installed = await json(join(consumer, "node_modules/@buyong/pi-devin/package.json"));
const lock = await json(join(consumer, "package-lock.json"));
assert.equal(manifest.name, "@buyong/pi-devin");
assert.equal(installed.version, manifest.version);
assert.deepEqual(installed.dependencies, manifest.dependencies);
assert.deepEqual(Object.keys(consumerManifest.dependencies ?? {}), ["@buyong/pi-devin"]);
assert.equal(Object.keys(consumerManifest.devDependencies ?? {}).length, 0);
const packages = Object.entries(lock.packages).filter(([name]) => name && name !== "node_modules/@buyong/pi-devin");
for (const [name, info] of packages) {
  assert.equal(Boolean(info.dev || info.peer), false, "dev/peer dependency: " + name);
  assert.equal(/(?:^|\/)node_modules\/(?:@earendil-works\/|typebox(?:\/|$)|@repo\/|@typescript\/native-preview)/.test(name), false, "host/dev-only copy: " + name);
}
const destination = join(artifact, "node_modules");
await mkdir(destination); // Existing trees are not overwritten.
for (const name of await readdir(join(consumer, "node_modules"))) {
  if (name === "@buyong" || name === ".package-lock.json") continue;
  const source = join(consumer, "node_modules", name);
  if ((await lstat(source)).isSymbolicLink()) throw new Error("External symlinks are not copied: " + name);
  await cp(source, join(destination, name), { recursive: true, errorOnExist: true, force: false });
}
console.log(JSON.stringify({ status: "pass", artifact, dependencies: packages.map(([name, info]) => ({ name, version: info.version })) }, null, 2));
