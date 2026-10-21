import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { boundReport, SIDEKICK_REPORT_CHAR_LIMIT, SIDEKICK_REPORT_TOKEN_LIMIT, truncateReport } from "../src/pi/sidekick-report.ts";

const reportLine = "보고서 줄 ✅ verified\n";
const longReport = () => `HEAD-MARKER\n${reportLine.repeat(Math.ceil(SIDEKICK_REPORT_CHAR_LIMIT / reportLine.length) + 100)}TAIL-MARKER`;

test("sidekick report limit: 131,072 tokens at Pi's 4 characters per token, cut at the limit without splitting a surrogate pair", () => {
  expect(SIDEKICK_REPORT_TOKEN_LIMIT).toBe(131_072);
  expect(SIDEKICK_REPORT_CHAR_LIMIT).toBe(524_288);
  const exact = "a".repeat(SIDEKICK_REPORT_CHAR_LIMIT);
  expect(truncateReport(exact)).toStrictEqual({ text: exact, isTruncated: false });
  const over = truncateReport(`${exact}b`);
  expect([over.isTruncated, over.text.length]).toStrictEqual([true, SIDEKICK_REPORT_CHAR_LIMIT]);
  // An astral character across the limit is dropped whole rather than leaving a lone high surrogate.
  const straddle = truncateReport(`${"a".repeat(SIDEKICK_REPORT_CHAR_LIMIT - 1)}😀tail`);
  expect(straddle.text.length).toBe(SIDEKICK_REPORT_CHAR_LIMIT - 1);
  expect(/[\ud800-\udbff]$/.test(straddle.text)).toBe(false);
});

test("boundReport: a short report is unchanged, a long one keeps its beginning and saves the complete text in a private file", async () => {
  expect(await boundReport("short report")).toStrictEqual({ text: "short report" });
  const original = longReport();
  const bounded = await boundReport(original);
  try {
    expect(bounded.fullReportPath).toBeTruthy(); if (!bounded.fullReportPath) throw new Error("unreachable");
    expect(await readFile(bounded.fullReportPath, "utf8")).toBe(original);
    expect((await stat(bounded.fullReportPath)).mode & 0o777).toBe(0o600);
    expect(bounded.text.startsWith("HEAD-MARKER")).toBe(true);
    expect(bounded.text.length).toBeLessThanOrEqual(SIDEKICK_REPORT_CHAR_LIMIT);
    const body = bounded.text.slice(0, bounded.text.indexOf("\n\n[The sidekick report"));
    expect(body).toBe(original.slice(0, body.length));
    expect(/[\ud800-\udbff]$/.test(body)).toBe(false);
    expect(bounded.text.includes("TAIL-MARKER")).toBe(false);
    expect(bounded.text.endsWith(`[The sidekick report exceeded about 131072 tokens and was cut. Full report: ${bounded.fullReportPath}]`)).toBe(true);
  } finally {
    if (bounded.fullReportPath) await rm(dirname(bounded.fullReportPath), { recursive: true, force: true });
  }
});

test("boundReport: a failed save still returns the bounded text and never rejects, so background delivery cannot fail on it", async () => {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = join(tmpdir(), `pi-devin-missing-${process.pid}`, "nested");
  try {
    const bounded = await boundReport(longReport());
    expect(bounded.fullReportPath).toBe(undefined);
    expect(bounded.text.length).toBeLessThanOrEqual(SIDEKICK_REPORT_CHAR_LIMIT);
    expect(bounded.text.startsWith("HEAD-MARKER")).toBe(true);
    expect(bounded.text.includes("TAIL-MARKER")).toBe(false);
    expect(bounded.text).toMatch(/exceeded about 131072 tokens and was cut\. The full report could not be saved: /);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  }
});
