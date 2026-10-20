#!/usr/bin/env node
// Checks the runtime closure by following static and dynamic imports and import.meta.url resource references from the shipped entry points.
// Confirms that every reached file is inside the manifest files, none points to dev-only paths, and external packages are declared dependencies.
// Source-only verification tool; not shipped.
//
// usage: node verification/scripts/import-closure.mjs <package-dir> [--expect <inventory.json>] [--report <path>]
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { expect: { type: "string" }, report: { type: "string" } } });
if (positionals.length !== 1) {
  console.error("usage: node verification/scripts/import-closure.mjs <package-dir> [--expect <inventory.json>] [--report <path>]");
  process.exit(2);
}
const root = resolve(positionals[0]);
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const inventory = values.expect ? JSON.parse(readFileSync(values.expect, "utf8")) : {};
const devOnly = inventory.devOnlyPaths ?? [];
const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
// The check CLI (`cli.ts`) is source-only and not shipped, so only the Pi extension entries start the closure.
const entries = (manifest.pi?.extensions ?? []).map((path) => path.replace(/^\.\//, ""));

// npm always puts package.json in the archive regardless of `files`.
const inFiles = (path) => path === "package.json" || (manifest.files ?? []).some((entry) => path === entry || path.startsWith(entry.replace(/\/?$/, "/")));
const isDevOnly = (path) => devOnly.some((entry) => entry.endsWith("/") ? path.startsWith(entry) : path === entry);
const packageName = (specifier) => specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
const RESOURCE = /new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g;

const reached = new Map(), resources = new Set(), packages = new Map(), problems = [];
const queue = [...entries];
while (queue.length) {
  const path = queue.shift();
  if (reached.has(path)) continue;
  const absolute = join(root, path);
  if (!existsSync(absolute)) { problems.push({ kind: "missing", path }); continue; }
  const source = readFileSync(absolute, "utf8");
  reached.set(path, 0);
  for (const [, specifier] of source.matchAll(SPECIFIER)) {
    reached.set(path, reached.get(path) + 1);
    if (specifier.startsWith(".")) {
      const target = relative(root, resolve(dirname(absolute), specifier));
      if (target.startsWith("..")) problems.push({ kind: "outside-package", from: path, specifier });
      else queue.push(target);
    } else if (!builtins.has(specifier)) {
      const name = packageName(specifier);
      packages.set(name, [...(packages.get(name) ?? []), path]);
      if (!declared.has(name)) problems.push({ kind: "undeclared-package", from: path, specifier });
    }
  }
  for (const [, specifier] of source.matchAll(RESOURCE)) {
    const target = relative(root, resolve(dirname(absolute), specifier));
    resources.add(target);
    if (!existsSync(join(root, target))) problems.push({ kind: "missing-resource", from: path, target });
  }
}
for (const path of [...reached.keys(), ...resources]) {
  if (!inFiles(path)) problems.push({ kind: "not-in-manifest-files", path });
  if (isDevOnly(path)) problems.push({ kind: "dev-only-reached", path });
}
const report = {
  schemaVersion: 1, tool: "import-closure", entries,
  scannedFiles: reached.size, files: [...reached.keys()].sort(), resources: [...resources].sort(),
  externalPackages: Object.fromEntries([...packages].map(([name, from]) => [name, new Set(from).size]).sort()),
  devOnlyPaths: devOnly, problems, ok: problems.length === 0,
};
if (values.report) await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ok: report.ok, scannedFiles: report.scannedFiles, resources: report.resources, externalPackages: report.externalPackages, problems }));
process.exitCode = report.ok ? 0 : 1;
