#!/usr/bin/env node
// Interactive release: choose the version, then confirm commit, tag and push one at a time.
//
//   npm run release
//
// Nothing is published from here. Pushing the `v*` tag triggers
// .github/workflows/publish.yml, which publishes to npm and creates the GitHub Release.
// Each confirmation is `(Y/n)`: Enter approves it, push included. Declining or cancelling
// stops the whole flow and leaves what was done in place (no automatic rollback); the
// state report at the end says exactly what remains.

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { input, select } from "@inquirer/prompts";
import release, { Config } from "release-it";
import semver from "semver";
import { InquirerPrompt, ReleaseStopped, requireAnswer } from "./release-prompts.mjs";

const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const guardPath = fileURLToPath(new URL("./release-prompts.mjs", import.meta.url));
const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const prompt = new InquirerPrompt();
// Applied before Config.init() as well: snapshot expansion rewrites Git/npm options there.
const interactiveOptions = {
	ci: false,
	"only-version": false,
	"release-version": false,
	changelog: false,
	"dry-run": false,
	snapshot: false,
	preRelease: false,
};
const readPackageVersion = () => JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
// Piped stderr keeps an expected probe failure (a missing tag) off the terminal.
const git = (...args) =>
	execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// The bump writes package.json and package-lock.json and the after:bump hook writes
// CHANGELOG.md. `git add . --update` stages tracked files only, so each must be tracked.
const releaseInputs = ["package.json", "package-lock.json", "CHANGELOG.md"];
let headBefore;
let hasReportedReleaseError = false;

function checkReleaseInputsTracked() {
	for (const file of releaseInputs) {
		try {
			git("ls-files", "--error-unmatch", "--", file);
		} catch (error) {
			if (error.status !== 1) throw error;
			throw new Error(`${file} must be tracked; the release commit stages tracked files only.`);
		}
	}
}

async function chooseVersion(currentVersion) {
	const increments = [
		["patch"],
		["minor"],
		["prepatch", "alpha"],
		["preminor", "beta"],
		["prerelease", semver.prerelease(currentVersion)?.[0] || "rc"],
		["major"],
		["premajor", "alpha"],
	];
	const choices = increments
		.map(([increment, identifier]) => {
			const version = semver.inc(currentVersion, increment, String(identifier || ""));
			return { value: version, name: `${increment}: ${currentVersion} → ${version}` };
		})
		.filter((choice) => choice.value && semver.gt(choice.value, currentVersion));
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
				!semver.valid(value) || !semver.gt(value, currentVersion)
					? `Enter a valid semver greater than ${currentVersion}.`
					: true,
		}),
		"version",
	);
	return semver.valid(entered);
}

function readLocalTag(tagName) {
	const ref = `refs/tags/${tagName}`;
	try {
		// Only --quiet reports a missing ref as status 1; without it Git exits 128.
		git("show-ref", "--verify", "--quiet", "--", ref);
	} catch (error) {
		if (error.status !== 1) throw error;
		return "(not present locally)";
	}
	return git("show-ref", "--verify", "--", ref);
}

function reportState() {
	if (!headBefore) return;
	try {
		console.info(`HEAD before: ${headBefore}\nHEAD now: ${git("rev-parse", "HEAD")}`);
		console.info(`Remaining index/worktree changes:\n${git("status", "--short") || "(clean)"}`);
		console.info(`Version on disk: ${readPackageVersion()}`);
		if (prompt.tagName) console.info(`Local tag ${prompt.tagName}: ${readLocalTag(prompt.tagName)}`);
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
		throw new Error("An interactive terminal is required; no release work was started.");
	}
	if (process.argv.length > 2) {
		throw new Error("Run `npm run release` without arguments; choose the version in the prompt.");
	}
	process.chdir(root);
	// The commit takes the whole index, so a change staged anywhere would ride along.
	if (git("status", "--porcelain", "--untracked-files=no")) {
		throw new Error("Tracked files and the index must be clean before a release.");
	}
	headBefore = git("rev-parse", "HEAD");
	const config = new Config({ config: true, ...interactiveOptions });
	await config.init();
	const options = config.getContext();
	if (!options.git || !options.git.commit || !options.git.tag || !options.git.push) {
		throw new Error("The interactive flow requires git commit, tag, and push to be enabled.");
	}
	if (!options.npm || options.npm.ignoreVersion) {
		throw new Error("The version is read from package.json; keep the npm plugin and its version bump on in .release-it.json.");
	}
	if (options.npm.publish !== false || options.github?.release || options.gitlab?.release) {
		throw new Error("Publishing belongs to .github/workflows/publish.yml; keep npm.publish and hosted releases off in .release-it.json.");
	}
	checkReleaseInputsTracked();
	// With --update, untracked files stay out of the release commit; --all would sweep them in.
	if (options.git.addUntrackedFiles && git("ls-files", "--others", "--exclude-standard")) {
		throw new Error("Untracked files would enter the release commit; handle them before releasing.");
	}
	const currentVersion = readPackageVersion();
	if (!semver.valid(currentVersion)) throw new Error("package.json needs a valid version.");
	const selectedVersion = await chooseVersion(currentVersion);
	try {
		await release(
			{
				...options,
				config: false,
				extends: false,
				...interactiveOptions,
				increment: selectedVersion,
				// The clean check above replaces release-it's own, so it does not install
				// exit/SIGINT handlers that reset the commit and delete the tag after a stop.
				git: { ...options.git, requireCleanWorkingDir: false },
				plugins: {
					[guardPath]: { currentVersion, selectedVersion },
					...options.plugins,
				},
			},
			{ prompt },
		);
	} catch (error) {
		// release-it 21.0.1 logs an API error (a stop included) before rethrowing it.
		hasReportedReleaseError = true;
		throw error;
	}
	console.info(`Released ${selectedVersion}; the publish workflow takes it from the pushed tag.`);
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
