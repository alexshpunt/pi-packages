// Deterministic differential inputs: the PII pattern list, PII texts, and core texts.
// Each line is tab-separated with hex-encoded UTF-8 text, as rust/src/main.rs reads it.
import { readFileSync } from "node:fs";

const packageRoot = new URL("../../", import.meta.url);
const fixtureDirectory = new URL("tests/fixtures/redaction/", packageRoot);
const catalogUrl = new URL("vendor/presidio-pii/catalog.json", packageRoot);

const toHex = (text) => Buffer.from(text, "utf8").toString("hex");
const fromCodes = (...codes) => codes.map((code) => String.fromCodePoint(code));

// Characters where Rust `regex` and JavaScript RegExp disagree unless the port
// spells out the Unicode meaning. Characters first assigned after Unicode 16.0
// are left out: the runtime classifies them by its own Unicode version (README).
const WHITESPACE = [
    " ",
    "\t",
    "\n",
    "\r",
    "\r\n",
    "\v",
    "\f",
    // NEL, NBSP, OGHAM SPACE, EM SPACE, LS, PS, NNBSP, IDEOGRAPHIC SPACE, then
    // characters that are not Unicode White_Space: MVS, BOM, ZWSP, FS, US.
    ...fromCodes(0x85, 0xa0, 0x1680, 0x2003, 0x2028, 0x2029, 0x202f, 0x3000),
    ...fromCodes(0x180e, 0xfeff, 0x200b, 0x1c, 0x1f),
];
// Arabic-Indic, Extended Arabic-Indic, Devanagari, Bengali, Thai, fullwidth and
// mathematical digits (Nd); Mongolian digit; Roman numeral, fraction, superscript
// and circled digit (numeric but not Nd).
const DIGITS = fromCodes(
    0x663,
    0x6f5,
    0x969,
    0x9e6,
    0xe53,
    0xff13,
    0x1d7ce,
    0x1d7d7,
    0x1811,
    0x216b,
    0xbd,
    0xb2,
    0x2460,
);
// Case-folding traps (sharp s, dotted/dotless i, Kelvin, long s, sigma forms,
// micro, Angstrom, titlecase, ligature, Ohm), letters from other scripts, and
// astral and modifier letters.
const LETTERS = [
    "é",
    `e${String.fromCodePoint(0x301)}`,
    ...fromCodes(0xdf, 0x1e9e, 0x130, 0x131, 0x212a, 0x17f, 0x3a3, 0x3c2),
    ...fromCodes(0x3c3, 0xb5, 0x3bc, 0x212b, 0xc5, 0x1c5, 0xfb00, 0x3a9),
    ...fromCodes(0x2126, 0xd55c, 0x4e2d, 0x30a2, 0x5d0, 0x628, 0x1d400),
    ...fromCodes(0x1d467, 0x2b0, 0xaa),
];
// Combining acute and diaeresis, ZWNJ, ZWJ, Devanagari stress sign, VS16.
const MARKS = fromCodes(0x301, 0x308, 0x200c, 0x200d, 0x951, 0xfe0f);
const PUNCTUATION = [
    ..."_-@.:=/\\\"'`#$",
    ..."{}(),;|>+",
    // Connector and dash punctuation, fullwidth separators, emoji, flag pair.
    ...fromCodes(0x203f, 0x2040, 0x2010, 0x2011, 0x2212, 0xff0e, 0xff20),
    ...fromCodes(0xff3f, 0xff1a, 0xff1d, 0x1f600),
    String.fromCodePoint(0x1f1f0, 0x1f1f7),
];
const TRICKY = [...WHITESPACE, ...DIGITS, ...LETTERS, ...MARKS, ...PUNCTUATION];
const CASE_SWAPS = Object.fromEntries(
    [
        ["k", 0x212a],
        ["K", 0x212a],
        ["s", 0x17f],
        ["S", 0x17f],
        ["i", 0x130],
        ["I", 0x131],
        ["a", 0xc5],
        ["A", 0x212b],
    ].map(([letter, code]) => [letter, String.fromCodePoint(code)]),
);
const RANDOM_ALPHABET = [
    ...TRICKY,
    ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.@:/",
];

// Seeds for patterns that no fixture text reaches.
const TARGETED_PII_TEXTS = [
    "M-AB 1234",
    "MÜ-X 12E",
    "Ö-AB 1H",
    "B-MW 2024",
    "m-ab 123 ",
    "HH-AB 99H.",
    "K-ÄB 12",
    "x M-AB 1234",
    "ÄÖÜ-XY 1",
    "12CD1234",
    "1UN23",
    "123CC9999",
    "22BH1234AA",
    "29BH0001KZ",
    "23bh1234ka",
    "12A123456B",
    "9X654321Z",
    "10K123456k",
    "2024/1/15",
    "2024/09/31",
    "1999/12/01",
    "15-1-2024",
    "31-12-1999",
    "1-09-2000",
];

const CORE_TEMPLATES = [
    "AKIAIOSFODNN7EXAMPLE",
    "ASIA1234567890ABCDEF",
    "key=AKIAIOSFODNN7EXAMPLE;",
    "ghp_A1b2C3d4E5f6G7h8I9j0K",
    "gho_abcdefghijklmnopqrstu",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
    "sk-proj-abcdefghijklmnop1234",
    "sk-abc",
    "AIzaSyA1234567890abcdefghijklmnopqrstu",
    "xoxb-1234567890-abcdefghij",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    // Built at run time so secret scanning does not take the synthetic keys for credentials.
    `sk_live_${"abcdefghijklmnop1234"}`,
    `rk_test_${"ABCDEFGHIJKLMNOP"}`,
    "glpat-abcdefghijklmnopqrst",
    "npm_abcdefghijklmnopqrstuvwxyz",
    "SG.abcdefghijklmnop.abcdefghijklmnopqrstuvwxyz",
    "Authorization: Bearer abc.def-ghi",
    'proxy-authorization="Basic dXNlcjpwYXNz"',
    "Bearer abcdefgh12345678",
    "bearer short",
    "https://user:p@ss@example.com/path",
    "postgres://admin:hunter2@db:5432/x",
    "ftp://a:b@c",
    "https://hooks.slack.com/services/T000/B000/hooks/XXXXXXXXXXXXXXXXXXXX",
    "https://example.com/api/hooks/abcdefghijklmnop1234?x=1#frag",
    "https://discord.com/api/webhooks/123/hooks/abcdefghijklmnopqrstuv/github",
    "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBg\n-----END PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----\nabc\n",
    "-----BEGIN EC PRIVATE KEY-----x-----END EC PRIVATE KEY----- -----BEGIN OPENSSH PRIVATE KEY-----",
    'password = "hunter2"',
    "api_key: 'abc\\'def'",
    "token=abc123;",
    "export SECRET=abc def",
    "secret: |\n  line one\n  line two\nnext: 1",
    "PASSWORD=foo bar # comment\nNEXT=1",
    'let token: &\'static str = "abc";',
    'const api_key: String = r#"raw"value"#;',
    'access_key = """triple\nquoted"""',
    "pwd = f'{x}'",
    'client_secret = @"C:\\\\path"',
    "it.password = 'it''s'",
    '{"apiKey": "v1", "token": null}',
    "password = $VAR",
    "token = getToken()",
    "secret = [1,2]",
    "self.token=abc",
    "privateKey: >-\n  abc\n  def\nx: 1",
    "TOKEN: `tpl`",
    "secretKey=None",
    "my-token := value",
    "x = 1 # password: hidden",
    "  db_password:   s3cr3t  # note",
    "AccessKeyId=AKIA0123456789ABCDEF",
    "SECRET_KEY='multi\nline'",
    'token = "unterminated',
    "passwd: '' ",
];
// "none" scans without a file path; the others select the ENV/INI line mode or not.
const CORE_PATHS = [
    "none",
    "none",
    ".env",
    ".env.local",
    "app.ini",
    "x.properties",
    "settings.cfg",
    "config.yaml",
    "dir/.env",
];
const CORE_SEPARATORS = [
    " ",
    "\n",
    "; ",
    "\r\n",
    String.fromCodePoint(0x2028),
    ", ",
    "",
    "\t",
];

function createRandom(seed) {
    // mulberry32
    let state = seed | 0;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function createMutator(random) {
    const pick = (items) => items[Math.floor(random() * items.length)];
    const indicesOf = (points, test) =>
        points.flatMap((point, index) => (test(point) ? [index] : []));
    function mutate(text) {
        let points = [...text];
        const operationCount = 1 + Math.floor(random() * 3);
        for (let step = 0; step < operationCount; step++) {
            const at = Math.floor(random() * (points.length + 1));
            switch (Math.floor(random() * 9)) {
                case 0:
                    points.splice(at, 0, pick(TRICKY));
                    break;
                case 1:
                    if (points.length)
                        points[Math.min(at, points.length - 1)] = pick(TRICKY);
                    break;
                case 2: {
                    const digits = indicesOf(points, (point) =>
                        /[0-9]/.test(point),
                    );
                    if (digits.length) points[pick(digits)] = pick(DIGITS);
                    break;
                }
                case 3: {
                    const spaces = indicesOf(points, (point) => point === " ");
                    if (spaces.length) points[pick(spaces)] = pick(WHITESPACE);
                    else points.splice(at, 0, pick(WHITESPACE));
                    break;
                }
                case 4: {
                    const swaps = indicesOf(
                        points,
                        (point) => point in CASE_SWAPS,
                    );
                    if (swaps.length) {
                        const index = pick(swaps);
                        points[index] = CASE_SWAPS[points[index]];
                    } else
                        points = points.map((point) =>
                            random() < 0.5
                                ? point.toUpperCase()
                                : point.toLowerCase(),
                        );
                    break;
                }
                case 5:
                    points =
                        random() < 0.5
                            ? [pick(LETTERS), ...points]
                            : [...points, pick(LETTERS)];
                    break;
                case 6:
                    points.splice(at, 0, pick(MARKS));
                    break;
                case 7:
                    if (points.length > 1)
                        points.splice(Math.min(at, points.length - 1), 1);
                    break;
                default: {
                    const from = Math.floor(random() * points.length);
                    const length = 1 + Math.floor(random() * 6);
                    points.splice(at, 0, ...points.slice(from, from + length));
                }
            }
        }
        return points.join("");
    }
    function randomText(maximumLength) {
        let text = "";
        const length = 1 + Math.floor(random() * maximumLength);
        for (let index = 0; index < length; index++)
            text += pick(RANDOM_ALPHABET);
        return text;
    }
    return { pick, mutate, randomText };
}

const readJsonLines = (url) =>
    readFileSync(url, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

/** Pattern lines in compilePiiRule order: entity, case flag, regex, left boundary, field flag. */
export function generatePatternLines() {
    const catalog = JSON.parse(readFileSync(catalogUrl, "utf8"));
    const lines = [];
    for (const definition of catalog)
        for (const pattern of definition.patterns)
            for (const [expression, isFieldPattern] of [
                [pattern.regex, false],
                ...(pattern.field_regex == null
                    ? []
                    : [[pattern.field_regex, true]]),
            ])
                lines.push(
                    [
                        definition.entity,
                        definition.is_case_insensitive ? "1" : "0",
                        toHex(expression),
                        toHex(pattern.left_boundary),
                        isFieldPattern ? "1" : "0",
                    ].join("\t"),
                );
    return lines;
}

/**
 * PII lines are "<entity or *>\t<hex text>"; core lines are "<path or none>\t<hex text>".
 * `scale` multiplies the number of mutations; the same seed always yields the same lines.
 */
export function generateInputLines({ scale, seed }) {
    const { pick, mutate, randomText } = createMutator(createRandom(seed));
    const cases = readJsonLines(new URL("pii-cases.jsonl", fixtureDirectory));
    const appRecords = readJsonLines(
        new URL("pii-app-fields.jsonl", fixtureDirectory),
    ).filter(
        (record) =>
            typeof record.text === "string" &&
            typeof record.entity === "string",
    );

    const pii = [];
    for (const text of TARGETED_PII_TEXTS) {
        pii.push(["*", text]);
        for (let index = 0; index < 300 * scale; index++)
            pii.push(["*", mutate(text)]);
    }
    for (const testCase of cases) {
        pii.push(["*", testCase.text]);
        for (let index = 0; index < 6 * scale; index++)
            pii.push([
                scale > 1 ? "*" : testCase.entity,
                mutate(testCase.text),
            ]);
    }
    for (const record of appRecords) {
        pii.push([record.entity, record.text]);
        for (let index = 0; index < 4 * scale; index++)
            pii.push([record.entity, mutate(record.text)]);
    }
    for (let index = 0; index < 1000 * scale; index++)
        pii.push(["*", randomText(24)]);

    const core = [];
    for (const template of CORE_TEMPLATES) {
        core.push(["none", template], [".env", template]);
        for (let index = 0; index < 250 * scale; index++)
            core.push([pick(CORE_PATHS), mutate(template)]);
    }
    // Several templates in one text, so detections and consumed ranges interact.
    for (let index = 0; index < 6000 * scale; index++) {
        const texts = Array.from({ length: pick([2, 3, 4]) }, () =>
            pick([true, true, false])
                ? mutate(pick(CORE_TEMPLATES))
                : pick(CORE_TEMPLATES),
        );
        core.push([pick(CORE_PATHS), texts.join(pick(CORE_SEPARATORS))]);
    }
    for (const testCase of cases) core.push(["none", testCase.text]);
    for (const record of appRecords) core.push([pick(CORE_PATHS), record.text]);
    for (let index = 0; index < 3000 * scale; index++)
        core.push([pick(CORE_PATHS), randomText(40)]);

    const encode = ([tag, text]) => `${tag}\t${toHex(text)}`;
    return { pii: pii.map(encode), core: core.map(encode) };
}
