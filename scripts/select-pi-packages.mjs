import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readReleaseTargets } from "./pi-apps.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const apps = readReleaseTargets();
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

// Turbo owns the workspace/dev/optional dependency graph and pnpm's resolved lockfile graph.
// Keep CI selection separate from readReleaseTargets' runtime-only release ordering.
function affectedNames(baseCommit, filters = ["--affected"]) {
  const output = execFileSync(process.execPath, [
    fileURLToPath(new URL("../node_modules/turbo/bin/turbo", import.meta.url)),
    "ls", "--output=json", ...filters,
  ], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, TURBO_SCM_BASE: baseCommit, TURBO_SCM_HEAD: "HEAD" },
  });
  return JSON.parse(output).packages.items.map(({ name }) => name);
}

// Only ordinary block catalogs can be narrowed through the lockfile. Other workspace
// settings (or YAML aliases that could connect catalogs to those settings) stay global.
function workspaceSettings(source) {
  if (/(?:^|[\s:[,{])[&*][\w-]+/m.test(source)) return source;
  let inCatalog = false;
  return source.split(/\r?\n/).filter((line) => {
    if (!line.trim() || line.trimStart().startsWith("#")) return false;
    if (/^\S/.test(line)) inCatalog = /^catalogs?:\s*(?:#.*)?$/.test(line);
    return !inCatalog;
  }).join("\n");
}

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const isRelease = process.env.GITHUB_EVENT_NAME === "push" && process.env.GITHUB_REF?.startsWith("refs/tags/");
let selectedApps;
let checkAutoReviewPlatforms;
let checkSelection = true;

if (isRelease) {
  const tag = process.env.GITHUB_REF.slice("refs/tags/".length);
  selectedApps = apps.filter((app) => tag === `${app.slug}-v${app.version}`);
  if (selectedApps.length !== 1) {
    throw new Error(`Release tag ${tag} must match exactly one release target and its package.json version.`);
  }
} else {
  const baseCommit = event.pull_request?.base?.sha ?? event.before;
  if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch" || !baseCommit || /^0+$/.test(baseCommit)) {
    selectedApps = apps;
  } else {
    if (!/^[0-9a-f]{40}$/i.test(baseCommit)) throw new Error("Invalid base commit in GitHub event.");
    // HEAD is GitHub's merge checkout on PRs, and the pushed tip on branch pushes.
    const changedFiles = git("diff", "--name-only", "--no-renames", "-z", baseCommit, "HEAD").split("\0").filter(Boolean);
    let hasGlobalChanges = changedFiles.some((path) =>
      /^(?:package\.json$|biome\.json$|turbo\.json$|\.npmrc$|scripts\/(?!codex\/)|\.github\/workflows\/pi-packages\.yml$)/.test(path),
    );
    if (changedFiles.includes("pnpm-workspace.yaml")) {
      hasGlobalChanges ||= !changedFiles.includes("pnpm-lock.yaml") ||
        workspaceSettings(git("show", `${baseCommit}:pnpm-workspace.yaml`)) !==
        workspaceSettings(git("show", "HEAD:pnpm-workspace.yaml"));
    }
    checkSelection = hasGlobalChanges || changedFiles.includes("pnpm-lock.yaml") || changedFiles.includes("pnpm-workspace.yaml");
    if (hasGlobalChanges) {
      selectedApps = apps;
    } else {
      const names = new Set(affectedNames(baseCommit));
      checkAutoReviewPlatforms = names.has("@buyong/pi-codex-auto-review");
      // Shared archive checks affect their callers, not unrelated source-distributed apps.
      if (changedFiles.some((path) => path.startsWith("scripts/codex/"))) {
        const consumers = apps.filter((app) => {
          const manifest = JSON.parse(readFileSync(new URL(`../${app.path}/package.json`, import.meta.url), "utf8"));
          return Object.values(manifest.scripts ?? {}).some((command) => command.includes("scripts/codex/"));
        });
        if (consumers.length) {
          for (const name of affectedNames(baseCommit, consumers.map((app) => `--filter=...${app.name}`))) names.add(name);
        }
      }
      selectedApps = apps.filter((app) => names.has(app.name));
    }
  }
}

// `pnpm release` pushes main and the release tag together. The tag's run checks that package at the same commit,
// including its platform checks, so the branch run leaves it out.
if (process.env.GITHUB_EVENT_NAME === "push" && !isRelease) {
  const tagsAtTip = new Set(git("tag", "--points-at", "HEAD").split("\n").filter(Boolean));
  const released = selectedApps.filter((app) => tagsAtTip.has(`${app.slug}-v${app.version}`));
  if (released.length) {
    selectedApps = selectedApps.filter((app) => !released.includes(app));
    if (released.some(({ slug }) => slug === "pi-codex-auto-review" || slug === "pi-codex")) checkAutoReviewPlatforms = false;
  }
}

checkAutoReviewPlatforms ??= selectedApps.some(({ slug }) =>
  slug === "pi-codex-auto-review" || (isRelease && slug === "pi-codex"),
);
const matrix = { include: selectedApps.map(({ slug, path, name }) => ({ slug, path, name })) };
appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\nhas-packages=${selectedApps.length > 0}\nis-release=${isRelease}\ncheck-auto-review-platforms=${checkAutoReviewPlatforms}\ncheck-selection=${checkSelection}\n`);
console.log(`${isRelease ? "Release" : "Checks"}: ${selectedApps.map((app) => app.name).join(", ") || "no affected packages"}`);
