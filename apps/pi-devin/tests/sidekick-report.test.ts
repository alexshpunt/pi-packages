import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { boundReport, SIDEKICK_REPORT_CHAR_LIMIT, SIDEKICK_REPORT_TOKEN_LIMIT, truncateReport } from "../src/pi/sidekick-report.ts";

const reportLine = "보고서 줄 ✅ verified\n";
const longReport = () => `HEAD-MARKER\n${reportLine.repeat(Math.ceil(SIDEKICK_REPORT_CHAR_LIMIT / reportLine.length) + 100)}TAIL-MARKER`;

test("sidekick report limit: 131,072 tokens at Pi's 4 characters per token, cut at the limit without splitting a surrogate pair", () => {
  assert.equal(SIDEKICK_REPORT_TOKEN_LIMIT, 131_072);
  assert.equal(SIDEKICK_REPORT_CHAR_LIMIT, 524_288);
  const exact = "a".repeat(SIDEKICK_REPORT_CHAR_LIMIT);
  assert.deepEqual(truncateReport(exact), { text: exact, isTruncated: false });
  const over = truncateReport(`${exact}b`);
  assert.deepEqual([over.isTruncated, over.text.length], [true, SIDEKICK_REPORT_CHAR_LIMIT]);
  // An astral character across the limit is dropped whole rather than leaving a lone high surrogate.
  const straddle = truncateReport(`${"a".repeat(SIDEKICK_REPORT_CHAR_LIMIT - 1)}😀tail`);
  assert.equal(straddle.text.length, SIDEKICK_REPORT_CHAR_LIMIT - 1);
  assert.equal(/[\ud800-\udbff]$/.test(straddle.text), false);
});

test("boundReport: a short report is unchanged, a long one keeps its beginning and saves the complete text in a private file", async () => {
  assert.deepEqual(await boundReport("short report"), { text: "short report" });
  const original = longReport();
  const bounded = await boundReport(original);
  try {
    assert.ok(bounded.fullReportPath);
    assert.equal(await readFile(bounded.fullReportPath, "utf8"), original);
    assert.equal((await stat(bounded.fullReportPath)).mode & 0o777, 0o600);
    assert.ok(bounded.text.startsWith(original.slice(0, SIDEKICK_REPORT_CHAR_LIMIT)));
    assert.equal(bounded.text.includes("TAIL-MARKER"), false);
    assert.equal(bounded.text.endsWith(`[The sidekick report exceeded about 131072 tokens and was cut. Full report: ${bounded.fullReportPath}]`), true);
  } finally {
    if (bounded.fullReportPath) await rm(dirname(bounded.fullReportPath), { recursive: true, force: true });
  }
});

test("boundReport: a failed save still returns the bounded text and never rejects, so background delivery cannot fail on it", async () => {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = join(tmpdir(), `pi-devin-missing-${process.pid}`, "nested");
  try {
    const bounded = await boundReport(longReport());
    assert.equal(bounded.fullReportPath, undefined);
    assert.equal(bounded.text.includes("TAIL-MARKER"), false);
    assert.match(bounded.text, /exceeded about 131072 tokens and was cut\. The full report could not be saved: /);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  }
});
