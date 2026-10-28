#!/usr/bin/env node
// Interactive release for people: choose one app, review its changelog draft, choose its version, then confirm commit,
// tag and push one at a time.
//
//   pnpm release
//
// After the app is chosen, `claude -p` drafts the CHANGELOG.md / CHANGELOG.ko.md entries the unreleased sections still
// miss (see changelog-draft.mjs). When it finds no user-visible change and both sections are empty, the draft is the
// common "Other bug fixes" entry. The draft is written only after a confirmation and then rides in the release commit.
//
// Nothing is published from here. Pushing the `<app folder>-v<version>` tag triggers .github/workflows/pi-packages.yml.
// Each confirmation is `(Y/n)`: Enter approves it, push included. Declining or cancelling stops the whole flow and
// leaves what was done in place (no automatic rollback); the state report at the end says exactly what remains.
// Coding agents use `pnpm release:dry-run` instead; this command requires a terminal.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { confirm, input, select } from "@inquirer/prompts";
import release from "release-it";
import semver from "semver";
import { changelogProblems, checkChangelogs, LANGUAGES, renderSections } from "./changelog.mjs";
import {
  applyDraft,
  collectDraftInputs,
  DRAFT_EFFORT,
  DRAFT_MODEL,
  draftChangelog,
  draftModeFor,
  FALLBACK_DRAFT,
  isEmptyDraft,
  needsFallbackDraft,
} from "./changelog-draft.mjs";
import { InquirerPrompt, ReleaseStopped, requireAnswer } from "./prompts.mjs";
import {
  configProblems,
  git,
  interactiveOptions,
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
  requireConfiguredTargets,
  root,
  statusLines,
  tagNameFor,
  untrackedReleaseInputs,
  upstreamBranch,
  versionChoices,
} from "./shared.mjs";

const prompt = new InquirerPrompt();
let headBefore;
let target;
let hasReportedReleaseError = false;

function chooseTarget(targets) {
  return requireAnswer(
    select({
      message: "Select the app to release:",
      choices: targets.map((entry) => ({ value: entry, name: `${entry.name} (${readVersion(entry)})`, description: entry.path })),
    }),
    "app",
  );
}

async function chooseVersion(currentVersion) {
  const choices = versionChoices(currentVersion).map(({ increment, version }) => ({
    value: version,
    name: `${increment}: ${currentVersion} → ${version}`,
  }));
  const selected = await requireAnswer(
    select({
      message: `Select version (current: ${currentVersion}):`,
      choices: [...choices, { value: "custom", name: "Enter an exact version" }],
    }),
    "version",
  );
  if (selected !== "custom") return selected;
  const entered = await requireAnswer(
    input({
      message: `Next version (current: ${currentVersion}):`,
      validate: (value) =>
        !semver.valid(value) || !semver.gt(value, currentVersion) ? `Enter a valid semver greater than ${currentVersion}.` : true,
    }),
    "version",
  );
  return semver.valid(entered);
}

/** Ctrl+C outside a prompt arrives as SIGINT; it cancels the task and stops the release instead of killing the process. */
async function whileCancellable(stage, task) {
  const controller = new AbortController();
  const onInterrupt = () => {
    if (!controller.signal.aborted) controller.abort(new ReleaseStopped(`Cancelled at ${stage}.`));
  };
  process.on("SIGINT", onInterrupt);
  try {
    return await task(controller.signal);
  } finally {
    // pnpm forwards a second SIGINT right after the terminal's. Once cancelled, keep ignoring it so the process
    // lives long enough to stop the child and print the state report.
    if (!controller.signal.aborted) process.removeListener("SIGINT", onInterrupt);
  }
}

/**
 * Drafts the entries the unreleased sections miss and writes them after a confirmation. An empty draft for empty
 * sections becomes FALLBACK_DRAFT. A failed, otherwise empty, unpaired or declined draft leaves both files as they are;
 * the changelog check that follows decides whether the release goes on.
 */
async function offerChangelogDraft() {
  const changelogs = readChangelogs(target);
  const inputs = collectDraftInputs(target);
  const mode = draftModeFor(changelogs);
  const since = inputs.sinceTag ?? "the first commit";
  if (!inputs.commitCount && mode === "append") {
    console.info(`No commits in ${target.path} since ${since}; no changelog draft.`);
    return;
  }
  console.info(
    `Drafting changelog entries with claude (${DRAFT_MODEL}, ${DRAFT_EFFORT} effort) from ${inputs.commitCount} commit(s) since ${since}. Ctrl+C cancels.`,
  );
  let drafted;
  try {
    drafted = await whileCancellable("changelog draft", (signal) => draftChangelog({ target, inputs, changelogs, signal }));
  } catch (error) {
    if (error instanceof ReleaseStopped) throw error;
    console.warn(`The changelog draft failed: ${error.message}\nThe changelog files stay as they are.`);
    return;
  }
  if (isEmptyDraft(drafted.draft)) {
    if (!needsFallbackDraft(changelogs, drafted.mode)) {
      console.info("claude found no user-visible change missing from the changelog.");
      return;
    }
    console.info("claude found no user-visible change; the draft is the common entry.");
    drafted = { ...drafted, draft: FALLBACK_DRAFT };
  }
  const action = drafted.mode === "convert" ? "replaces the current unreleased entries" : "is added to the unreleased section";
  for (const language of LANGUAGES) {
    const lines = renderSections(drafted.draft[language.code], language.code);
    console.info(`\n${target.path}/${language.file} (${action}):\n\n${lines.join("\n")}`);
  }
  const cost = typeof drafted.costUSD === "number" ? `, $${drafted.costUSD.toFixed(4)}` : "";
  console.info(`\n(drafted in ${Math.round(drafted.durationMs / 1000)}s${cost})`);
  const next = applyDraft(changelogs, drafted.draft, drafted.mode);
  const problems = changelogProblems(next);
  if (problems.length) {
    console.warn(`The draft does not leave a releasable pair, so it was not written: ${problems.join("; ")}`);
    return;
  }
  const files = LANGUAGES.map((language) => language.file).join(" and ");
  const isApproved = await requireAnswer(confirm({ message: `Write this draft to ${files}?`, default: true }), "changelog");
  if (!isApproved) {
    console.info("Draft discarded; the changelog files stay as they are.");
    return;
  }
  for (const language of LANGUAGES) writeFileSync(path.join(target.directory, language.file), next[language.code]);
}

function reportState() {
  if (!headBefore) return;
  try {
    console.info(`HEAD before: ${headBefore}\nHEAD now: ${git("rev-parse", "HEAD")}`);
    // Untracked files never enter the release commit, so only tracked changes are reported.
    console.info(`Remaining index/worktree changes:\n${statusLines("--untracked-files=no") || "(clean)"}`);
    if (target) console.info(`Version on disk (${target.path}): ${readVersion(target)}`);
    if (prompt.tagName) console.info(`Local tag ${prompt.tagName}: ${readLocalTag(prompt.tagName) ?? "(not present locally)"}`);
    const pushState = prompt.completed.includes("push")
      ? "push command completed"
      : prompt.attempted.includes("push")
        ? "push attempted; remote state requires inspection"
        : "push not attempted";
    console.info(pushState);
  } catch (error) {
    console.warn(`Could not fully inspect remaining state: ${error.message}`);
  }
}

try {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("An interactive terminal is required; no release work was started. Coding agents use `pnpm release:dry-run`.");
  }
  if (process.argv.length > 2) {
    throw new Error("Run `pnpm release` without arguments; choose the app and version in the prompt.");
  }
  process.chdir(root);
  // The commit takes the whole index, so a change staged anywhere would ride along.
  if (statusLines("--untracked-files=no")) {
    throw new Error("Tracked files and the index must be clean across the repository before a release.");
  }
  if (git("rev-parse", "--abbrev-ref", "HEAD") !== RELEASE_BRANCH) throw new Error(`Releases run on ${RELEASE_BRANCH}.`);
  if (upstreamBranch() !== RELEASE_UPSTREAM) {
    throw new Error(`Releases must track ${RELEASE_UPSTREAM} in the pi-packages repository.`);
  }
  headBefore = git("rev-parse", "HEAD");
  const targets = listTargets();
  requireConfiguredTargets(targets);
  target = await chooseTarget(targets);
  process.chdir(target.directory);
  const options = await loadTargetOptions(interactiveOptions);
  const problems = configProblems(options, target);
  if (problems.length) throw new Error(`${target.path}/.release-it.json: ${problems.join(" ")}`);
  const untracked = untrackedReleaseInputs(target);
  if (untracked.length) throw new Error(`Track before releasing; the release commit stages tracked files only: ${untracked.join(", ")}`);
  // With --update, untracked files stay out of the release commit; --all would sweep them in.
  if (options.git.addUntrackedFiles && git("ls-files", "--others", "--exclude-standard", "--", target.path)) {
    throw new Error("Untracked files would enter the release commit; handle them before releasing.");
  }
  for (const { name, version } of registryWorkspaceDependencies(target, targets)) {
    const isPublished = isPublishedOnNpm(name, version);
    if (!isPublished) {
      throw new Error(
        isPublished === false
          ? `Release ${name} ${version} first: ${target.name} installs it from npm.`
          : `Could not confirm ${name}@${version} on npm; check the connection and retry.`,
      );
    }
  }
  await offerChangelogDraft();
  // before:init runs the same check; failing here avoids asking for a version that cannot be released.
  checkChangelogs(readChangelogs(target));
  const currentVersion = readVersion(target);
  if (!semver.valid(currentVersion)) throw new Error(`${target.path}/package.json needs a valid version.`);
  const selectedVersion = await chooseVersion(currentVersion);
  const tagName = tagNameFor(target, selectedVersion);
  if (readLocalTag(tagName)) throw new Error(`Tag ${tagName} already exists locally.`);
  try {
    await release(
      releaseOptions(options, { modeOptions: interactiveOptions, target, currentVersion, selectedVersion, isDryRun: false }),
      { prompt },
    );
  } catch (error) {
    // release-it 21.0.1 logs an API error (a stop included) before rethrowing it.
    hasReportedReleaseError = true;
    throw error;
  }
  console.info(`Released ${target.name} ${selectedVersion}; the publish workflow takes it from the pushed tag ${tagName}.`);
} catch (error) {
  if (!hasReportedReleaseError) {
    if (error instanceof ReleaseStopped) console.info(error.message);
    else console.error(error.message);
  }
  process.exitCode = 1;
} finally {
  process.chdir(root);
  reportState();
}
