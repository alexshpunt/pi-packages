// Drafts the unreleased CHANGELOG.md / CHANGELOG.ko.md entries of one app with `claude -p` during `pnpm release`.
//
// The model runs without tools, settings, hooks or MCP servers: the prompt carries the app's commits since its last
// release tag, the source diff, a README excerpt for exact names and both current unreleased sections. It returns
// paired English and Korean bullets per canonical subsection. The writing rules follow the web-changelog-author
// audience filter and the clear-writing (ISO 24495-1) skill: only changes a user of the package notices.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendUnreleasedEntries, inspectChangelogs, replaceUnreleasedEntries, SECTIONS, styleOf } from "./changelog.mjs";
import { root } from "./shared.mjs";

export const DRAFT_MODEL = "sonnet";
export const DRAFT_EFFORT = "medium";
const DRAFT_TIMEOUT_MS = 300_000;
/** How long claude gets to exit after SIGTERM before it is killed. */
const KILL_GRACE_MS = 5_000;
const MAX_COMMITS = 200;
const PATCH_LIMIT_CHARS = 60_000;
const README_LIMIT_CHARS = 20_000;
const GIT_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
/** Paths whose changes users never see; they stay in the file list but leave the diff. */
const DIFF_EXCLUDES = ["tests", "test", "verification", "fixtures", "__snapshots__", "experiments"];

const sectionsSchema = {
  type: "object",
  properties: Object.fromEntries(SECTIONS.map((section) => [section.key, { type: "array", items: { type: "string" } }])),
  required: SECTIONS.map((section) => section.key),
  additionalProperties: false,
};
const DRAFT_SCHEMA = {
  type: "object",
  properties: { en: sectionsSchema, ko: sectionsSchema },
  required: ["en", "ko"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You write release notes for one Pi package. Pi is a terminal coding agent; a package adds providers, models, commands, tools or settings to it.

Readers are people who install the package with \`pi install\` and use it inside Pi, not contributors. They skim the notes to learn what they can do now, what behaves differently, which problem they will no longer hit, and whether a change applies to their setup. Every bullet answers one of these questions.

Answer with JSON: \`en\` and \`ko\`, each with the lists \`new\`, \`improved\`, \`fixed\` and \`removed\`. Each string is one Markdown bullet without the leading "- ".
- new: a capability that did not exist before. improved: a visible change to something that already shipped. fixed: a problem users ran into, described by its result. removed: something users can no longer use.
- \`en\` and \`ko\` state the same facts in the same lists. Align the facts first, then write each language as native prose on its own; never carry over the other language's word order. Korean uses the "~합니다" style, prefers a verb to a chain of Sino-Korean nouns, and chooses the everyday word.

What belongs. Decide by whether a user can see, feel or do something differently, not by how much work the change took.
- Include new commands, options, settings, models and behaviors; visible changes to existing behavior; problems whose symptom users experienced, described as the symptom and the new result rather than the root cause.
- Exclude, even when true: implementation and architecture details, internal refactors without an observable change, tests, verification, CI, build, packaging and release tooling, documentation-only edits, dependency bumps without a visible effect, and other products named only to explain how something was built. If a bullet would only make sense to someone who has read the source code, rewrite it as the effect the user notices or drop it. Empty lists are expected when nothing qualifies.

How to write each bullet.
- One change per bullet, main point first. Keep each condition, exception or limit next to the action it limits, and never drop one the user needs.
- Be concrete: name the command, setting, model ID, key, file or message exactly as users see it. Copy names from the README excerpt and the diff, and put commands, IDs, paths and settings in backticks. Use one name for each thing.
- Describe a fix by its result ("Requests with ... no longer fail"); do not open every English bullet with "Fixed". In Korean, "~던 문제를 해결했습니다" fits a symptom readers recognize, but do not end every bullet with it.
- Use "can" / "~할 수 있습니다" only for an option the user chooses. When the package does something on its own, say so directly. Name the condition instead of "may", "in some cases" or "일부 경우"; keep uncertainty only when it is real.
- Usually one or two sentences. A bullet that needs a third sentence holds two changes or explains the mechanism: split it or cut the mechanism.
- Stay calm and factual, as one capable adult to another. No hype, announcements, filler or benefit-selling.
- Rewrite these unless the word states something the user can observe: seamless, powerful, robust, effortless, intuitive; improved, enhanced, optimized, streamlined, better experience, overall stability; "This release brings", "various improvements"; "provides support for", "allows you to easily", "is now able to", "ensures"; "Fixed an issue where", "now works properly"; noun stacks. In Korean: 강력한, 원활한, 직관적인, 손쉽게, 한층, 개선되었습니다, 향상, 최적화, 강화, 사용자 경험, 전반적인 안정성, 이번 업데이트에서는, 다양한 개선 사항, 제공합니다 or 지원합니다 when a plainer verb exists, 진행합니다, ~을 통해, 가능해졌습니다, ~하는 현상을 수정했습니다, 해당, ~에 의해, ~되어지다, ~에 대한, ~로 인해. Do not open every bullet with "Now", "You can" or "이제".
- Formatting: backticks for exact names only. No bold lead-ins, "Label:" prefixes, emoji, exclamation marks, chains of em dashes, headings, versions or dates.
- Use only facts present in the commits and the diff. Never invent issue numbers, versions, names, numbers or limits.

Before answering, read every bullet as a user who has never seen the code: can they tell which feature changed and what they will now see or do? Is any bullet about how the change was built? Do both languages state the same facts? Fix what fails.`;

const runGit = (args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER_BYTES, stdio: ["ignore", "pipe", "pipe"] });

function latestReleaseTag(target) {
  try {
    return runGit(["describe", "--tags", `--match=${target.slug}-v[0-9]*`, "--abbrev=0", "HEAD"]).trim();
  } catch {
    return undefined;
  }
}

/** The app's commits and source diff since its last release tag (or its whole history before the first release). */
export function collectDraftInputs(target) {
  const sinceTag = latestReleaseTag(target);
  const range = sinceTag ? [`${sinceTag}..HEAD`] : ["HEAD"];
  const scope = ["--", target.path];
  const commitCount = Number(runGit(["rev-list", "--count", "--no-merges", ...range, ...scope]).trim());
  const commitLog = runGit(["log", "--no-merges", `--max-count=${MAX_COMMITS}`, "--format=commit %h%n%B", ...range, ...scope]).trim();
  // Before the first release tag the whole app is new, so compare against the empty tree.
  const base = sinceTag ?? runGit(["hash-object", "-t", "tree", "/dev/null"]).trim();
  const diffStat = runGit(["diff", "--stat=120", base, "HEAD", ...scope]).trim();
  const excludes = [
    ...DIFF_EXCLUDES.map((name) => `:(glob,exclude)${target.path}/**/${name}/**`),
    `:(glob,exclude)${target.path}/**/CHANGELOG*.md`,
  ];
  const fullPatch = runGit(["diff", base, "HEAD", "--", target.path, ...excludes]);
  const isPatchTruncated = fullPatch.length > PATCH_LIMIT_CHARS;
  return { sinceTag, commitCount, commitLog, diffStat, patch: fullPatch.slice(0, PATCH_LIMIT_CHARS), isPatchTruncated };
}

/** `convert` when an unreleased section still uses the older flat format, so the draft replaces it; else `append`. */
export function draftModeFor(changelogs) {
  const inspected = inspectChangelogs(changelogs);
  return inspected.en.legacy.length || inspected.ko.legacy.length ? "convert" : "append";
}

function unreleasedText(inspected, code) {
  if (!inspected.exists) return "(file does not exist yet)";
  if (!inspected.hasUnreleased) return "(no unreleased section)";
  const lines = [...inspected.legacy];
  for (const section of inspected.sections) {
    lines.push(`### ${SECTIONS.find((entry) => entry.key === section.key)[code]}`, ...section.bullets.map((bullet) => `- ${bullet}`));
  }
  return lines.join("\n") || "(empty)";
}

export function buildDraftPrompt({ target, inputs, changelogs, mode }) {
  const inspected = inspectChangelogs(changelogs);
  const readmePath = path.join(target.directory, "README.md");
  const readme = existsSync(readmePath) ? readFileSync(readmePath, "utf8").slice(0, README_LIMIT_CHARS) : "(no README)";
  const task =
    mode === "convert"
      ? "The unreleased sections below use an older flat format. Rewrite their facts into the lists, applying the audience filter and writing rules, and add bullets for changes in the commits they do not cover. Your answer replaces both unreleased sections completely, so both languages must hold every bullet."
      : "Keep the entries already in the unreleased sections below. Return only bullets for changes they do not cover yet, per language: after your bullets are appended, both files must state the same facts with the same number of bullets in each list. Return empty lists when nothing is missing.";
  return [
    `Package: ${target.name} (${target.path})`,
    `Release range: ${inputs.sinceTag ? `commits since ${inputs.sinceTag}` : "all commits (no release tag yet)"}, ${inputs.commitCount} commit(s)`,
    "",
    "== Commits ==",
    inputs.commitLog || "(none)",
    "",
    "== Changed files ==",
    inputs.diffStat || "(none)",
    "",
    `== Diff without tests, verification, fixtures and changelogs${inputs.isPatchTruncated ? `, truncated to ${PATCH_LIMIT_CHARS} characters` : ""} ==`,
    inputs.patch || "(none)",
    "",
    "== README excerpt (names users see) ==",
    readme,
    "",
    "== Current unreleased section of CHANGELOG.md (English) ==",
    unreleasedText(inspected.en, "en"),
    "",
    "== Current unreleased section of CHANGELOG.ko.md (Korean) ==",
    unreleasedText(inspected.ko, "ko"),
    "",
    "== Task ==",
    task,
  ].join("\n");
}

const cleanBullet = (value) =>
  String(value)
    .replace(/^\s*[-*]\s+/, "")
    .replace(/\s*\n\s*/g, " ")
    .trim();

/** Normalizes the structured answer into `{ en: { new: [...], ... }, ko: {...} }`. */
export function parseDraft(structured) {
  if (!structured || typeof structured !== "object") throw new Error("claude returned no structured draft.");
  const result = {};
  for (const code of ["en", "ko"]) {
    const lists = structured[code];
    if (!lists || typeof lists !== "object") throw new Error(`The draft has no ${code} lists.`);
    result[code] = Object.fromEntries(
      SECTIONS.map((section) => {
        const items = lists[section.key];
        if (!Array.isArray(items)) throw new Error(`The draft's ${code}.${section.key} is not a list.`);
        return [section.key, items.map(cleanBullet).filter(Boolean)];
      }),
    );
  }
  return result;
}

export const isEmptyDraft = (draft) => ["en", "ko"].every((code) => SECTIONS.every((section) => !draft[code][section.key].length));

/** The common entry for a release whose commits hold no user-visible change, such as documentation-only edits. */
export const FALLBACK_DRAFT = {
  en: { new: [], improved: [], fixed: ["Other bug fixes"], removed: [] },
  ko: { new: [], improved: [], fixed: ["기타 버그 수정"], removed: [] },
};

/** An empty draft takes FALLBACK_DRAFT only when it would be appended and neither unreleased section has entries. */
export function needsFallbackDraft(changelogs, mode) {
  const inspected = inspectChangelogs(changelogs);
  return mode === "append" && !inspected.en.sections.length && !inspected.ko.sections.length;
}

/** Both files after applying the draft: appended to the current entries, or replacing an older-format section. */
export function applyDraft(changelogs, draft, mode) {
  const style = styleOf(changelogs.en);
  const apply = mode === "convert" ? replaceUnreleasedEntries : appendUnreleasedEntries;
  return { en: apply(changelogs.en, "en", style, draft.en), ko: apply(changelogs.ko, "ko", style, draft.ko) };
}

/**
 * Runs `claude -p` once. `signal` cancels it (Ctrl+C) and a fixed timeout bounds a stalled call; either way the promise
 * settles only after the claude process has exited, so no draft keeps running after the release stops.
 */
export function runClaude(prompt, { signal } = {}) {
  const args = [
    "-p",
    "--model",
    DRAFT_MODEL,
    "--effort",
    DRAFT_EFFORT,
    "--tools",
    "",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(DRAFT_SCHEMA),
    "--system-prompt",
    SYSTEM_PROMPT,
  ];
  return new Promise((resolve, reject) => {
    // A temporary cwd keeps the repository's CLAUDE.md out of the model context.
    const child = spawn("claude", args, { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stopReason;
    let isSettled = false;
    const settle = (action, value) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      action(value);
    };
    const stop = (reason) => {
      if (stopReason) return;
      stopReason = reason;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => stop(new Error(`claude did not answer within ${DRAFT_TIMEOUT_MS / 1000}s.`)), DRAFT_TIMEOUT_MS);
    const onAbort = () => stop(signal.reason ?? new Error("The changelog draft was cancelled."));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      settle(reject, error.code === "ENOENT" ? new Error("The claude CLI is not on PATH; install Claude Code and sign in.") : error);
    });
    child.on("close", (code) => {
      if (stopReason) return settle(reject, stopReason);
      let result;
      try {
        result = JSON.parse(stdout);
      } catch {
        return settle(reject, new Error(`claude exited with ${code}: ${(stderr || stdout).trim().split("\n").slice(-3).join(" ")}`));
      }
      if (result.is_error || result.subtype !== "success") {
        return settle(reject, new Error(`claude failed: ${result.result || result.subtype || `exit ${code}`}`));
      }
      settle(resolve, result);
    });
    // claude can exit before reading all input (for example when it is not signed in); its exit code reports that.
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

/** Drafts the missing (or converted) entries of one app. */
export async function draftChangelog({ target, inputs, changelogs, signal }) {
  const mode = draftModeFor(changelogs);
  const startedAtMs = Date.now();
  const result = await runClaude(buildDraftPrompt({ target, inputs, changelogs, mode }), { signal });
  return { mode, draft: parseDraft(result.structured_output), costUSD: result.total_cost_usd, durationMs: Date.now() - startedAtMs };
}
