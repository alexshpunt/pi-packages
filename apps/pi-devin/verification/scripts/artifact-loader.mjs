// Source-only Node test preload. The artifact itself gets no SDK copies or test files.
import { registerHooks } from "node:module";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  return pathToFileURL(resolve(root, selected)).href;
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
registerHooks({
  resolve(specifier, context, next) {
    const host = peers.get(specifier);
    if (host) return next(host, context);
    if (context.parentURL && (specifier.startsWith(".") || specifier.startsWith("file:") || specifier.startsWith("/"))) {
      const url = new URL(specifier, context.parentURL);
      if (url.protocol === "file:") {
        const file = fileURLToPath(url), local = relative(sourceRoot, file);
        if (local.startsWith("src" + sep) || ["index.ts", "cli.ts"].includes(local)) {
          const replacement = resolve(artifactRoot, local);
          mappedFiles.add(local);
          return next(pathToFileURL(replacement).href, context);
        }
      }
    }
    return next(specifier, context);
  },
});
const reportDir = process.env.PI_DEVIN_TEST_REPORT_DIR;
if (reportDir) process.on("exit", () => {
  writeFileSync(join(reportDir, "artifact-mapping-" + process.pid + ".json"), JSON.stringify({
    sourceRoot, artifactRoot, piRoot, mappedFiles: [...mappedFiles].sort(),
    hostEntries: Object.fromEntries(peers),
  }, null, 2) + "\n");
});
