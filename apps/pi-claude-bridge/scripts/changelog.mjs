#!/usr/bin/env node
// Keeps CHANGELOG.md's `## UNRELEASED` convention (see AGENTS.md) in step with releases.
//
//   node scripts/changelog.mjs check            fail unless UNRELEASED exists and has entries
//   node scripts/changelog.mjs stamp <version>  rename UNRELEASED to `<version> — YYYY-MM-DD`
//   node scripts/changelog.mjs notes <version>  print that version's entries
//
// release-it runs `check` before any write and `stamp` after the version bump, so the
// renamed section lands in the release commit; the publish workflow uses `notes` as the
// GitHub Release body.

import { readFileSync, writeFileSync } from "node:fs";

const changelogPath = new URL("../CHANGELOG.md", import.meta.url);
const unreleasedHeading = "## UNRELEASED";

function findSection(lines, isHeading) {
	const headingIndex = lines.findIndex(isHeading);
	if (headingIndex === -1) return undefined;
	const nextHeadingIndex = lines.findIndex((line, index) => index > headingIndex && line.startsWith("## "));
	const bodyEnd = nextHeadingIndex === -1 ? lines.length : nextHeadingIndex;
	return { headingIndex, body: lines.slice(headingIndex + 1, bodyEnd).join("\n").trim() };
}

function localDate() {
	const now = new Date();
	const pad = (value) => String(value).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function fail(message) {
	console.error(`changelog: ${message}`);
	process.exit(1);
}

const [command, version] = process.argv.slice(2);
const lines = readFileSync(changelogPath, "utf8").split("\n");
const isVersionHeading = (line) => line.startsWith(`## ${version} `);
const unreleased = findSection(lines, (line) => line.trim() === unreleasedHeading);

switch (command) {
	case "check":
		if (!unreleased) fail(`no "${unreleasedHeading}" section in CHANGELOG.md`);
		if (!unreleased.body) fail(`the "${unreleasedHeading}" section in CHANGELOG.md has no entries`);
		break;
	case "stamp":
		if (!version) fail("stamp needs a version");
		if (!unreleased) fail(`no "${unreleasedHeading}" section in CHANGELOG.md`);
		if (lines.some(isVersionHeading)) fail(`CHANGELOG.md already has a ${version} section`);
		lines[unreleased.headingIndex] = `## ${version} — ${localDate()}`;
		writeFileSync(changelogPath, lines.join("\n"));
		break;
	case "notes": {
		if (!version) fail("notes needs a version");
		const released = findSection(lines, isVersionHeading);
		if (!released?.body) fail(`no entries for ${version} in CHANGELOG.md`);
		console.log(released.body);
		break;
	}
	default:
		fail("usage: changelog.mjs check | stamp <version> | notes <version>");
}
