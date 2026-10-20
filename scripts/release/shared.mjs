// Shared by `pnpm release` (interactive, for people) and `pnpm release:dry-run` (non-interactive, for coding agents).
// Both resolve the same target, version, configuration and push refspec, so the dry run previews the real release.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Config } from "release-it";
import semver from "semver";
import { readReleaseTargets } from "../pi-apps.mjs";
import { LANGUAGES, readChangelogFiles } from "./changelog.mjs";

export const root = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
export const guardPath = fileURLToPath(new URL("./prompts.mjs", import.meta.url));
export const RELEASE_BRANCH = "main";
export const RELEASE_UPSTREAM = "origin/main";
/** Hooks run from the app directory. */
const CHANGELOG_COMMAND = "node ../../scripts/release/changelog.mjs";
// Applied before Config.init() as well: snapshot expansion rewrites Git/npm options there.
const neutralModeOptions = { "only-version": false, "release-version": false, changelog: false, snapshot: false, preRelease: false };
export const interactiveOptions = { ...neutralModeOptions, ci: false, "dry-run": false };
export const dryRunOptions = { ...neutralModeOptions, ci: true, "dry-run": true };

// Piped stderr keeps an expected probe failure (a missing tag) off the terminal.
export const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** `git status --short` lines; the leading column is kept, so ` M` (unstaged) and `M ` (staged) stay distinct. */
export const statusLines = (...args) =>
  execFileSync("git", ["status", "--short", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();

/** The current branch's upstream, or undefined when it has none. */
export function upstreamBranch() {
  try {
    return git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
  } catch {
    return undefined;
  }
}

/** Every release target that the publish workflow can release, with its release-it configuration path. */
export function listTargets() {
  return readReleaseTargets().map(({ slug, path: appPath, name, workspaceDependencies, bundledDependencies }) => {
    const directory = path.join(root, appPath);
    return {
      slug,
      path: appPath,
      name,
      directory,
      workspaceDependencies,
      bundledDependencies,
      hasConfig: existsSync(path.join(directory, ".release-it.json")),
    };
  });
}

/**
 * `workspace:` runtime dependencies that npm installs from the registry: packing writes their current version, so it
 * must be on npm before this target ships. Bundled ones travel inside the archive instead.
 */
export function registryWorkspaceDependencies(target, targets) {
  return target.workspaceDependencies
    .filter((name) => !target.bundledDependencies.includes(name))
    .map((name) => {
      const dependency = targets.find((entry) => entry.name === name);
      if (!dependency) throw new Error(`${target.name} installs ${name} from npm, but ${name} is not a release target.`);
      return { name, version: readVersion(dependency) };
    });
}

/** true or false from `npm view`; undefined when npm could not answer (offline, registry error). */
export function isPublishedOnNpm(name, version) {
  try {
    return !!execFileSync("npm", ["view", `${name}@${version}`, "version", "--json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    }).trim();
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    return /E404|No match found for version/.test(output) ? false : undefined;
  }
}

export function requireConfiguredTargets(targets) {
  const missing = targets.filter((target) => !target.hasConfig).map((target) => target.path);
  if (missing.length) throw new Error(`Every release target needs a .release-it.json; missing: ${missing.join(", ")}`);
  if (!targets.length) throw new Error("No release target found under apps/ or packages/.");
}

export function findTarget(targets, wanted) {
  return targets.find((target) => target.slug === wanted || target.name === wanted || target.path === wanted);
}

export const readVersion = (target) => JSON.parse(readFileSync(path.join(target.directory, "package.json"), "utf8")).version;
/** `{ en, ko }` texts of CHANGELOG.md and CHANGELOG.ko.md; a missing file reads as undefined. */
export const readChangelogs = (target) => readChangelogFiles(target.directory);
export const tagNameFor = (target, version) => `${target.slug}-v${version}`;

/** Menu order of the interactive picker; the dry run accepts the same increment names. */
export function versionChoices(currentVersion) {
  const increments = [
    ["patch"],
    ["minor"],
    ["prepatch", "alpha"],
    ["preminor", "beta"],
    ["prerelease", semver.prerelease(currentVersion)?.[0] || "rc"],
    ["major"],
    ["premajor", "alpha"],
  ];
  return increments
    .map(([increment, identifier]) => ({ increment, version: semver.inc(currentVersion, increment, String(identifier || "")) }))
    .filter((choice) => choice.version && semver.gt(choice.version, currentVersion));
}

/** An exact semver above the current version, or one of the menu increments. */
export function resolveVersion(currentVersion, requested) {
  const exact = semver.valid(requested);
  if (exact) {
    if (!semver.gt(exact, currentVersion)) throw new Error(`${exact} must be greater than ${currentVersion}.`);
    return exact;
  }
  const choice = versionChoices(currentVersion).find((entry) => entry.increment === requested);
  if (!choice) {
    const names = versionChoices(currentVersion).map((entry) => entry.increment).join(", ");
    throw new Error(`Use an exact semver greater than ${currentVersion} or one of: ${names}.`);
  }
  return choice.version;
}

/** Same rule as the publish workflow: prereleases go to their identifier (or `next` when numeric), others to `latest`. */
export function distTag(version) {
  const identifier = semver.prerelease(version)?.[0];
  if (identifier === undefined) return "latest";
  return typeof identifier === "number" ? "next" : String(identifier);
}

/** Loads the app's `.release-it.json` from its directory; call after `process.chdir(target.directory)`. */
export async function loadTargetOptions(modeOptions) {
  const config = new Config({ config: true, ...modeOptions });
  await config.init();
  return config.getContext();
}

const castArray = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/** Problems that would make the release diverge from the publish workflow or the confirmation flow. */
export function configProblems(options, target) {
  const problems = [];
  const { git: gitOptions, npm, hooks = {} } = options;
  if (!gitOptions?.commit || !gitOptions.tag || !gitOptions.push) problems.push("Enable git commit, tag and push.");
  if (gitOptions?.requireBranch !== RELEASE_BRANCH || !gitOptions.requireUpstream) {
    problems.push(`Keep git.requireBranch "${RELEASE_BRANCH}" and git.requireUpstream on.`);
  }
  if (gitOptions?.tagName !== `${target.slug}-v\${version}` || gitOptions.tagMatch !== `${target.slug}-v[0-9]*`) {
    problems.push(`The publish workflow selects tags named ${target.slug}-v<version>; keep that tagName and tagMatch.`);
  }
  if (!npm || npm.ignoreVersion) problems.push("The version is read from package.json; keep the npm plugin and its version bump on.");
  if (npm?.publish !== false || options.github?.release || options.gitlab?.release) {
    problems.push("Publishing belongs to .github/workflows/pi-packages.yml; keep npm.publish and hosted releases off.");
  }
  const versionArgs = castArray(npm?.versionArgs);
  if (!versionArgs.includes("--ignore-scripts") || !versionArgs.includes("--workspaces-update=false")) {
    problems.push("Keep npm.versionArgs --ignore-scripts and --workspaces-update=false so the bump writes only this app.");
  }
  if (!castArray(hooks["before:init"]).includes(`${CHANGELOG_COMMAND} check`)) {
    problems.push(`Run "${CHANGELOG_COMMAND} check" in hooks.before:init.`);
  }
  if (!castArray(hooks["after:bump"]).includes(`${CHANGELOG_COMMAND} stamp \${version}`)) {
    problems.push(`Run "${CHANGELOG_COMMAND} stamp \${version}" in hooks.after:bump.`);
  }
  return problems;
}

/** The release commit stages tracked files only (`git add . --update`), and the root lockfile owns resolution. */
export function untrackedReleaseInputs(target) {
  const changelogs = LANGUAGES.map((language) => path.join(target.path, language.file));
  const inputs = [path.join(target.path, "package.json"), ...changelogs, "pnpm-lock.yaml"];
  return inputs.filter((file) => {
    try {
      git("ls-files", "--error-unmatch", "--", file);
      return false;
    } catch (error) {
      if (error.status !== 1) throw error;
      return true;
    }
  });
}

/** Pushes only `main` and the selected tag, never other reachable tags. */
export const pushArgs = (tagName) => [
  "--atomic",
  "--no-follow-tags",
  "origin",
  `HEAD:refs/heads/${RELEASE_BRANCH}`,
  `refs/tags/${tagName}:refs/tags/${tagName}`,
];

/** Final release-it options. The configuration is passed once with `config: false`, then only the mode controls change. */
export function releaseOptions(options, { modeOptions, target, currentVersion, selectedVersion, isDryRun }) {
  return {
    ...options,
    config: false,
    extends: false,
    ...modeOptions,
    increment: selectedVersion,
    git: {
      ...options.git,
      // The wrapper checks the working state itself. Off, release-it installs no exit/SIGINT handlers that reset
      // the commit and delete the tag after a stop, so interrupted work stays for inspection.
      requireCleanWorkingDir: false,
      // The dry run reports branch and upstream problems as checks and still previews the commands.
      ...(isDryRun ? { requireBranch: false, requireUpstream: false } : {}),
      pushRepo: "",
      pushArgs: pushArgs(tagNameFor(target, selectedVersion)),
    },
    plugins: { [guardPath]: { currentVersion, selectedVersion, isDryRun }, ...options.plugins },
  };
}

export function readLocalTag(tagName) {
  const ref = `refs/tags/${tagName}`;
  try {
    // Only --quiet reports a missing ref as status 1; without it Git exits 128.
    git("show-ref", "--verify", "--quiet", "--", ref);
  } catch (error) {
    if (error.status !== 1) throw error;
    return undefined;
  }
  return git("show-ref", "--verify", "--", ref);
}
