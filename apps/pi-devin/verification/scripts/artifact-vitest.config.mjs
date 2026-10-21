// Source-only Vitest configuration that runs the provider tests against an extracted artifact.
// The artifact itself gets no SDK copies or test files.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import base from "../../vitest.config.ts";

// The archive has no CLI (`cli.ts`, `src/cli/`), so only these suites can load from it.
const ARTIFACT_TESTS = [
  "tests/pi-provider*.test.ts",
  "tests/pi-integration.test.ts",
  "tests/pi-runtime.test.ts",
  "tests/pi-lifecycle*.test.ts",
];

const sourceRoot = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const artifactRoot = realpathSync(required("PI_DEVIN_TEST_PACKAGE_ROOT"));
const piRoot = realpathSync(required("PI_DEVIN_TEST_PI_ROOT"));
if (sourceRoot === artifactRoot) throw new Error("The target must be an extracted artifact, not the source.");
const manifest = JSON.parse(readFileSync(join(artifactRoot, "package.json"), "utf8"));
if (manifest.name !== "@buyong/pi-devin") throw new Error("Not the Devin package.");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required.");
  return value;
}
function target(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  for (const [key, entry] of Object.entries(value)) {
    if (["node", "import", "default"].includes(key)) {
      const result = target(entry);
      if (result) return result;
    }
  }
}
function entry(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const selected = pkg.exports ? target(pkg.exports["."] ?? pkg.exports) : pkg.main ?? "./index.js";
  if (!selected) throw new Error("No public import entry: " + pkg.name);
  return resolve(root, selected);
}
function peerRoot(name) {
  for (let directory = piRoot;; directory = dirname(directory)) {
    try {
      const root = realpathSync(join(directory, "node_modules", name));
      if (JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name === name) return root;
    } catch {}
    if (directory === dirname(directory)) break;
  }
  throw new Error("Host peer not found: " + name);
}
const peers = new Map([
  ["@earendil-works/pi-coding-agent", entry(piRoot)],
  ["@earendil-works/pi-ai", entry(peerRoot("@earendil-works/pi-ai"))],
  ["@earendil-works/pi-tui", entry(peerRoot("@earendil-works/pi-tui"))],
]);
const mappedFiles = new Set();

// Vitest resolves every import of the tests and of the modules they load here, in its main process.
const artifactRedirect = {
  name: "pi-devin-artifact-redirect",
  enforce: "pre",
  resolveId(source, importer) {
    const host = peers.get(source);
    if (host) return host;
    if (!importer || !(source.startsWith(".") || source.startsWith("file:") || source.startsWith("/"))) return null;
    const queryStart = source.indexOf("?");
    const path = queryStart < 0 ? source : source.slice(0, queryStart);
    const query = queryStart < 0 ? "" : source.slice(queryStart);
    const file = path.startsWith("file:") ? fileURLToPath(path) : resolve(dirname(importer.split("?")[0]), path);
    const local = relative(sourceRoot, file);
    if (!local.startsWith("src" + sep) && !["index.ts", "cli.ts"].includes(local)) return null;
    mappedFiles.add(local);
    return resolve(artifactRoot, local) + query;
  },
};

const reportDir = process.env.PI_DEVIN_TEST_REPORT_DIR;
if (reportDir) process.on("exit", () => {
  writeFileSync(join(reportDir, "artifact-mapping-" + process.pid + ".json"), JSON.stringify({
    sourceRoot, artifactRoot, piRoot, mappedFiles: [...mappedFiles].sort(),
    hostEntries: Object.fromEntries(peers),
  }, null, 2) + "\n");
});

export default defineConfig({
  ...base,
  root: sourceRoot,
  plugins: [artifactRedirect],
  test: { ...base.test, include: ARTIFACT_TESTS },
});
