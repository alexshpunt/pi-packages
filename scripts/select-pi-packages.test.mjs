import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const bundle = "@buyong/pi-codex";
const memory = "@buyong/pi-codex-memory";
const review = "@buyong/pi-codex-auto-review";
const fast = "@buyong/pi-codex-fast-mode";
const ollama = "@buyong/pi-ollama-cloud";
const redact = "@buyong/redact";
const redactApp = "@buyong/pi-redact";
const config = "@repo/typescript-config";
const all = [bundle, memory, review, fast, ollama, redact, redactApp].sort();
const checker = "node ../../scripts/codex/check-package.mjs .";
const workspace = `packages:
  - apps/*
  - packages/*
catalogs:
  memory:
    sdk: 1.0.0
`;

// The lockfile reader expects pnpm's block-style YAML, including its version header.
function lockfileYaml(value, indent = "") {
  return Object.entries(value).map(([key, entry]) => {
    const name = /^[\w.-]+$/.test(key) ? key : JSON.stringify(key);
    const nested = entry !== null && typeof entry === "object" && Object.keys(entry).length > 0;
    return `${indent}${name}:${nested ? `\n${lockfileYaml(entry, `${indent}  `)}` : ` ${JSON.stringify(entry)}\n`}`;
  }).join("");
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-package-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    const contents = typeof value === "string" ? value : path === "pnpm-lock.yaml" ? lockfileYaml(value) : `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(join(root, path), contents);
  };
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  const commit = () => {
    git("add", ".");
    git("-c", "user.name=CI", "-c", "user.email=ci@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  put(".gitignore", "node_modules/\nevent.json\noutput.txt\n");
  put("package.json", { name: "pi-packages", private: true, packageManager: "pnpm@10.29.2" });
  put("pnpm-workspace.yaml", workspace);
  put("turbo.json", { tasks: {} });
  put("scripts/codex/check-package.mjs", "// shared archive checker\n");
  for (const name of ["select-pi-packages.mjs", "pi-apps.mjs"]) {
    copyFileSync(join(repository, "scripts", name), join(root, "scripts", name));
  }
  mkdirSync(join(root, "node_modules"));
  symlinkSync(join(repository, "node_modules/turbo"), join(root, "node_modules/turbo"), "dir");

  const manifests = {
    "apps/pi-codex": { name: bundle, dependencies: { [memory]: "workspace:*", [review]: "workspace:*", [fast]: "workspace:*" } },
    "apps/pi-codex-memory": {
      name: memory, dependencies: { [redact]: "workspace:*" },
      devDependencies: { sdk: "catalog:memory" }, scripts: { prepack: checker },
    },
    "apps/pi-codex-auto-review": {
      name: review, dependencies: { [redact]: "workspace:*" },
      devDependencies: { [config]: "workspace:*" }, scripts: { prepack: checker },
    },
    "apps/pi-codex-fast-mode": { name: fast, optionalDependencies: { [config]: "workspace:*" } },
    "apps/pi-ollama-cloud": { name: ollama },
    "apps/pi-redact": { name: redactApp, dependencies: { [redact]: "workspace:*" } },
    "packages/redact": { name: redact, scripts: { prepack: checker } },
    "packages/typescript-config": { name: config, private: true },
  };
  const lock = {
    lockfileVersion: "9.0",
    settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
    catalogs: { memory: { sdk: { specifier: "1.0.0", version: "1.0.0" } } },
    importers: { ".": {} },
    packages: { "sdk@1.0.0": { resolution: {} }, "leaf@1.0.0": { resolution: {} } },
    snapshots: { "sdk@1.0.0": { dependencies: { leaf: "1.0.0" } }, "leaf@1.0.0": {} },
  };
  for (const [path, manifest] of Object.entries(manifests)) {
    put(`${path}/package.json`, { version: "1.0.0", ...(path.startsWith("apps/") ? { pi: {} } : {}), ...manifest });
    put(`${path}/index.js`, "export {};\n");
    const importer = {};
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      if (!manifest[field]) continue;
      importer[field] = Object.fromEntries(Object.entries(manifest[field]).map(([name, specifier]) => {
        const target = Object.keys(manifests).find((path) => manifests[path].name === name);
        return [name, { specifier, version: target ? `link:${relative(path, target)}` : "1.0.0" }];
      }));
    }
    lock.importers[path] = importer;
  }
  put("pnpm-lock.yaml", lock);
  git("init", "-q");
  const base = commit();
  const select = (eventName = "pull_request", event = { pull_request: { base: { sha: base } } }, ref = "refs/pull/1/merge") => {
    put("event.json", event);
    put("output.txt", "");
    execFileSync(process.execPath, [join(root, "scripts/select-pi-packages.mjs")], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        TURBO_TELEMETRY_DISABLED: "1",
        GITHUB_EVENT_NAME: eventName,
        GITHUB_EVENT_PATH: join(root, "event.json"),
        GITHUB_OUTPUT: join(root, "output.txt"),
        GITHUB_REF: ref,
      },
    });
    const output = Object.fromEntries(readFileSync(join(root, "output.txt"), "utf8").trim().split("\n").map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }));
    return { ...output, names: JSON.parse(output.matrix).include.map(({ name }) => name).sort() };
  };
  return { root, put, git, commit, base, lock, select };
}

function expectNames(actual, expected) {
  assert.deepEqual(actual.names, [...expected].sort());
  assert.equal(actual["has-packages"], String(expected.length > 0));
}

function upgradeMemory(f) {
  f.lock.importers["apps/pi-codex-memory"].devDependencies.sdk.version = "2.0.0";
  f.lock.catalogs.memory.sdk = { specifier: "2.0.0", version: "2.0.0" };
  f.lock.packages["sdk@2.0.0"] = { resolution: {} };
  f.lock.snapshots["sdk@2.0.0"] = {};
  f.put("pnpm-lock.yaml", f.lock);
}

test("selects a changed component and its bundle, not its unchanged dependencies", (t) => {
  const f = fixture(t);
  f.put("apps/pi-codex-memory/index.js", "export const changed = true;\n");
  f.commit();
  const selected = f.select();
  expectNames(selected, [memory, bundle]);
  assert.equal(selected["check-auto-review-platforms"], "false");
  assert.equal(selected["check-selection"], "false");
});

test("selects a shared library and its transitive consumers", (t) => {
  const f = fixture(t);
  f.put("packages/redact/index.js", "export const changed = true;\n");
  f.commit();
  const selected = f.select();
  expectNames(selected, [redact, redactApp, memory, review, bundle]);
  assert.equal(selected["check-auto-review-platforms"], "true");
});

test("follows private workspace devDependencies and optionalDependencies", (t) => {
  const f = fixture(t);
  f.put("packages/typescript-config/index.js", "export const changed = true;\n");
  f.commit();
  expectNames(f.select(), [review, fast, bundle]);
});

test("narrows a lockfile-only importer update", (t) => {
  const f = fixture(t);
  upgradeMemory(f);
  f.commit();
  const selected = f.select();
  expectNames(selected, [memory, bundle]);
  assert.equal(selected["check-selection"], "true");
});

test("detects transitive lockfile changes even when importers are unchanged", (t) => {
  const f = fixture(t);
  f.lock.packages["leaf@2.0.0"] = { resolution: {} };
  f.lock.snapshots["leaf@2.0.0"] = {};
  f.lock.snapshots["sdk@1.0.0"].dependencies.leaf = "2.0.0";
  f.put("pnpm-lock.yaml", f.lock);
  f.commit();
  expectNames(f.select(), [memory, bundle]);
});

test("narrows a catalog update to its actual consumers", (t) => {
  const f = fixture(t);
  f.put("pnpm-workspace.yaml", workspace.replace("sdk: 1.0.0", "sdk: 2.0.0"));
  upgradeMemory(f);
  f.commit();
  expectNames(f.select(), [memory, bundle]);
});

test("keeps non-catalog workspace settings global even with a lockfile update", (t) => {
  const f = fixture(t);
  f.put("pnpm-workspace.yaml", `${workspace}\nignoredBuiltDependencies:\n  - sdk\n`);
  upgradeMemory(f);
  f.commit();
  expectNames(f.select(), all);
});

test("does not narrow catalog aliases or an update without its lockfile", (t) => {
  const f = fixture(t);
  f.put("pnpm-workspace.yaml", workspace.replace("sdk: 1.0.0", "sdk: &version 2.0.0"));
  upgradeMemory(f);
  f.commit();
  expectNames(f.select(), all);
  f.put("pnpm-workspace.yaml", workspace.replace("sdk: 1.0.0", "sdk: 3.0.0"));
  f.put("pnpm-lock.yaml", `${f.git("show", `${f.base}:pnpm-lock.yaml`)}\n`);
  f.commit();
  expectNames(f.select(), all);
});

test("adding an independent package and lockfile importer does not select other apps", (t) => {
  const f = fixture(t);
  f.put("apps/pi-refuseless/package.json", { name: "@buyong/pi-refuseless", version: "1.0.0", pi: {} });
  f.put("apps/pi-refuseless/index.js", "export {};\n");
  f.lock.importers["apps/pi-refuseless"] = {};
  f.put("pnpm-lock.yaml", f.lock);
  f.commit();
  expectNames(f.select(), ["@buyong/pi-refuseless"]);
});

test("shared archive scripts select callers and their dependents only", (t) => {
  const f = fixture(t);
  f.put("scripts/codex/check-package.mjs", "// changed shared archive checker\n");
  f.commit();
  const selected = f.select();
  expectNames(selected, [redact, redactApp, memory, review, bundle]);
  assert.equal(selected["check-auto-review-platforms"], "false");
});

test("root documentation has an empty matrix", (t) => {
  const f = fixture(t);
  f.put("README.md", "# Documentation\n");
  f.commit();
  expectNames(f.select(), []);
});

test("tracks deleted files and moves between packages", (t) => {
  const f = fixture(t);
  f.git("mv", "apps/pi-codex-memory/index.js", "apps/pi-ollama-cloud/moved.js");
  f.commit();
  expectNames(f.select(), [memory, bundle, ollama]);
});

test("common workflow changes keep full verification", (t) => {
  const f = fixture(t);
  f.put(".github/workflows/pi-packages.yml", "name: changed\n");
  f.commit();
  expectNames(f.select(), all);
});

test("branch pushes use the whole before-to-tip range", (t) => {
  const f = fixture(t);
  f.put("apps/pi-codex-memory/index.js", "export const changed = true;\n");
  f.commit();
  f.put("apps/pi-ollama-cloud/index.js", "export const changed = true;\n");
  f.commit();
  expectNames(f.select("push", { before: f.base }, "refs/heads/main"), [memory, bundle, ollama]);
});

test("manual and initial pushes retain full verification", (t) => {
  const f = fixture(t);
  expectNames(f.select("workflow_dispatch", {}), all);
  expectNames(f.select("push", { before: "0".repeat(40) }, "refs/heads/main"), all);
});

test("release tags select exactly the tagged package", (t) => {
  const f = fixture(t);
  const selected = f.select("push", {}, "refs/tags/pi-codex-v1.0.0");
  expectNames(selected, [bundle]);
  assert.equal(selected["is-release"], "true");
  assert.equal(selected["check-auto-review-platforms"], "true");
  assert.throws(() => f.select("push", {}, "refs/tags/pi-codex-v9.0.0"), /must match exactly one release target/);
});

test("global lockfile settings and unparseable lockfile graphs retain full verification", (t) => {
  const f = fixture(t);
  f.lock.settings.autoInstallPeers = false;
  f.put("pnpm-lock.yaml", f.lock);
  f.commit();
  expectNames(f.select(), all);
  f.lock.settings.autoInstallPeers = true;
  delete f.lock.packages["sdk@1.0.0"].resolution;
  f.put("pnpm-lock.yaml", f.lock);
  f.commit();
  expectNames(f.select(), all);
});

test("a PR merge checkout excludes unrelated changes already on its base", (t) => {
  const f = fixture(t);
  f.git("checkout", "-qb", "base-update");
  f.put("apps/pi-ollama-cloud/index.js", "export const onBase = true;\n");
  const updatedBase = f.commit();
  f.git("checkout", "-qb", "feature", f.base);
  f.put("apps/pi-codex-memory/index.js", "export const feature = true;\n");
  f.commit();
  f.git("-c", "user.name=CI", "-c", "user.email=ci@example.invalid", "-c", "commit.gpgsign=false",
    "merge", "--no-edit", "base-update");
  expectNames(f.select("pull_request", { pull_request: { base: { sha: updatedBase } } }), [memory, bundle]);
});

test("invalid comparison refs fail rather than silently selecting nothing", (t) => {
  const f = fixture(t);
  assert.throws(() => f.select("push", { before: "--invalid" }), /Invalid base commit/);
});
