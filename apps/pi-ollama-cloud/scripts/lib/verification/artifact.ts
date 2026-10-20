import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));
const hosts = new Set([
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
]);
interface Manifest {
  name: string;
  version: string;
  files: string[];
  pi: { extensions: string[] };
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}
const manifestAt = (root: string) => JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Manifest;
export function runtimeFiles(root = packageRoot): string[] {
  const files = manifestAt(root).files.filter((file) => !file.endsWith("/"));
  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relative(root, path).replaceAll("\\", "/"));
    }
  }
  walk(join(root, "src"));
  return [...new Set(["package.json", ...files])].sort();
}
export function assertRuntimeBoundary(root = packageRoot): void {
  const manifest = manifestAt(root);
  assert.equal(manifest.name, "@buyong/pi-ollama-cloud");
  assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]);
  assert.deepEqual(
    readdirSync(root).filter((file) => file.endsWith(".ts")),
    [],
  );
  for (const file of runtimeFiles(root).filter((file) => file.endsWith(".ts"))) {
    const source = readFileSync(join(root, file), "utf8");
    for (const match of source.matchAll(/\b(?:from|import)\s+["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier.startsWith(".")) {
        assert.ok(!/(^|\/)(scripts|test|tests)\//.test(specifier), `Runtime imports development code: ${file}`);
      } else if (!specifier.startsWith("node:")) {
        const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
        if (hosts.has(name)) {
          assert.equal(manifest.peerDependencies?.[name], "*");
          assert.equal(manifest.dependencies?.[name], undefined);
        } else assert.ok(manifest.dependencies?.[name], `Undeclared runtime import in ${file}: ${name}`);
      }
    }
  }
}
/** Materialize only declared production packages from the installed tree; no registry or dev-only files. */
export function materializeProductionDependencies(target: string): { name: string; version: string }[] {
  const copied: { name: string; version: string }[] = [];
  function copy(name: string, source: string, parent: string, ancestors: Map<string, string>) {
    assert.ok(!hosts.has(name), "Host dependencies must be supplied by Pi, not copied.");
    const require = createRequire(join(source, "package.json"));
    const sourceManifest = require.resolve(`${name}/package.json`);
    if (ancestors.get(name) === sourceManifest) return;
    const sourceDir = dirname(sourceManifest);
    const destination = join(parent, "node_modules", name);
    const manifest = JSON.parse(readFileSync(sourceManifest, "utf8")) as {
      name: string;
      version: string;
      dependencies?: Record<string, string>;
    };
    cpSync(sourceDir, destination, {
      recursive: true,
      dereference: true,
      filter: (path) => path === sourceDir || !path.slice(sourceDir.length).split(/[\\/]/).includes("node_modules"),
    });
    copied.push({ name: manifest.name, version: manifest.version });
    const next = new Map(ancestors);
    next.set(name, sourceManifest);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) copy(dependency, sourceDir, destination, next);
  }
  for (const name of Object.keys(manifestAt(target).dependencies ?? {})) copy(name, packageRoot, target, new Map());
  return copied;
}
export function packArtifact(directory: string) {
  assertRuntimeBoundary();
  const destination = join(directory, "pack");
  const extraction = join(directory, "extracted");
  mkdirSync(destination, { recursive: true });
  mkdirSync(extraction, { recursive: true });
  execFileSync("pnpm", ["pack", "--pack-destination", destination], {
    cwd: packageRoot,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000,
  });
  const names = readdirSync(destination).filter((name) => name.endsWith(".tgz"));
  assert.equal(names.length, 1);
  const tarball = join(destination, names[0]);
  const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((file) => file.replace(/^package\//, ""))
    .filter(Boolean)
    .sort();
  assert.ok(
    files.every(
      (file) =>
        !/^(scripts|test|tests|node_modules)\//.test(file) && (!file.endsWith(".ts") || file.startsWith("src/")),
    ),
    "Development/runtime copies leaked into archive",
  );
  execFileSync("tar", ["-xzf", tarball, "-C", extraction]);
  const root = join(extraction, "package");
  for (const file of runtimeFiles()) {
    assert.ok(files.includes(file), `Missing artifact file: ${file}`);
    if (file !== "package.json")
      assert.deepEqual(
        readFileSync(join(root, file)),
        readFileSync(join(packageRoot, file)),
        `Artifact differs: ${file}`,
      );
  }
  const source = manifestAt(packageRoot);
  const artifact = manifestAt(root);
  for (const key of ["name", "version", "pi", "dependencies", "peerDependencies"] as const)
    assert.deepEqual(artifact[key], source[key]);
  assert.ok(
    !/"(?:workspace|catalog):/.test(readFileSync(join(root, "package.json"), "utf8")),
    "Unresolved monorepo dependency protocol",
  );
  const dependencies = materializeProductionDependencies(root);
  assertRuntimeBoundary(root);
  return { root, tarball, files, dependencies };
}
