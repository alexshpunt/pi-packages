import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import {
    createRedactor,
    isSupportedPiiEntity,
    listSupportedPiiEntities,
    maskRanges,
    normalizeRedactionConfig,
    REDACTION_MARKER,
} from "../../dist/index.js";
import { createCandidateSearch } from "../../dist/pii/accelerators.js";
import { CATALOG_JSON } from "../../dist/pii/data/catalog.js";
import { IBAN_FORMATS_JSON } from "../../dist/pii/data/iban-formats.js";
import { VALIDATION_DATA_JSON } from "../../dist/pii/data/validation-data.js";
import {
    compilePiiRules,
    createPiiDetector,
} from "../../dist/pii/index.js";
import { translateRustRegex } from "../../dist/pii/regex.js";

const fixture = (path) =>
    new URL(`../fixtures/redaction/${path}`, import.meta.url);
const cases = (await readFile(fixture("pii-cases.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const entities = listSupportedPiiEntities();
const rules = compilePiiRules(entities);
const ruleFor = (entity) => {
    const rule = rules.find((candidate) => candidate.entity === entity);
    expect(rule, entity).toBeTruthy();
    return rule;
};
const utf8 = (text) => Buffer.from(text, "utf8");
// cases.jsonl stores UTF-8 byte offsets; the engine reports UTF-16 indices.
const utf16Index = (text, byteOffset) =>
    utf8(text).subarray(0, byteOffset).toString("utf8").length;
const isOnCodePointBoundary = (text, index) => {
    const code = text.charCodeAt(index);
    return !(code >= 0xdc00 && code <= 0xdfff && index > 0);
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Ported from codemap-search src/redact/pii/tests.rs at 86a772b.
test("[pii] data assets match the byte-for-byte catalog copies", async () => {
    // SHA-256 of the files at 86a772b, also kept unchanged in vendor/presidio-pii.
    for (const [name, text, expected] of [
        [
            "catalog.json",
            CATALOG_JSON,
            "e43c7495393a2a44933b0cf18cb4c566a8a21e0a40afc802725220962869b680",
        ],
        [
            "iban_formats.json",
            IBAN_FORMATS_JSON,
            "bc8db95b129964e4c4cea36b495830046d57588d409847ee1a32bbd5450179f0",
        ],
        [
            "validation_data.json",
            VALIDATION_DATA_JSON,
            "680006e721a0d7ed4ea3b13d4cb80a0cd2877b3e01128f52276e58f0e120e774",
        ],
    ])
        expect(sha256(text), name).toBe(expected);
    expect(entities.length).toBe(90);
    expect([...entities]).toStrictEqual(
        JSON.parse(CATALOG_JSON).map((entry) => entry.entity),
    );
    expect(entities.every(isSupportedPiiEntity)).toBeTruthy();
    expect(
        !isSupportedPiiEntity("EMAIL") &&
            !isSupportedPiiEntity("email_address"),
    ).toBeTruthy();
    expect(sha256(await readFile(fixture("pii-cases.jsonl")))).toBe(
        "0a4707ab0032227e249b00bfc0429ca55f6fac15fc88aca1fb94d0ddc9520a58",
    );
});

test("[pii] large normal source has no PII candidates", () => {
    let input = "";
    for (let line = 1; line <= 10_000; line++)
        input += `  total += ${line} % 7; // public-row-${String(line).padStart(5, "0")}\n`;
    let total = 0;
    for (const rule of rules) total += rule.detect(input, true).length;
    expect(total).toBe(0);
});

test("[pii] large mixed source scanning preserves ranges", () => {
    const lines = [];
    for (let line = 1; line <= 10_000; line++)
        lines.push(
            `  total += ${line} % 7; // public-row-${String(line).padStart(5, "0")}`,
        );
    rules.forEach((rule, index) => {
        const example = cases.find(
            (candidate) =>
                candidate.entity === rule.entity &&
                candidate.expected_len === 1,
        );
        for (let cycle = 0; cycle < 10; cycle++)
            lines[6 + (cycle * 90 + index) * 11] =
                `const row_${cycle}_${index} = { ${example.entity}: '${example.text}' }; // 🌍 개인정보 datos بيانات`;
    });
    const input = lines.join("\r\n");
    let count = 0;
    for (const rule of rules) {
        const ranges = rule.detect(input, true);
        count += ranges.length;
        expect(
            ranges.every(
                ([start, end]) =>
                    isOnCodePointBoundary(input, start) &&
                    isOnCodePointBoundary(input, end),
            ),
            rule.entity,
        ).toBeTruthy();
        const masked = maskRanges(input, ranges);
        expect(masked.length <= input.length).toBeTruthy();
        expect(masked.split("\n").length).toBe(input.split("\n").length);
    }
    expect(count >= 900, `only ${count} candidates`).toBeTruthy();
});

test("[pii] repeated candidates preserve all original ranges", () => {
    const failures = [];
    let checked = 0;
    for (const rule of rules)
        for (const example of cases.filter(
            (candidate) =>
                candidate.entity === rule.entity &&
                candidate.expected_len === 1 &&
                JSON.stringify(candidate.ranges) ===
                    JSON.stringify([[0, utf8(candidate.text).length]]),
        ))
            for (const separator of [",", ";", "|", "\n", "\r\n", "\t", " "]) {
                const { text } = example;
                const input = `${text}${separator}${text}${separator}${text}`;
                const stride = text.length + separator.length;
                const expected = [0, 1, 2].map((index) => [
                    index * stride,
                    index * stride + text.length,
                ]);
                const actual = rule.find(input);
                const isCovered = expected.every(([start, end]) =>
                    actual.some(
                        ([left, right]) => left <= start && right >= end,
                    ),
                );
                // Some separators are legal address characters; VAT permits a
                // trailing separator. Those cases assert complete protection.
                const hasExactBoundaries =
                    ["URL", "EMAIL_ADDRESS", "IT_VAT_CODE"].includes(
                        rule.entity,
                    ) || JSON.stringify(actual) === JSON.stringify(expected);
                if (!isCovered || !hasExactBoundaries)
                    failures.push(
                        `${rule.entity} ${example.source} separator=${JSON.stringify(separator)}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
                    );
                checked++;
            }
    expect(checked > 0).toBeTruthy();
    expect(failures).toStrictEqual([]);
});

test("[pii] all PII rules preserve normal code identifiers", () => {
    const input =
        "export function digest(sha256: string, utf16: string) {\n  const timeoutMs = 10000;\n  const response = request.contentType;\n  return sha256 + utf16 + response;\n}\n";
    const matches = [];
    for (const rule of rules)
        for (const [start, end] of rule.detect(input, true))
            matches.push(`${rule.entity}: ${input.slice(start, end)}`);
    expect(matches).toStrictEqual([]);
});

test("[pii] context is limited to the related value", () => {
    const redactor = createRedactor({ piiEntities: [...entities] });
    // Divergence: codemap-search drops PII matches on tree-sitter identifier nodes,
    // so `const member = sha256;` stays intact there. Without syntax protection the
    // identifier next to the "member" label is masked here.
    const source =
        "export const postalCode = '10000'; const timeoutMs = 20000;\nconst memberId = 'ABC123456789'; const digest = 'sha256';\nconst postcode =\n  '20000';\nconst memberIdReference = sha256;\nconst member = sha256;\nconst country = 'DE';\nconst timeout = 30000;\nconst website = 'example.org'; const response = request.contentType;\nconst url = 'https://example.org/path';\n";
    const expected =
        "export const postalCode = '*****'; const timeoutMs = 20000;\nconst memberId = '[REDACTED]'; const digest = 'sha256';\nconst postcode =\n  '*****';\nconst memberIdReference = sha256;\nconst member = ******;\nconst country = 'DE';\nconst timeout = 30000;\nconst website = '[REDACTED]'; const response = request.contentType;\nconst url = '[REDACTED]';\n";
    const output = redactor.redactText(source, { filePath: "safe.ts" });
    expect(output).toBe(expected);
    const { value } = redactor.redactJson(
        { content: [{ type: "text", text: output }] },
        { stringScope: "line", textContent: "context-free" },
    );
    expect(value.content[0].text).toBe(expected);
});

test("[pii] URL requires complete host labels and preserves source quotes", () => {
    const rule = ruleFor("URL");
    expect(
        rule.find(
            "request.contentType; output.is_redact_enabled; template.companyName",
        ),
    ).toStrictEqual([]);
    for (const suffix of [
        "company",
        "community",
        "com",
        "co",
        "in",
        "international",
    ]) {
        const value = `https://example.${suffix}`;
        const input = `const url = '${value}';`;
        expect(rule.detect(input, true), input).toStrictEqual([
            [13, 13 + value.length],
        ]);
    }
});

test("[pii] a rejected IBAN prefix does not swallow the next value", () => {
    const value = "BE68539007547034";
    const input = `X${value} ${value}`;
    expect(ruleFor("IBAN_CODE").find(input)).toStrictEqual([
        [value.length + 2, input.length],
    ]);
});

test("[pii] candidate localization preserves Unicode boundaries", () => {
    const rule = ruleFor("DE_BSNR");
    for (const [prefix, suffix, isExpected] of [
        ["🌍 ", " datos", true],
        ["한", "", false],
        ["", "한", false],
        ["é", "", false],
        ["", "́", false],
        ["\0", "\0", true],
    ]) {
        const input = `${prefix}021234568${suffix}`;
        expect(rule.find(input), JSON.stringify(input)).toStrictEqual(
            isExpected ? [[prefix.length, prefix.length + 9]] : [],
        );
    }
});

test("[pii] context labels do not borrow from variable references", () => {
    for (const [entity, label, value] of [
        ["DE_PLZ", "postalCode", "10115"],
        ["IT_PASSPORT", "passportNumber", "AA1234567"],
        ["KR_PASSPORT", "여권번호", "M123A4567"],
        ["IT_DRIVER_LICENSE", "driverLicense", "AA0123456B"],
        ["US_BANK_NUMBER", "bankAccount", "945456787654"],
        ["US_SSN", "socialSecurityNumber", "321-54-9876"],
    ]) {
        const input = `const ${label} = '${value}';`;
        const start = input.indexOf(value);
        expect(ruleFor(entity).detect(input, true), entity).toStrictEqual([
            [start, start + value.length],
        ]);
    }
    expect(
        ruleFor("DE_PLZ").detect(
            "const timeoutMs = postalCode.length + 10000;",
            true,
        ),
    ).toStrictEqual([]);
});

test("[pii] mutated Unicode candidates never break output ranges", () => {
    let checked = 0;
    for (const rule of rules) {
        const example = cases.find(
            (candidate) =>
                candidate.entity === rule.entity && candidate.expected_len > 0,
        );
        const characters = [...example.text];
        for (let index = 0; index < characters.length; index += 3) {
            const offset = characters.slice(0, index).join("").length;
            for (const replacement of ["é", "한", "🙂", "١", "\0", "\r\n"]) {
                const input =
                    example.text.slice(0, offset) +
                    replacement +
                    example.text.slice(offset);
                const ranges = rule.find(input);
                expect(
                    ranges.every(
                        ([start, end]) =>
                            isOnCodePointBoundary(input, start) &&
                            isOnCodePointBoundary(input, end),
                    ),
                    rule.entity,
                ).toBeTruthy();
                const masked = maskRanges(input, ranges);
                expect(masked.length <= input.length).toBeTruthy();
                expect(masked.split("\n").length).toBe(
                    input.split("\n").length,
                );
                expect(masked.split("\r").length).toBe(
                    input.split("\r").length,
                );
                checked++;
            }
        }
    }
    expect(checked > 1000).toBeTruthy();
});

test("[pii] Unicode e-mail labels preserve combining characters", () => {
    const value = "u@café.com";
    const text = `연락처: ${value}`;
    const found = ruleFor("EMAIL_ADDRESS").find(text);
    expect(found.length).toBe(1);
    expect(text.slice(...found[0])).toBe(value);
});

test("[pii] decimal digit validation keeps original ranges", () => {
    const value = "4١١١١١١١١١١١١١١١";
    const text = `🌍 بيانات '${value}' public`;
    const found = ruleFor("CREDIT_CARD").find(text);
    expect(found.length).toBe(1);
    expect(text.slice(...found[0])).toBe(value);
    expect(maskRanges(text, found)).toBe(
        `🌍 بيانات '${REDACTION_MARKER}' public`,
    );
});

test("[pii] healthcare field adapters require their own label", () => {
    for (const [entity, label, value] of [
        [
            "US_PRIOR_AUTHORIZATION_NUMBER",
            "priorAuthorizationNumber",
            "987654321",
        ],
        ["US_CLAIM_NUMBER", "claimNumber", "1234567890123"],
        ["US_PRESCRIPTION_NUMBER", "prescriptionNumber", "1234567"],
        ["US_REFERRAL_NUMBER", "referralNumber", "2025001234"],
        ["US_PROVIDER_TAX_ID", "providerTaxId", "12-3456789"],
    ]) {
        const rule = ruleFor(entity);
        const input = `const ${label} = '${value}';`;
        const start = input.indexOf(value);
        expect(rule.detect(input, true)).toStrictEqual([
            [start, start + value.length],
        ]);
        expect(
            rule.detect(input, false),
            `formatted output must not infer ${entity} labels`,
        ).toStrictEqual([]);
        expect(
            rule.detect(`const itemCount = '${value}';`, true),
        ).toStrictEqual([]);
        expect(
            rule.detect(`const ${label}Count = '${value}';`, true),
        ).toStrictEqual([]);
        expect(
            rule.detect(
                `const ${label} = other; const itemCount = '${value}';`,
                true,
            ),
        ).toStrictEqual([]);
    }
});

// The source test runs detect() on single lines of five generated application
// files; the fixture keeps exactly those lines (see its derivedFrom header).
test("[pii] application fixture fields match their selected entity", async () => {
    const [, ...spans] = (
        await readFile(fixture("pii-app-fields.jsonl"), "utf8")
    )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const failures = [];
    let checked = 0;
    for (const span of spans) {
        expect(
            span.text.slice(span.column, span.column + span.value.length),
        ).toBe(span.value);
        const actual = ruleFor(span.entity).detect(span.text, true);
        if (
            !actual.some(
                ([start, end]) =>
                    start <= span.column &&
                    end >= span.column + span.value.length,
            )
        )
            failures.push(
                `${span.file}: ${span.entity} field ${span.field} at line ${span.line}: got ${JSON.stringify(actual)}`,
            );
        checked++;
    }
    expect(checked).toBe(4500);
    expect(failures).toStrictEqual([]);
});

test("[pii] every catalog entity has Presidio cases", () => {
    for (const entity of entities)
        expect(
            cases.some((candidate) => candidate.entity === entity),
            `no cases for ${entity}`,
        ).toBeTruthy();
    expect(cases.length).toBe(1653);
    expect(cases.filter((candidate) => candidate.expected_len > 0).length).toBe(
        993,
    );
    expect(
        cases.filter((candidate) => candidate.expected_len === 0).length,
    ).toBe(660);
});

for (const example of cases)
    test(`[pii] cases.jsonl ${example.entity} ${example.source}`, () => {
        const actual = ruleFor(example.entity).find(example.text);
        expect(actual.length).toBe(example.expected_len);
        if (example.ranges)
            expect(actual).toStrictEqual(
                example.ranges.map(([start, end]) => [
                    utf16Index(example.text, start),
                    utf16Index(example.text, end),
                ]),
            );
    });

test("[pii] every entity preserves coordinates after a Unicode prefix", () => {
    const prefix = "🌍 개인정보 بيانات: ";
    for (const rule of rules) {
        const example = cases.find(
            (candidate) =>
                candidate.entity === rule.entity && candidate.expected_len > 0,
        );
        const original = rule.find(example.text);
        const shifted = rule.find(`${prefix}${example.text}`);
        expect(shifted, rule.entity).toStrictEqual(
            original.map(([start, end]) => [
                start + prefix.length,
                end + prefix.length,
            ]),
        );
    }
});

// The source also disables redaction through configuration; the library has no
// such switch, so that final step is not ported.
test("[pii] selection and exceptions reach all redaction stages", () => {
    const input =
        "const card = '4111111111111111'; const contact = 'info@presidio.site'; const password = 'hidden-password';";
    const defaults = createRedactor().redactText(input, {
        filePath: "data.ts",
    });
    expect(
        defaults.includes("4111111111111111") &&
            defaults.includes("info@presidio.site"),
    ).toBeTruthy();
    expect(defaults.includes("hidden-password")).toBeFalsy();
    const redactor = createRedactor({
        piiEntities: ["CREDIT_CARD", "EMAIL_ADDRESS"],
        exceptions: [
            { ruleId: "pii.email-address", value: "info@presidio.site" },
        ],
    });
    const output = redactor.redactText(input, { filePath: "data.ts" });
    expect(
        !output.includes("4111111111111111") &&
            !output.includes("hidden-password"),
    ).toBeTruthy();
    expect(output.includes("info@presidio.site")).toBeTruthy();
    const { value } = redactor.redactJson(
        { content: [{ type: "text", text: output }], number: 4111111111111111 },
        { stringScope: "line", textContent: "context-free" },
    );
    expect(value.number).toBe(4111111111111111);
    expect(value.content[0].text.includes("info@presidio.site")).toBeTruthy();
    expect(
        redactor
            .redactText("password='info@presidio.site'")
            .includes("info@presidio.site"),
    ).toBeFalsy();
});

// Repository and global configuration layering is not part of the library; the
// per-key fallback and exact entity names are.
test("[pii] PII configuration uses exact names and per-key fallback", () => {
    const invalid = normalizeRedactionConfig({
        piiEntities: ["UNSUPPORTED"],
        sensitiveFields: ["account"],
    });
    expect(invalid.config.piiEntities).toStrictEqual([]);
    expect(invalid.config.sensitiveFields).toStrictEqual(["account"]);
    expect(invalid.issues.map(({ key, index }) => [key, index])).toStrictEqual([
        ["piiEntities", 0],
    ]);
    expect(
        JSON.stringify(
            normalizeRedactionConfig({ piiEntities: ["EMAIL"] }).issues,
        ).includes("EMAIL"),
    ).toBeFalsy();
    expect(
        normalizeRedactionConfig({ piiEntities: ["CREDIT_CARD"] }).config
            .piiEntities,
    ).toStrictEqual(["CREDIT_CARD"]);
    expect(
        normalizeRedactionConfig({ piiEntities: [] }).config.piiEntities,
    ).toStrictEqual([]);
});

test("[pii] pattern boundaries preserve adjacent values and labels", () => {
    const values = (entity, text) =>
        ruleFor(entity)
            .find(text)
            .map((range) => text.slice(...range));
    expect(
        values("KR_RRN", "name='900101-1234567', other='900101-3234567'"),
    ).toStrictEqual(["900101-1234567", "900101-3234567"]);
    expect(
        values("US_PRESCRIPTION_NUMBER", "Rx #1234567; Rx #7654321"),
    ).toStrictEqual(["1234567", "7654321"]);
    expect(ruleFor("CA_SIN").find("046-454 286")).toStrictEqual([]);
    expect(ruleFor("MAC_ADDRESS").find("00:1A-2B:3C:4D:5E")).toStrictEqual([]);
});

test("[pii] PII stays off by default and returns before loading the catalog", () => {
    expect(createPiiDetector([])).toBe(undefined);
    const text =
        "card 4111 1111 1111 1111 mail user@example.com token ghp_" +
        "a".repeat(36);
    const withoutPii = createRedactor();
    const withEmptyPii = createRedactor({ piiEntities: [] });
    expect(withEmptyPii.redactText(text)).toBe(withoutPii.redactText(text));
    expect(
        withoutPii.redactText(text).includes("4111 1111 1111 1111"),
    ).toBeTruthy();
    const enabled = createRedactor({
        piiEntities: ["CREDIT_CARD", "EMAIL_ADDRESS"],
    });
    const scan = enabled.scan(text);
    expect(
        [
            ...new Set(scan.detections.map((detection) => detection.ruleId)),
        ].sort(),
    ).toStrictEqual(["pii.credit-card", "pii.email-address", "token.github"]);
    expect(
        scan.detections.every((detection) => !("value" in detection)),
    ).toBeTruthy();
});

test("[linear-time] the e-mail candidate search matches its reference translation", () => {
    const expression = JSON.parse(CATALOG_JSON).find(
        (definition) => definition.entity === "EMAIL_ADDRESS",
    ).patterns[0].regex;
    const accelerated = createCandidateSearch(expression);
    expect(
        accelerated,
        "the catalog pattern no longer selects its accelerator",
    ).toBeTruthy();
    const reference = new RegExp(
        translateRustRegex(expression.replaceAll("\\b", ""), true),
        "uisg",
    );
    const alphabet = [
        "a",
        "a",
        "a",
        "Z",
        "1",
        ".",
        ".",
        "-",
        "@",
        "@",
        "_",
        "!",
        " ",
        "é",
        "\u{1d49c}",
        "́",
        "٣",
        "K",
        "\n",
        ":",
        "\ud800",
    ];
    let seed = 7;
    const random = (limit) => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return (seed >>> 8) % limit;
    };
    let matched = 0;
    for (let iteration = 0; iteration < 5_000; iteration++) {
        let text = "";
        for (let index = 1 + random(30); index > 0; index--)
            text += alphabet[random(alphabet.length)];
        const search = accelerated(text);
        for (let cursor = 0; cursor <= text.length; cursor++) {
            if (!isOnCodePointBoundary(text, cursor)) continue;
            reference.lastIndex = cursor;
            const expected = reference.exec(text)?.index;
            if (expected !== undefined) matched++;
            expect(search(cursor), `${JSON.stringify(text)} at ${cursor}`).toBe(
                expected,
            );
        }
    }
    expect(matched > 1_000, `only ${matched} matching cursors`).toBeTruthy();
});

test("[linear-time] PII patterns grow less than 8x from 256 KiB to 1 MiB", () => {
    const build = (fragment, size) =>
        fragment.repeat(Math.ceil(size / fragment.length)).slice(0, size);
    const measure = (rule, text, runs) => {
        let best = Number.POSITIVE_INFINITY;
        for (let run = 0; run < runs; run++) {
            const started = process.hrtime.bigint();
            rule.detect(text, true);
            best = Math.min(
                best,
                Number(process.hrtime.bigint() - started) / 1e6,
            );
        }
        return best;
    };
    // Baselines under 1 ms are timer and GC noise; a quadratic pattern still grows 16x.
    const ratio = (rule, small, large, runs) =>
        measure(rule, large, runs) / Math.max(measure(rule, small, runs), 1);
    const small = (fragment) => build(fragment, 256 * 1024);
    const large = (fragment) => build(fragment, 1024 * 1024);
    for (const rule of rules) {
        const example = cases.find(
            (candidate) => candidate.entity === rule.entity,
        ).text;
        for (const fragment of [
            "x",
            "0123456789",
            "a@",
            `${example} `,
            `${example.slice(0, -1)}é`,
        ]) {
            const smallInput = small(fragment);
            const largeInput = large(fragment);
            // Confirm a suspected slowdown with more runs before failing.
            const growth =
                ratio(rule, smallInput, largeInput, 2) < 8
                    ? 0
                    : ratio(rule, smallInput, largeInput, 5);
            expect(
                growth < 8,
                `${rule.entity} on ${JSON.stringify(fragment)}: ${growth.toFixed(1)}x`,
            ).toBeTruthy();
        }
    }
});
