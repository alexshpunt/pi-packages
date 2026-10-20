#!/usr/bin/env node
// Changelog steps of `pnpm release`, shared by every app. Each app keeps two files with the same version sections:
//
//   CHANGELOG.md     English
//   CHANGELOG.ko.md  Korean
//
// An unreleased section holds paired subsections in this order, with empty ones omitted. Both files list the same
// subsections with the same number of bullets, so a reader switching languages sees the same facts:
//
//   ### New        ### 새로워진 것
//   ### Improved   ### 달라진 것
//   ### Fixed      ### 해결된 것
//   ### Removed    ### 제거된 것
//
// Both files follow the English file's version heading style:
//
//   `## UNRELEASED`    renamed to `## X.Y.Z — YYYY-MM-DD`
//   `## [Unreleased]`  kept (empty) above a new `## [X.Y.Z] - YYYY-MM-DD`
//
// release-it runs these from the app directory: `check` in before:init and `stamp <version>` in after:bump, so the
// stamped sections land in the release commit. `notes <version>` prints the GitHub Release body for the publish workflow.
//
//   node ../../scripts/release/changelog.mjs check | stamp <version> | notes <version>

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const LANGUAGES = [
  { code: "en", file: "CHANGELOG.md", title: "# Changelog", label: "English" },
  { code: "ko", file: "CHANGELOG.ko.md", title: "# 변경 이력", label: "한국어" },
];
export const SECTIONS = [
  { key: "new", en: "New", ko: "새로워진 것" },
  { key: "improved", en: "Improved", ko: "달라진 것" },
  { key: "fixed", en: "Fixed", ko: "해결된 것" },
  { key: "removed", en: "Removed", ko: "제거된 것" },
];
const STYLES = [
  { heading: "## UNRELEASED", keepsUnreleased: false, versionHeading: (version, date) => `## ${version} — ${date}` },
  { heading: "## [Unreleased]", keepsUnreleased: true, versionHeading: (version, date) => `## [${version}] - ${date}` },
];

const sectionEnd = (lines, headingIndex) => {
  const next = lines.findIndex((line, index) => index > headingIndex && line.startsWith("## "));
  return next === -1 ? lines.length : next;
};
const languageOf = (code) => LANGUAGES.find((language) => language.code === code);

/** The first unreleased section in either style, with its trimmed body. */
export function findUnreleased(text) {
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const style = STYLES.find((entry) => line.trim() === entry.heading);
    if (style) return { style, index, body: lines.slice(index + 1, sectionEnd(lines, index)).join("\n").trim() };
  }
  return undefined;
}

/** Heading style of the English file: its unreleased heading, else `## [x]` versions mean `## [Unreleased]`. */
export function styleOf(englishText) {
  const unreleased = findUnreleased(englishText);
  if (unreleased) return unreleased.style;
  return englishText.split("\n").some((line) => /^## \[\d/.test(line)) ? STYLES[1] : STYLES[0];
}

/**
 * Splits an unreleased body into canonical subsections. Lines outside them (an older flat format) are `legacy`;
 * unknown, duplicated, out-of-order or empty subsections are `problems`.
 */
export function parseUnreleasedBody(body, code) {
  const sections = [];
  const legacy = [];
  const problems = [];
  let current;
  let lastOrder = -1;
  for (const line of body.split("\n")) {
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      const order = SECTIONS.findIndex((section) => section[code] === heading[1]);
      if (order === -1) {
        problems.push(`unknown subsection "### ${heading[1]}"`);
        current = undefined;
        continue;
      }
      if (sections.some((section) => section.key === SECTIONS[order].key)) problems.push(`duplicated "### ${heading[1]}"`);
      else if (order < lastOrder) problems.push(`"### ${heading[1]}" is out of order`);
      lastOrder = Math.max(lastOrder, order);
      current = { key: SECTIONS[order].key, bullets: [] };
      sections.push(current);
    } else if (!line.trim()) {
      continue;
    } else if (!current) {
      legacy.push(line);
    } else if (line.startsWith("- ")) {
      current.bullets.push(line.slice(2).trim());
    } else if (/^\s+\S/.test(line) && current.bullets.length) {
      current.bullets[current.bullets.length - 1] += ` ${line.trim()}`;
    } else {
      legacy.push(line);
    }
  }
  for (const section of sections) {
    if (!section.bullets.length) problems.push(`"### ${SECTIONS.find((entry) => entry.key === section.key)[code]}" has no bullets`);
  }
  return { sections, legacy, problems };
}

/** Parsed unreleased sections of both files; `ko` is undefined when CHANGELOG.ko.md does not exist. */
export function inspectChangelogs({ en, ko }) {
  const inspect = (text, code) => {
    if (text === undefined) return { exists: false, hasUnreleased: false, sections: [], legacy: [], problems: [] };
    const unreleased = findUnreleased(text);
    if (!unreleased) return { exists: true, hasUnreleased: false, sections: [], legacy: [], problems: [] };
    return { exists: true, hasUnreleased: true, ...parseUnreleasedBody(unreleased.body, code) };
  };
  return { en: inspect(en, "en"), ko: inspect(ko, "ko") };
}

const bulletCount = (inspected) => inspected.sections.reduce((sum, section) => sum + section.bullets.length, 0);

/** Every reason the pair cannot be released as is. Empty when both files hold paired, canonical entries. */
export function changelogProblems(changelogs) {
  const inspected = inspectChangelogs(changelogs);
  const problems = [];
  for (const language of LANGUAGES) {
    const entry = inspected[language.code];
    if (!entry.exists) problems.push(`${language.file} is missing`);
    else if (!entry.hasUnreleased) problems.push(`${language.file} has no unreleased section`);
    else {
      if (entry.legacy.length) problems.push(`${language.file} has entries outside the ### subsections (older format)`);
      for (const problem of entry.problems) problems.push(`${language.file}: ${problem}`);
      if (!bulletCount(entry) && !entry.legacy.length) problems.push(`${language.file} has no unreleased entries`);
    }
  }
  if (!problems.length) {
    const shape = (entry) => entry.sections.map((section) => `${section.key}:${section.bullets.length}`).join(", ");
    if (shape(inspected.en) !== shape(inspected.ko)) {
      problems.push(`The two files do not pair: CHANGELOG.md has [${shape(inspected.en)}], CHANGELOG.ko.md has [${shape(inspected.ko)}]`);
    }
  }
  return problems;
}

export function checkChangelogs(changelogs) {
  const problems = changelogProblems(changelogs);
  if (problems.length) throw new Error(problems.join("; "));
}

/** Same lookup as the publish workflow: exactly one `## <version>` or `## [<version>]` section with a nonempty body. */
export function releaseNotes(text, version, file = "CHANGELOG.md") {
  const lines = text.split("\n");
  const headings = [`## ${version}`, `## [${version}]`];
  const matches = lines.flatMap((line, index) =>
    headings.some((heading) => line === heading || line.startsWith(`${heading} `)) ? [index] : [],
  );
  if (matches.length !== 1) throw new Error(`${file} needs exactly one section for ${version}`);
  const notes = lines.slice(matches[0] + 1, sectionEnd(lines, matches[0])).join("\n").trim();
  if (!notes) throw new Error(`${file} needs a nonempty ## ${version} section`);
  return notes;
}

/** GitHub Release body: the English section, then the Korean one. */
export function combinedReleaseNotes({ en, ko }, version) {
  return LANGUAGES.map((language) => {
    const text = { en, ko }[language.code];
    if (text === undefined) throw new Error(`${language.file} is missing`);
    return `## ${language.label}\n\n${releaseNotes(text, version, language.file)}`;
  }).join("\n\n");
}

const hasVersionSection = (text, version) =>
  text.split("\n").some((line) => line === `## ${version}` || line.startsWith(`## ${version} `) || line.startsWith(`## [${version}]`));

function stampOne(text, version, date, style) {
  const lines = text.split("\n");
  const unreleased = findUnreleased(text);
  const heading = style.versionHeading(version, date);
  if (style.keepsUnreleased) lines.splice(unreleased.index + 1, 0, "", heading);
  else lines[unreleased.index] = heading;
  return { text: lines.join("\n"), heading };
}

/** Stamps both files with the same version heading, or throws without a result when they cannot be released. */
export function stampChangelogs(changelogs, version, date) {
  checkChangelogs(changelogs);
  const style = styleOf(changelogs.en);
  const result = {};
  for (const language of LANGUAGES) {
    if (hasVersionSection(changelogs[language.code], version)) throw new Error(`${language.file} already has a ${version} section`);
    const stamped = stampOne(changelogs[language.code], version, date, style);
    result[language.code] = { ...stamped, notes: releaseNotes(stamped.text, version, language.file) };
  }
  return { ...result, releaseNotes: combinedReleaseNotes({ en: result.en.text, ko: result.ko.text }, version) };
}

/** Markdown lines of canonical subsections; `entries` maps section keys to bullets without the leading "- ". */
export function renderSections(entries, code) {
  return SECTIONS.filter((section) => entries[section.key]?.length).flatMap((section, index) => [
    ...(index ? [""] : []),
    `### ${section[code]}`,
    "",
    ...entries[section.key].map((bullet) => `- ${bullet}`),
  ]);
}

/** Replaces the unreleased body with `entries`, creating the section (or the file) in `style` when it is missing. */
function writeUnreleased(text, code, style, sectionsFor) {
  const base = text ?? `${languageOf(code).title}\n`;
  const lines = base.split("\n");
  const unreleased = findUnreleased(base);
  if (unreleased) {
    const body = sectionsFor(parseUnreleasedBody(unreleased.body, code));
    lines.splice(unreleased.index, sectionEnd(lines, unreleased.index) - unreleased.index, style.heading, "", ...body, "");
    return lines.join("\n");
  }
  const body = sectionsFor({ sections: [], legacy: [], problems: [] });
  const section = [style.heading, "", ...body, ""];
  const first = lines.findIndex((line) => line.startsWith("## "));
  if (first === -1) return [...lines.slice(0, lines.at(-1) === "" ? -1 : undefined), "", ...section].join("\n");
  lines.splice(first, 0, ...section);
  return lines.join("\n");
}

/** Appends bullets to the matching subsections, keeping every entry already there. */
export function appendUnreleasedEntries(text, code, style, entries) {
  return writeUnreleased(text, code, style, ({ sections, legacy }) => {
    const merged = Object.fromEntries(SECTIONS.map((section) => [section.key, []]));
    for (const section of sections) merged[section.key].push(...section.bullets);
    for (const section of SECTIONS) merged[section.key].push(...(entries[section.key] ?? []));
    return [...legacy, ...(legacy.length ? [""] : []), ...renderSections(merged, code)];
  });
}

/** Replaces the whole unreleased body, used to move entries from an older flat format into the subsections. */
export function replaceUnreleasedEntries(text, code, style, entries) {
  return writeUnreleased(text, code, style, () => renderSections(entries, code));
}

export function localDate(now = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Both files of an app directory; a missing CHANGELOG.ko.md reads as undefined. */
export function readChangelogFiles(directory) {
  const read = (file) => (existsSync(path.join(directory, file)) ? readFileSync(path.join(directory, file), "utf8") : undefined);
  return { en: read(LANGUAGES[0].file), ko: read(LANGUAGES[1].file) };
}

function main([command, version]) {
  const changelogs = readChangelogFiles(process.cwd());
  if (command === "check") checkChangelogs(changelogs);
  else if (command === "stamp" && version) {
    const stamped = stampChangelogs(changelogs, version, localDate());
    for (const language of LANGUAGES) writeFileSync(language.file, stamped[language.code].text);
  } else if (command === "notes" && version) console.log(combinedReleaseNotes(changelogs, version));
  else throw new Error("usage: changelog.mjs check | stamp <version> | notes <version>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`changelog: ${error.message}`);
    process.exitCode = 1;
  }
}
