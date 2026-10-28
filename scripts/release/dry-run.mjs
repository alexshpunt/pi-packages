#!/usr/bin/env node
// Non-interactive release preview for coding agents. Writes nothing: no file, index, commit, tag, fetch or push.
//
//   pnpm release:dry-run --list
//   pnpm release:dry-run --app <app folder | package name> --version <exact semver | patch | minor | major | prepatch | preminor | premajor | prerelease> [--checks]
//
// Prints one JSON document on stdout. Exit code 0: ready for `pnpm release`; 1: blocked (see `blockers`); 2: bad input.
// It runs release-it with --dry-run in CI mode, so every resolved command is listed with whether it would run.
// `--checks` also runs the app's before:init hooks (changelog check, lint, typecheck, unit tests), which the real
// release runs before any write. Remote tag and npm lookups are read-only network requests; failures become warnings.
// It never calls claude: `plan.changelogDraft` says whether `pnpm release` will draft changelog entries and from what.
// Missing or older-format unreleased entries are a warning when that draft can fill them, and a blocker otherwise.

import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import release from "release-it";
import semver from "semver";
import { changelogProblems, inspectChangelogs, localDate, stampChangelogs } from "./changelog.mjs";
import { collectDraftInputs, DRAFT_EFFORT, DRAFT_MODEL, draftModeFor, needsFallbackDraft } from "./changelog-draft.mjs";
import { NoPrompt } from "./prompts.mjs";
import {
  configProblems,
  distTag,
  dryRunOptions,
  findTarget,
  git,
  isPublishedOnNpm,
  listTargets,
  loadTargetOptions,
  RELEASE_BRANCH,
  RELEASE_UPSTREAM,
  readChangelogs,
  readLocalTag,
  readVersion,
  registryWorkspaceDependencies,
  releaseOptions,
  resolveVersion,
  root,
  statusLines,
  tagNameFor,
  untrackedReleaseInputs,
  upstreamBranch,
} from "./shared.mjs";

const execFileAsync = promisify(execFile);
const NETWORK_TIMEOUT_MS = 20_000;
const HOOK_OUTPUT_TAIL_CHARS = 4_000;

const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

function usageError(message, extra = {}) {
  print({ mode: "dry-run", ready: false, error: message, ...extra });
  process.exitCode = 2;
}

/** Collects release-it output instead of printing it, so stdout stays a single JSON document. */
function capturingLogger() {
  const commands = [];
  const messages = [];
  const previews = {};
  const text = (args) => args.filter((arg) => typeof arg === "string").join(" ");
  const logger = {
    log: (...args) => messages.push({ level: "log", text: text(args) }),
    info: (...args) => messages.push({ level: "info", text: text(args) }),
    warn: (...args) => messages.push({ level: "warn", text: text(args) }),
    error: (...args) => messages.push({ level: "error", text: text(args) }),
    verbose: () => {},
    obtrusive: (...args) => logger.log(...args),
    preview: ({ title, text: body }) => {
      previews[title] = body ?? "";
    },
    exec: (...args) => {
      const last = args.at(-1);
      const meta = last && typeof last === "object" && !Array.isArray(last) ? last : {};
      const command = args
        .filter((arg) => typeof arg === "string" || Array.isArray(arg))
        .map((arg) => (Array.isArray(arg) ? arg.join(" ") : arg))
        .join(" ");
      // release-it marks a write skipped by --dry-run with `isDryRun`; every other command ran because it only reads.
      commands.push({ command, isExecuted: meta.isDryRun == null });
    },
  };
  return { logger, commands, messages, previews };
}

async function lookupRemoteTag(tagName) {
  try {
    const { stdout } = await execFileAsync("git", ["ls-remote", "--tags", "origin", `refs/tags/${tagName}`], {
      cwd: root,
      timeout: NETWORK_TIMEOUT_MS,
    });
    return stdout.trim()
      ? { status: "fail", detail: `origin already has ${tagName}.` }
      : { status: "pass", detail: `origin has no ${tagName}.` };
  } catch (error) {
    return { status: "warn", detail: `Could not query origin: ${error.message.split("\n")[0]}` };
  }
}

async function lookupRemoteMain() {
  try {
    const { stdout } = await execFileAsync("git", ["ls-remote", "origin", `refs/heads/${RELEASE_BRANCH}`], {
      cwd: root,
      timeout: NETWORK_TIMEOUT_MS,
    });
    const remoteSHA = stdout.split(/\s/)[0];
    if (!remoteSHA) return { status: "fail", detail: `origin has no ${RELEASE_BRANCH}.` };
    try {
      git("merge-base", "--is-ancestor", remoteSHA, "HEAD");
      return { status: "pass", detail: `origin/${RELEASE_BRANCH} (${remoteSHA.slice(0, 7)}) is contained in HEAD; the push fast-forwards.` };
    } catch {
      return { status: "fail", detail: `origin/${RELEASE_BRANCH} (${remoteSHA.slice(0, 7)}) has commits not in HEAD; pull before releasing.` };
    }
  } catch (error) {
    return { status: "warn", detail: `Could not query origin: ${error.message.split("\n")[0]}` };
  }
}

async function lookupNpmVersion(name, version) {
  try {
    const { stdout } = await execFileAsync("npm", ["view", `${name}@${version}`, "version", "--json"], {
      cwd: root,
      timeout: NETWORK_TIMEOUT_MS,
    });
    return stdout.trim()
      ? { status: "fail", detail: `${name}@${version} is already on npm.` }
      : { status: "pass", detail: `${name}@${version} is not on npm.` };
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    if (/No match found for version/.test(output)) return { status: "pass", detail: `${name}@${version} is not on npm.` };
    if (/E404/.test(output)) {
      return { status: "warn", detail: `${name} is not on npm yet; set up its npm Trusted Publisher before pushing the first tag.` };
    }
    return { status: "warn", detail: `Could not query npm: ${(output || error.message).split("\n")[0]}` };
  }
}

async function lookupClaude() {
  try {
    const { stdout } = await execFileAsync("claude", ["--version"], { timeout: NETWORK_TIMEOUT_MS });
    return { status: "pass", detail: `claude ${stdout.trim()} is on PATH.` };
  } catch (error) {
    return { status: "fail", detail: `The claude CLI is not usable: ${error.message.split("\n")[0]}` };
  }
}

/** `skips` are hooks the draft makes moot, such as the changelog check before entries exist. */
async function runCheckHooks(hooks, cwd, skips = []) {
  const results = [];
  for (const command of hooks) {
    if (skips.includes(command)) {
      results.push({ command, status: "skipped", output: "pnpm release drafts the changelog entries before this check runs." });
      continue;
    }
    try {
      const { stdout, stderr } = await execFileAsync("sh", ["-c", command], { cwd, maxBuffer: 64 * 1024 * 1024 });
      results.push({ command, status: "pass", output: `${stdout}${stderr}`.slice(-HOOK_OUTPUT_TAIL_CHARS) });
    } catch (error) {
      results.push({ command, status: "fail", output: `${error.stdout ?? ""}${error.stderr ?? ""}`.slice(-HOOK_OUTPUT_TAIL_CHARS) });
      break;
    }
  }
  return results;
}

async function main() {
  let values;
  try {
    const args = process.argv.slice(2);
    ({ values } = parseArgs({
      args: args[0] === "--" ? args.slice(1) : args,
      options: { app: { type: "string" }, version: { type: "string" }, list: { type: "boolean" }, checks: { type: "boolean" } },
      strict: true,
    }));
  } catch (error) {
    return usageError(error.message);
  }
  process.chdir(root);
  const targets = listTargets();

  if (values.list) {
    print({
      mode: "list",
      targets: targets.map((entry) => {
        const changelogs = readChangelogs(entry);
        const inspected = inspectChangelogs(changelogs);
        const hasEntries = [inspected.en, inspected.ko].some((item) => item.legacy.length || item.sections.length);
        return {
          slug: entry.slug,
          name: entry.name,
          path: entry.path,
          version: readVersion(entry),
          hasConfig: entry.hasConfig,
          hasUnreleasedEntries: hasEntries,
          changelogProblems: changelogProblems(changelogs),
        };
      }),
    });
    return;
  }

  const target = values.app && findTarget(targets, values.app);
  if (!target) {
    return usageError(values.app ? `Unknown app: ${values.app}` : "Pass --app <app folder | package name>.", {
      apps: targets.map((entry) => entry.slug),
    });
  }
  if (!target.hasConfig) return usageError(`${target.path} has no .release-it.json.`);
  const currentVersion = readVersion(target);
  if (!semver.valid(currentVersion)) return usageError(`${target.path}/package.json needs a valid version.`);
  if (!values.version) return usageError("Pass --version <exact semver | increment>.", { currentVersion });
  let selectedVersion;
  try {
    selectedVersion = resolveVersion(currentVersion, values.version);
  } catch (error) {
    return usageError(error.message, { currentVersion });
  }
  const tagName = tagNameFor(target, selectedVersion);
  const checks = [];
  const check = (id, status, detail) => checks.push({ id, status, detail });

  const dirty = statusLines("--untracked-files=no");
  check("clean-index", dirty ? "fail" : "pass", dirty ? `Commit or restore tracked changes first:\n${dirty}` : "Tracked files and the index are clean.");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  check("branch", branch === RELEASE_BRANCH ? "pass" : "fail", `On ${branch}; releases run on ${RELEASE_BRANCH}.`);
  const upstream = upstreamBranch();
  check("upstream", upstream === RELEASE_UPSTREAM ? "pass" : "fail", `Upstream: ${upstream ?? "(none)"}; releases track ${RELEASE_UPSTREAM}.`);
  const untracked = untrackedReleaseInputs(target);
  check("tracked-inputs", untracked.length ? "fail" : "pass", untracked.length ? `Untracked: ${untracked.join(", ")}` : "package.json, CHANGELOG.md, CHANGELOG.ko.md and pnpm-lock.yaml are tracked.");

  process.chdir(target.directory);
  let options;
  try {
    options = await loadTargetOptions(dryRunOptions);
  } catch (error) {
    process.chdir(root);
    return usageError(`Invalid ${target.path}/.release-it.json: ${error.message}`);
  }
  const problems = configProblems(options, target);
  check("config", problems.length ? "fail" : "pass", problems.length ? problems.join(" ") : `${target.path}/.release-it.json matches the release contract.`);
  if (options.git?.addUntrackedFiles && git("ls-files", "--others", "--exclude-standard", "--", target.path)) {
    check("untracked-files", "fail", "git.addUntrackedFiles would sweep untracked files into the release commit.");
  }

  // pnpm release first lets claude draft what the unreleased sections miss, so missing or older-format entries are
  // only a blocker when no draft will run (no new commits and nothing to convert) or claude is unusable.
  const changelogs = readChangelogs(target);
  const draftInputs = collectDraftInputs(target);
  const draftMode = draftModeFor(changelogs);
  const willDraft = draftInputs.commitCount > 0 || draftMode === "convert";
  const changelogIssues = changelogProblems(changelogs);
  const claude = willDraft ? await lookupClaude() : undefined;
  if (claude) check("claude", claude.status === "pass" ? "pass" : changelogIssues.length ? "fail" : "warn", claude.detail);
  let changelog;
  let isChangelogDrafted = false;
  if (!changelogIssues.length) {
    try {
      const stamped = stampChangelogs(changelogs, selectedVersion, localDate());
      changelog = {
        headings: { en: stamped.en.heading, ko: stamped.ko.heading },
        notes: { en: stamped.en.notes, ko: stamped.ko.notes },
        releaseNotes: stamped.releaseNotes,
      };
      check("changelog", "pass", `after:bump writes "${stamped.en.heading}" to both files; the publish workflow finds the notes.`);
    } catch (error) {
      check("changelog", "fail", error.message);
    }
  } else if (willDraft && changelogs.ko !== undefined) {
    isChangelogDrafted = true;
    const source = `${draftInputs.commitCount} commit(s) since ${draftInputs.sinceTag ?? "the first commit"}`;
    const fallback = needsFallbackDraft(changelogs, draftMode) ? ` If claude finds no user-visible change, the draft is "### Fixed: Other bug fixes".` : "";
    check("changelog", "warn", `${changelogIssues.join("; ")}. pnpm release drafts the entries with claude from ${source} and writes them only after a confirmation.${fallback}`);
  } else {
    check("changelog", "fail", `${changelogIssues.join("; ")}. No draft would run: there are no commits since ${draftInputs.sinceTag ?? "the first commit"}.`);
  }
  const localTag = readLocalTag(tagName);
  check("local-tag", localTag ? "fail" : "pass", localTag ? `${tagName} already exists locally.` : `${tagName} is free locally.`);
  const [remoteMain, remoteTag, npmVersion] = await Promise.all([
    lookupRemoteMain(),
    lookupRemoteTag(tagName),
    lookupNpmVersion(target.name, selectedVersion),
  ]);
  check("remote-main", remoteMain.status, remoteMain.detail);
  check("remote-tag", remoteTag.status, remoteTag.detail);
  check("npm-version", npmVersion.status, npmVersion.detail);
  // Packing writes each workspace dependency's current version; npm then installs it from the registry.
  for (const { name, version } of registryWorkspaceDependencies(target, targets)) {
    const isPublished = isPublishedOnNpm(name, version);
    check(
      "workspace-dependency",
      isPublished ? "pass" : isPublished === false ? "fail" : "warn",
      isPublished
        ? `${name}@${version} is on npm.`
        : isPublished === false
          ? `${name}@${version} is not on npm; release it before ${target.name}.`
          : `Could not confirm ${name}@${version} on npm.`,
    );
  }

  const hooks = { "before:init": [options.hooks?.["before:init"] ?? []].flat(), "after:bump": [options.hooks?.["after:bump"] ?? []].flat() };
  let hookResults;
  if (values.checks) {
    const changelogCheck = hooks["before:init"].filter((command) => command.includes("changelog.mjs check"));
    hookResults = await runCheckHooks(hooks["before:init"], target.directory, isChangelogDrafted ? changelogCheck : []);
    const failed = hookResults.find((result) => result.status === "fail");
    check("before-init-hooks", failed ? "fail" : "pass", failed ? `Failed: ${failed.command}` : "All before:init hooks passed.");
  }

  const capture = capturingLogger();
  let releaseItError;
  if (!problems.length) {
    try {
      await release(
        releaseOptions(options, { modeOptions: dryRunOptions, target, currentVersion, selectedVersion, isDryRun: true }),
        { log: capture.logger, prompt: new NoPrompt() },
      );
    } catch (error) {
      releaseItError = error.message;
    }
    check("release-it", releaseItError ? "fail" : "pass", releaseItError ?? "release-it resolved the release in dry-run mode.");
  }
  process.chdir(root);

  const findCommand = (prefix) => capture.commands.find((entry) => entry.command.startsWith(prefix))?.command;
  const blockers = checks.filter((entry) => entry.status === "fail").map((entry) => `${entry.id}: ${entry.detail}`);
  const ready = blockers.length === 0;
  print({
    mode: "dry-run",
    ready,
    target: { slug: target.slug, name: target.name, path: target.path },
    version: { current: currentVersion, next: selectedVersion, distTag: distTag(selectedVersion) },
    tag: tagName,
    changelog,
    plan: {
      changelogDraft: {
        willRun: willDraft,
        mode: draftMode,
        model: DRAFT_MODEL,
        effort: DRAFT_EFFORT,
        sinceTag: draftInputs.sinceTag ?? null,
        commitCount: draftInputs.commitCount,
      },
      hooks,
      commit: findCommand("git commit"),
      tag: findCommand("git tag"),
      push: findCommand("git push"),
    },
    checks,
    blockers,
    warnings: checks.filter((entry) => entry.status === "warn").map((entry) => `${entry.id}: ${entry.detail}`),
    ...(hookResults ? { hookResults } : {}),
    // previews.changelog lists the app's commits since its last tag, a source for CHANGELOG entries.
    releaseIt: { commands: capture.commands, messages: capture.messages, previews: capture.previews },
    next: ready
      ? `A person runs \`pnpm release\` in a terminal, selects ${target.name}${willDraft ? ", reviews the claude changelog draft" : ""}, chooses ${selectedVersion}, then confirms commit, tag and push.`
      : "Resolve the blockers, then run the dry run again.",
  });
  process.exitCode = ready ? 0 : 1;
}

try {
  await main();
} catch (error) {
  process.chdir(root);
  print({ mode: "dry-run", ready: false, error: error.message });
  process.exitCode = 2;
}
