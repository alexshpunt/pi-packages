import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readReleaseTargets } from "./pi-apps.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const apps = readReleaseTargets();

/** Adds every target that installs or bundles a selected one through `workspace:`, so a component change rechecks it. */
function withDependents(selected) {
  const names = new Set(selected.map((app) => app.name));
  for (let isGrowing = true; isGrowing; ) {
    isGrowing = false;
    for (const app of apps) {
      if (!names.has(app.name) && app.workspaceDependencies.some((name) => names.has(name))) {
        names.add(app.name);
        isGrowing = true;
      }
    }
  }
  return apps.filter((app) => names.has(app.name));
}

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const isRelease = process.env.GITHUB_EVENT_NAME === "push" && process.env.GITHUB_REF?.startsWith("refs/tags/");
let selectedApps;

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
    const changedFiles = execFileSync("git", ["diff", "--name-only", "-z", baseCommit, "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).split("\0").filter(Boolean);
    const hasSharedChanges = changedFiles.some((path) =>
      /^(?:package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|biome\.json$|turbo\.json$|\.npmrc$|packages\/|scripts\/|\.github\/workflows\/pi-packages\.yml$)/.test(path),
    );
    selectedApps = hasSharedChanges
      ? apps
      : withDependents(apps.filter((app) => changedFiles.some((path) => path.startsWith(`${app.path}/`))));
  }
}

const matrix = { include: selectedApps.map(({ slug, path, name }) => ({ slug, path, name })) };
appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\nhas-packages=${selectedApps.length > 0}\nis-release=${isRelease}\n`);
console.log(`${isRelease ? "Release" : "Checks"}: ${selectedApps.map((app) => app.name).join(", ") || "no affected packages"}`);
