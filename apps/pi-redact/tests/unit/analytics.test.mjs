import { statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ANALYTICS_RETENTION_DAYS, AnalyticsStore } from "../../dist/analytics.js";
import { buildExcerpt, decodeExcerpt, encodeExcerpt, excerptDiffText } from "../../dist/excerpt.js";
import { REDACTION_MARKER } from "../../dist/render.js";
import { temporaryTree } from "../support/fixtures.mjs";

const M = REDACTION_MARKER;
const DAY_MS = 24 * 60 * 60 * 1000;

function openStore(t, clock = { nowMs: Date.UTC(2026, 9, 1) }) {
  const store = new AnalyticsStore(`${temporaryTree(t)}/pi-redact/analytics.sqlite`, () => clock.nowMs);
  t.onTestFinished(() => store.close());
  return { store, clock };
}

const event = (before, after, overrides = {}) => ({
  source: "tool result",
  label: "bash result",
  before,
  after,
  ruleIds: ["token.github"],
  ...overrides,
});

describe("buildExcerpt", () => {
  it("keeps changed lines with two lines of context and marks skipped lines", () => {
    const before = ["a", "b", "c", "TOKEN=x", "d", "e", "f", "g", "h"].join("\n");
    const after = before.replace("TOKEN=x", `TOKEN=${M}`);
    const excerpt = buildExcerpt(before, after);
    expect(excerpt.changedLines).toBe(1);
    expect(excerpt.lines).toEqual([
      null,
      { line: 2, before: "b" },
      { line: 3, before: "c" },
      { line: 4, before: "TOKEN=x", after: `TOKEN=${M}` },
      { line: 5, before: "d" },
      { line: 6, before: "e" },
      null,
    ]);
    expect(excerptDiffText(excerpt)).toBe(
      ["   ...", " 2 b", " 3 c", "-4 TOKEN=x", `+4 TOKEN=${M}`, " 5 d", " 6 e", "   ..."].join("\n"),
    );
  });

  it("drops carriage returns and crops a long line around its change", () => {
    const padding = "x".repeat(1_000);
    const before = `${padding}"secret-value"${padding}\r\nnext`;
    const after = `${padding}"${M}"${padding}\r\nnext`;
    const [line] = buildExcerpt(before, after).lines;
    // The quotes are unchanged, so they count toward the 80 characters kept on each side.
    expect(line.before).toBe(`…${"x".repeat(79)}"secret-value"${"x".repeat(79)}…`);
    expect(line.after).toBe(`…${"x".repeat(79)}"${M}"${"x".repeat(79)}…`);
  });

  it("round-trips through its stored form", () => {
    const excerpt = buildExcerpt("a\nkey=1", `a\nkey=${M}`);
    expect(decodeExcerpt(encodeExcerpt(excerpt))).toEqual(excerpt);
    expect(decodeExcerpt('{"v":99,"lines":[]}')).toBeUndefined();
  });
});

describe("AnalyticsStore", () => {
  it("stores each masked text once per session and lists the newest first", (t) => {
    const { store, clock } = openStore(t);
    const session = { sessionId: "s1", cwd: "/work" };
    expect(store.record(session, [event("ghp_one", M)])).toBe(1);
    clock.nowMs += 1_000;
    expect(store.record(session, [event("ghp_one", M), event("ghp_two", M)])).toBe(1);
    expect(store.record({ sessionId: "s2", cwd: "/other" }, [event("ghp_one", M)])).toBe(1);

    const listed = store.list({ sessionId: "s1" }, 10);
    expect(listed.map((record) => record.recordedAtMs - listed[1].recordedAtMs)).toEqual([1_000, 0]);
    expect(store.get(listed[0].id).excerpt.lines).toEqual([{ line: 1, before: "ghp_two", after: M }]);
    expect(store.count({ sessionId: "s1" })).toBe(2);
    expect(store.count({})).toBe(3);
    expect(store.summarize({})).toEqual({ records: 3, changedLines: 3, rules: [["token.github", 3]] });
    if (process.platform !== "win32") expect(statSync(store.path).mode & 0o777).toBe(0o600);
  });

  it(`hides and deletes records older than ${ANALYTICS_RETENTION_DAYS} days`, (t) => {
    const { store, clock } = openStore(t);
    store.record({ sessionId: "s1", cwd: "/work" }, [event("ghp_old", M, { label: "old" })]);
    clock.nowMs += ANALYTICS_RETENTION_DAYS * DAY_MS + 1;
    expect(store.list({}, 10)).toEqual([]);
    expect(store.count({})).toBe(0);
    // The next write purges the expired record from the file itself.
    store.record({ sessionId: "s1", cwd: "/work" }, [event("ghp_new", M, { label: "new" })]);
    clock.nowMs -= ANALYTICS_RETENTION_DAYS * DAY_MS;
    expect(store.list({}, 10).map((record) => record.label)).toEqual(["new"]);
  });

  it("clears one session or every session", (t) => {
    const { store } = openStore(t);
    store.record({ sessionId: "s1", cwd: "/work" }, [event("ghp_a", M)]);
    store.record({ sessionId: "s2", cwd: "/work" }, [event("ghp_b", M)]);
    expect(store.clear({ sessionId: "s1" })).toBe(1);
    expect(store.count({})).toBe(1);
    expect(store.clear({})).toBe(1);
    expect(store.count({})).toBe(0);
  });
});
