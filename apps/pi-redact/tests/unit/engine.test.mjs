import { createRedactor } from "@buyong/redact";
import { describe, expect, it } from "vitest";
import { TextCache } from "../../dist/cache.js";
import { createMaskEngine } from "../../dist/engine.js";
import { countMarkers, REDACTION_MARKER } from "../../dist/render.js";

const M = REDACTION_MARKER;
const engine = createMaskEngine(createRedactor());

/** A redactor that counts full-text scans, to observe cache hits. */
function countingRedactor() {
  const redactor = createRedactor();
  const counter = { scans: 0 };
  const wrapped = {
    ...redactor,
    scan(text, options) {
      counter.scans++;
      return redactor.scan(text, options);
    },
  };
  return { redactor: wrapped, counter };
}

describe("maskText", () => {
  it("uses the marker for every masked span, however short", () => {
    expect(engine.maskText('password = "ab"')).toBe(`password = "${M}"`);
    expect(engine.maskText("SHORT_PASSWORD=x")).toBe(`SHORT_PASSWORD=${M}`);
    expect(engine.maskText("token: sk-abcdefghijklmnop1234")).toBe(`token: ${M}`);
  });

  it("keeps every line and line ending of a masked block", () => {
    const pem = ["-----BEGIN PRIVATE KEY-----", "MIIBVQIBADANBgkqhkiG9w0BAQEFAASC", "", "-----END PRIVATE KEY-----"];
    const text = `before\r\n${pem.join("\r\n")}\r\nafter`;
    const masked = engine.maskText(text);
    expect(masked).toBe(`before\r\n${M}\r\n${M}\r\n\r\n${M}\r\nafter`);
    expect(masked.split("\n")).toHaveLength(text.split("\n").length);
  });

  it.each([
    ["grep -n", ".env:2:DB_PASSWORD=fixture-pass", `.env:2:DB_PASSWORD=${M}`],
    ["grep context line", ".env-3-DB_PASSWORD=fixture-pass", `.env-3-DB_PASSWORD=${M}`],
    ["rg --column", "conf/app.env:4:1:SECRET=fixture-pass", `conf/app.env:4:1:SECRET=${M}`],
    ["grep -r without -n", "./config/.env:DB_PASSWORD=fixture-pass", `./config/.env:DB_PASSWORD=${M}`],
    ["cat -n", "     2\tDB_PASSWORD=fixture-pass", `     2\tDB_PASSWORD=${M}`],
    ["rg heading line", "2:DB_PASSWORD=fixture-pass", `2:DB_PASSWORD=${M}`],
    ["numbered viewer", "12→DB_PASSWORD=fixture-pass", `12→DB_PASSWORD=${M}`],
    ["diff addition", "+DB_PASSWORD=fixture-pass", `+DB_PASSWORD=${M}`],
    ["diff removal", "-DB_PASSWORD=fixture-pass", `-DB_PASSWORD=${M}`],
    ["grep of a diff", "patch.diff:7:+API_TOKEN=fixture-pass", `patch.diff:7:+API_TOKEN=${M}`],
    ["indented YAML in grep", "config.yml:4:  password: fixture-pass", `config.yml:4:  password: ${M}`],
  ])("masks unquoted assignments behind a %s prefix", (_name, input, expected) => {
    expect(engine.maskText(input)).toBe(expected);
  });

  it("scans a grep line from an .env file with that file's whole-value rule", () => {
    expect(engine.maskText(".env:1:DB_PASSWORD=two words # note")).toBe(`.env:1:DB_PASSWORD=${M} # note`);
    expect(engine.maskText("DB_PASSWORD=two words", ".env")).toBe(`DB_PASSWORD=${M}`);
  });

  it.each([
    "const total = a - 1 - b;",
    "https://example.com:8080/path",
    "12:30 meeting with token holders",
    "--- a/.env",
    "+++ b/.env",
    "PORT=8080",
    "- item one",
    "src/index.ts:10:import { token } from './auth.js';",
  ])("leaves ordinary text unchanged: %s", (text) => {
    expect(engine.maskText(text)).toBe(text);
  });

  it("is idempotent", () => {
    const inputs = [
      'password = "hunter2-value"',
      ".env:2:DB_PASSWORD=fixture-pass",
      "Authorization: Bearer abcdefgh12345678",
      "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      `already ${M} masked`,
    ];
    for (const input of inputs) {
      const once = engine.maskText(input);
      expect(engine.maskText(once)).toBe(once);
    }
  });

  it("finds line prefixes in linear time on long lines without spaces", () => {
    // A quadratic prefix pattern needs tens of seconds for these lines.
    for (const unit of ["a.", "a-1", "./", "a-", "x:"]) {
      const line = unit.repeat(100_000);
      const start = performance.now();
      expect(engine.maskText(line)).toBe(line);
      expect(performance.now() - start).toBeLessThan(1_000);
    }
  });

  it("returns the same string when nothing is detected", () => {
    const text = "nothing sensitive here\n".repeat(10);
    expect(engine.maskText(text)).toBe(text);
  });
});

describe("maskJson", () => {
  it("masks strings under sensitive keys whole and keeps other values", () => {
    const input = { token: "plain-value", count: 3, nested: { apiKey: "x", list: ["password = 'longvalue1'"] } };
    expect(engine.maskJson(input)).toEqual({
      token: M,
      count: 3,
      nested: { apiKey: M, list: [`password = '${M}'`] },
    });
  });

  it("does not pass a sensitive key down to array items or objects", () => {
    expect(engine.maskJson({ token: ["plain", { note: "plain" }] })).toEqual({ token: ["plain", { note: "plain" }] });
  });

  it("returns the same objects when nothing is masked and copies only changed branches", () => {
    const untouched = { a: { b: ["plain"] } };
    expect(engine.maskJson(untouched)).toBe(untouched);
    const shared = { keep: { value: "plain" }, change: { password: "value" } };
    const masked = engine.maskJson(shared);
    expect(masked.keep).toBe(shared.keep);
    expect(masked.change).toEqual({ password: M });
    expect(shared.change.password).toBe("value");
  });

  it("keeps a __proto__ key as data, follows toJSON, and survives cycles", () => {
    const withProto = JSON.parse('{"__proto__": {"password": "value"}}');
    const masked = engine.maskJson(withProto);
    expect(Object.hasOwn(masked, "__proto__")).toBe(true);
    expect(masked.__proto__).toEqual({ password: M });
    expect(engine.maskJson({ when: { toJSON: () => ({ secret: "value" }) } })).toEqual({ when: { secret: M } });
    const cyclic = { secret: "value" };
    cyclic.self = cyclic;
    expect(engine.maskJson(cyclic).secret).toBe(M);
  });
});

describe("request cache", () => {
  it("does not rescan text it has already masked", () => {
    const { redactor, counter } = countingRedactor();
    const cached = createMaskEngine(redactor, new TextCache(1_000_000, 100));
    const text = `context line\n${"x".repeat(1000)}\npassword = "cached-value"`;
    const first = cached.maskText(text);
    const scansAfterFirst = counter.scans;
    expect(cached.maskText(`${text}`)).toBe(first);
    expect(counter.scans).toBe(scansAfterFirst);
  });

  it("keys results by path hint", () => {
    const { redactor, counter } = countingRedactor();
    const cached = createMaskEngine(redactor, new TextCache(1_000, 10));
    expect(cached.maskText("DB_PASSWORD=two words")).toBe(`DB_PASSWORD=${M} words`);
    const before = counter.scans;
    expect(cached.maskText("DB_PASSWORD=two words", ".env")).toBe(`DB_PASSWORD=${M}`);
    expect(counter.scans).toBeGreaterThan(before);
  });

  it("evicts the least recently used text beyond its entry and character limits", () => {
    const { redactor, counter } = countingRedactor();
    const byEntries = createMaskEngine(redactor, new TextCache(1_000, 2));
    byEntries.maskText("first text");
    byEntries.maskText("second text");
    byEntries.maskText("first text");
    byEntries.maskText("third text");
    let before = counter.scans;
    byEntries.maskText("first text");
    expect(counter.scans).toBe(before);
    byEntries.maskText("second text");
    expect(counter.scans).toBe(before + 1);

    const byCharacters = createMaskEngine(redactor, new TextCache(40, 100));
    // One entry may use at most a quarter of the budget; a longer text is never stored.
    byCharacters.maskText("x".repeat(11));
    before = counter.scans;
    byCharacters.maskText("x".repeat(11));
    expect(counter.scans).toBe(before + 1);
  });
});

describe("countMarkers", () => {
  it("counts non-overlapping markers", () => {
    expect(countMarkers(`${M}${M} and ${M}`)).toBe(3);
    expect(countMarkers("{{REDACTED}")).toBe(0);
  });
});
