#!/usr/bin/env node
// Interactive release: choose the version, then confirm commit, tag and push one at a time.
//
//   npm run release
//
// Nothing is published from here. Pushing the `v*` tag triggers
// .github/workflows/publish.yml, which publishes to npm and creates the GitHub Release.
// Declining or cancelling stops the whole flow and leaves what was done in place (no
// automatic rollback); the state report at the end says exactly what remains.

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
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
let headBefore;

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

function reportState() {
	if (!headBefore) return;
	try {
		console.info(`HEAD before: ${headBefore}\nHEAD now: ${git("rev-parse", "HEAD")}`);
		console.info(`Remaining index/worktree changes:\n${git("status", "--short") || "(clean)"}`);
		console.info(`Version on disk: ${readPackageVersion()}`);
		if (prompt.tagName) {
			let tagRef;
			try {
				tagRef = git("show-ref", "--verify", `refs/tags/${prompt.tagName}`);
			} catch {
				tagRef = "(not present locally)";
			}
			console.info(`Local tag ${prompt.tagName}: ${tagRef}`);
		}
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
	// Unlike release-it's own check, this also catches untracked files.
	if (git("status", "--porcelain", "--untracked-files=all")) {
		throw new Error("The entire repository must be clean (untracked files included) before a release.");
	}
	headBefore = git("rev-parse", "HEAD");
	const config = new Config({ config: true, ...interactiveOptions });
	await config.init();
	const options = config.getContext();
	if (!options.git || !options.git.commit || !options.git.tag || !options.git.push) {
		throw new Error("The interactive flow requires git commit, tag, and push to be enabled.");
	}
	if (!options.npm || options.npm.ignoreVersion || options.npm.publish !== false || options.github?.release || options.gitlab?.release) {
		throw new Error("Publishing belongs to .github/workflows/publish.yml; keep npm.publish and hosted releases off in .release-it.json.");
	}
	const currentVersion = readPackageVersion();
	if (!semver.valid(currentVersion)) throw new Error("package.json needs a valid version.");
	const selectedVersion = await chooseVersion(currentVersion);
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
	console.info(`Released ${selectedVersion}; the publish workflow takes it from the pushed tag.`);
} catch (error) {
	if (error instanceof ReleaseStopped) console.warn(error.message);
	else console.error(error.message);
	process.exitCode = 1;
} finally {
	process.chdir(root);
	reportState();
}
