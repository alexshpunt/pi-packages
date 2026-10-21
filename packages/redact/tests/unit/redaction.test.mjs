import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import {
    BUILT_IN_RULE_IDS,
    createRedactor,
    hideValue,
    isSupportedPiiEntity,
    listSupportedPiiEntities,
    maskRanges,
    normalizeRedactionConfig,
    piiRuleId,
    REDACTION_MARKER,
    RedactionConfigError,
} from "../../dist/index.js";
import {
    BUILT_IN_RULES,
    detectPrivateKeys,
    hasSensitiveSuffix,
    normalizeFieldName,
    REFERENCE_PATTERNS,
    regexMatcher,
} from "../../dist/rules.js";
import { detectAssignments } from "../../dist/text.js";

const redactor = createRedactor();
const corpus = new Set();
function redactText(input, options) {
    corpus.add(input);
    return redactor.redactText(input, options);
}
function count(text, character) {
    return text.split(character).length - 1;
}

// Ported from codemap-search src/redact/tests.rs at 86a772b.
test("[core-parity] credentials are hidden without changing safe code or line breaks", () => {
    const cases = [
        ['{"password":\n  "next-line-secret"}', "next-line-secret"],
        ['password = r"""\nraw-multiline-secret\n"""', "raw-multiline-secret"],
        ['password = @"first""last-secret";', "last-secret"],
        ["API_KEY=plain-secret-value\nSAFE=value\n", "plain-secret-value"],
        ['const PASSWORD: &str = "한글-비밀번호";\r\n', "한글-비밀번호"],
        [
            '{"access_token":"arbitrary-credential","port":8080}',
            "arbitrary-credential",
        ],
        ["Authorization: Bearer bearer-value-12345", "bearer-value-12345"],
        [
            "postgres://reader:database-password@localhost/app",
            "database-password",
        ],
        [
            "value = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'",
            "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        ],
        [
            'password = """\nmultiline-secret-value\n"""\npublic = \'visible\'\n',
            "multiline-secret-value",
        ],
        [
            "private_key: |\n  yaml-secret-value\npublic: visible\n",
            "yaml-secret-value",
        ],
        [
            "-----BEGIN PRIVATE KEY-----\npem-secret-value\n-----END PRIVATE KEY-----\n",
            "pem-secret-value",
        ],
        ['const PASSWORD: &str = r#"raw-secret-value"#;', "raw-secret-value"],
        ["password='x'", "'x'"],
    ];
    for (const [input, secret] of cases) {
        const masked = redactText(input);
        expect(
            masked.includes(secret),
            `credential remained visible: ${masked}`,
        ).toBeFalsy();
        expect(masked.length <= input.length).toBeTruthy();
        expect(count(masked, "\n")).toBe(count(input, "\n"));
        expect(count(masked, "\r")).toBe(count(input, "\r"));
    }
    const safe =
        'const token = process.env.TOKEN;\nlet password = load_password();\nconst token_count = 12;\nconst message = "hello";\n// Basic conditional paths remain visible.\n';
    expect(redactText(safe)).toBe(safe);
});

test("[json] response masking keeps source locations and protocol structure", () => {
    const original = 'password = """\ninterior-secret\n"""\npublic = 42\n';
    const lines = redactText(original).split("\n");
    if (lines.at(-1) === "") lines.pop();
    const rendered = lines
        .map((line, index) => `${String(index + 1).padStart(6)}→${line}\n`)
        .join("");
    const input = {
        content: [{ type: "text", text: rendered }],
        other: { code: -32602, message: "API_KEY=error-secret-value" },
    };
    const options = { stringScope: "line", textContent: "context-free" };
    const { value } = redactor.redactJson(input, options);
    const text = value.content[0].text;
    expect(
        text.includes("2→[REDACTED]") && text.includes("4→public = 42"),
        text,
    ).toBeTruthy();
    expect(value.content[0].type).toBe("text");
    expect(value.other.code).toBe(-32602);
    expect(JSON.stringify(value).includes("interior-secret")).toBeFalsy();
    expect(JSON.stringify(value).includes("error-secret-value")).toBeFalsy();
    const second = redactor.redactJson(value, options);
    expect(second.value).toStrictEqual(value);
    expect(second.maskedLocations).toStrictEqual([]);
});

// tests.rs runs these through tree-sitter; only the text fallback is ported.
// config.py diverges: the fallback masks the bare `external_value` reference
// after a line-leading `password: str =`, which the syntax layer kept visible.
test("[core-parity] file-path scans mask values and keep references through the text fallback", () => {
    const cases = [
        [
            "config.ts",
            "type Options = { password: string };\nconst password: string = externalValue;\nconst config = { apiKey: 'sensitive-literal', visible: 'public-literal' };",
            "sensitive-literal",
            "password: string = externalValue",
        ],
        [
            "config.py",
            "password: str = external_value\ndef connect(api_key: str = 'sensitive-literal'): pass\n",
            "sensitive-literal",
            undefined,
        ],
        [
            "config.rs",
            'const PASSWORD: &str = ENV_VALUE;\nconst API_KEY: &str = r#"sensitive-literal"#;',
            "sensitive-literal",
            "PASSWORD: &str = ENV_VALUE",
        ],
        [
            "config.go",
            "package demo\nvar password = externalValue\nvar apiKey = `sensitive-literal`\n",
            "sensitive-literal",
            "password = externalValue",
        ],
        [
            "config.json",
            '{"api-key": "sensitive-literal", "public": "public-literal"}',
            "sensitive-literal",
            "public-literal",
        ],
        [
            "config.yaml",
            "api_key: sensitive-literal\npublic: public-literal\n",
            "sensitive-literal",
            "public-literal",
        ],
        [
            "config.toml",
            "api_key = 'sensitive-literal'\npublic = 'public-literal'\n",
            "sensitive-literal",
            "public-literal",
        ],
        [
            ".env",
            "PASSWORD=first; sensitive-literal # comment\nPUBLIC=public-literal\n",
            "sensitive-literal",
            "PUBLIC=public-literal",
        ],
        [
            "config.ini",
            "password=first; sensitive-literal\npublic=public-literal\n",
            "sensitive-literal",
            "public=public-literal",
        ],
        [
            "broken.ts",
            "const password = 'sensitive-literal'\nconst = ???;\nconst publicValue = 'public-literal';",
            "sensitive-literal",
            "public-literal",
        ],
    ];
    for (const [filePath, input, secret, safe] of cases) {
        const masked = redactText(input, { filePath });
        expect(masked.includes(secret), `${filePath}: ${masked}`).toBeFalsy();
        if (safe !== undefined)
            expect(
                masked.includes(safe),
                `${filePath}: ${masked}`,
            ).toBeTruthy();
        const { value } = redactor.redactJson(
            { content: [{ type: "text", text: masked }] },
            { stringScope: "line", textContent: "context-free" },
        );
        expect(value.content[0].text, filePath).toBe(masked);
    }
});

test("[core-parity] detections keep original UTF-16 spans next to Unicode text", () => {
    const input =
        "const 설명 = {password: '비밀-문자열', message: 'public-literal'};\r\n";
    const scan = redactor.scan(input, { filePath: "config.ts" });
    const secretStart = input.indexOf("비밀-문자열");
    expect(
        scan.detections.some(
            (detection) =>
                detection.ruleId === "field.sensitive" &&
                detection.kind === "sensitive-field" &&
                detection.start === secretStart &&
                detection.end === secretStart + "비밀-문자열".length,
        ),
    ).toBeTruthy();
    const masked = scan.render(input);
    corpus.add(input);
    expect(masked.endsWith("\r\n")).toBeTruthy();
    expect(masked.length <= input.length).toBeTruthy();
    expect(
        masked.includes("public-literal") && !masked.includes("비밀"),
    ).toBeTruthy();
});

test("[core-parity] vendor catalog and overlaps cover the whole original value", () => {
    for (const value of [
        // Built at run time so secret scanning does not take the synthetic key for a credential.
        `sk_live_${"abcdefghijklmnop0123456789"}`,
        "glpat-abcdefghijklmnop0123456789",
        "npm_abcdefghijklmnop0123456789",
        "xoxp-abcdefghijklmnop0123456789",
        "SG.abcdefghijklmnop012345.abcdefghijklmnop0123456789",
    ])
        expect(redactText(value).includes(value), value).toBeFalsy();
    const input = `password = 'sk-proj-${"a".repeat(240)}-tail-of-secret'`;
    expect(redactText(input).includes("tail-of-secret")).toBeFalsy();
    expect(
        maskRanges("abcdefghijklmnop", [
            [0, 8],
            [4, 16],
        ]),
    ).toBe(REDACTION_MARKER);
});

test("[configuration] custom rules, exact exceptions, and per-key fallback", () => {
    const configured = createRedactor({
        sensitiveFields: ["internalCredential"],
        rules: [{ id: "custom.acme", pattern: "ACME_[A-Z0-9]+" }],
        exceptions: [{ ruleId: "custom.acme", value: "ACME_EXAMPLE" }],
    });
    const input =
        "const config = { internal_credential: 'private-value', safe: 'ACME_EXAMPLE', other: 'ACME_SECRET' };";
    corpus.add(input);
    const masked = configured.redactText(input, { filePath: "config.ts" });
    expect(masked.includes("ACME_EXAMPLE")).toBeTruthy();
    expect(
        !masked.includes("ACME_SECRET") && !masked.includes("private-value"),
    ).toBeTruthy();
    // An exception never suppresses another matching rule or a longer value.
    expect(
        configured.redactText("ACME_EXAMPLEPLUS").includes("ACME_EXAMPLE"),
    ).toBeFalsy();
    expect(
        configured
            .redactText("password='ACME_EXAMPLE'")
            .includes("ACME_EXAMPLE"),
    ).toBeFalsy();
    const fallback = normalizeRedactionConfig({
        rules: [{ id: "custom.invalid", pattern: "[" }],
        sensitiveFields: ["internalCredential"],
    });
    expect(fallback.config.rules).toStrictEqual([]);
    expect(fallback.config.sensitiveFields).toStrictEqual([
        "internalCredential",
    ]);
    expect(fallback.issues).toStrictEqual([
        {
            key: "rules",
            index: 0,
            message: "pattern is not a valid JavaScript regular expression",
        },
    ]);
    const empty = normalizeRedactionConfig({ rules: [], exceptions: [] });
    expect(empty.config.rules).toStrictEqual([]);
    expect(empty.config.exceptions).toStrictEqual([]);
    expect(empty.issues).toStrictEqual([]);
});

// value.ts, value.py, and value.json depend on tree-sitter template, concatenation,
// and JSON-escape decoding, which the text fallback does not reproduce.
test("[core-parity] concatenated and unrecognized values retain coverage", () => {
    for (const [filePath, input, secrets, safe] of [
        [
            "value.cs",
            'class Demo { const string password = @"sensitive-prefix-secret"; }',
            ["sensitive-prefix-secret"],
            "class Demo",
        ],
        [
            "value.java",
            'class Demo { String password = "sensitive-prefix-secret"; String token = reference; }',
            ["sensitive-prefix-secret"],
            "token = reference",
        ],
        [
            "value.yaml",
            "password: | # details\n  sensitive-prefix-secret\n  sensitive-suffix-secret\nsafe: public-value\n",
            ["sensitive-prefix-secret", "sensitive-suffix-secret"],
            "safe: public-value",
        ],
    ]) {
        const output = redactText(input, { filePath });
        for (const secret of secrets)
            expect(
                output.includes(secret),
                `${filePath}: ${output}`,
            ).toBeFalsy();
        expect(output.includes(safe), `${filePath}: ${output}`).toBeTruthy();
    }
});

test("[configuration] custom capture groups limit masking to the secret", () => {
    const configured = createRedactor({
        sensitiveFields: ["internalcredential"],
        rules: [
            {
                id: "custom.capture",
                pattern: "LABEL=(?<secret>VALUE_[A-Z]+)",
            },
        ],
    });
    const source =
        "const settings = { internalCredential: 'private-value' }; const note = 'LABEL=VALUE_SECRET';";
    corpus.add(source);
    const scan = configured.scan(source, { filePath: "config.ts" });
    const output = scan.render(source);
    expect(
        !output.includes("private-value") && !output.includes("VALUE_SECRET"),
    ).toBeTruthy();
    expect(output.includes("LABEL=")).toBeTruthy();
    expect(
        scan.detections.some(
            (detection) =>
                detection.ruleId === "custom.capture" &&
                detection.kind === "custom",
        ),
    ).toBeTruthy();
});

const ruleCases = {
    "token.aws-access-key": [
        "key AKIAABCDEFGHIJKLMNOP end",
        "key AKIAABCDEFGHIJKLMNOPQ end",
    ],
    "token.github": [`ghp_${"a1".repeat(18)}`, "ghp_short123"],
    "token.openai": ["sk-abcdefghijklmnop1234", "sk-short1234"],
    "token.google": [`AIza${"b".repeat(35)}`, `AIza${"b".repeat(10)}`],
    "token.slack": ["xoxb-1234567890-abcdef", "xoxq-1234567890-abcdef"],
    "token.jwt": [
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
        "eyJhbGci.eyJzdWIi.c2ln",
    ],
    "token.stripe": [`sk_live_${"c".repeat(24)}`, `sk_prod_${"c".repeat(24)}`],
    "token.gitlab": [`glpat-${"d".repeat(20)}`, "glpat-short"],
    "token.npm": [`npm_${"e".repeat(36)}`, "npm_short"],
    "token.sendgrid": [
        `SG.${"f".repeat(22)}.${"g".repeat(43)}`,
        "SG.short.short",
    ],
    "credential.authorization": [
        "Authorization: Basic dXNlcjpwYXNz",
        "Authorization: Token dXNlcjpwYXNz",
    ],
    "credential.bearer": ["Bearer abcdefgh123", "Bearer short"],
    "credential.url-password": [
        "https://user:pa55word@example.com",
        "https://example.com/path",
    ],
    "credential.webhook-url": [
        "https://ci.example.com/api/hooks/abcdefghijklmnop1234?x=1",
        "https://ci.example.com/api/hooks/short",
    ],
    "private-key.pem": [
        "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
        "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----",
    ],
    "field.sensitive": ["api_key = 'value-123'", "monkey = 'value-123'"],
};

test("[rules] the rule-case table covers every built-in rule id", () => {
    expect(Object.keys(ruleCases).sort()).toStrictEqual(
        [...BUILT_IN_RULE_IDS, "private-key.pem", "field.sensitive"].sort(),
    );
    const [secret] = redactor
        .scan("https://user:pa55word@example.com")
        .detections.filter(
            (detection) => detection.ruleId === "credential.url-password",
        );
    expect([secret.start, secret.end]).toStrictEqual([13, 21]);
});

for (const [ruleId, [positive, negative]] of Object.entries(ruleCases))
    test(`[rules] ${ruleId} has a positive and a negative case`, () => {
        corpus.add(positive);
        corpus.add(negative);
        const hits = (text) =>
            redactor
                .scan(text)
                .detections.filter((detection) => detection.ruleId === ruleId);
        expect(
            hits(positive).length > 0,
            `${ruleId} missed ${positive}`,
        ).toBeTruthy();
        expect(hits(negative).length, `${ruleId} matched ${negative}`).toBe(0);
    });

test("[rules] Unicode word boundaries follow Rust semantics", () => {
    const token = `ghp_${"a".repeat(36)}`;
    expect(redactor.scan(`가${token}`).detections.length).toBe(0);
    expect(redactor.scan(`${token}가`).detections.length).toBe(0);
    expect(redactor.scan(`가 ${token}`).detections.length).toBe(1);
    expect(redactor.scan(`-${token}`).detections.length).toBe(1);
    // `(?i)` folds U+212A KELVIN SIGN to `k`, as Rust case-insensitive classes do.
    expect(
        redactor
            .scan("https://ci.example.com/hoo\u212As/abcdefghijklmnop1234")
            .detections.some(
                (detection) => detection.ruleId === "credential.webhook-url",
            ),
    ).toBeTruthy();
    // U+0085 is Unicode whitespace for Rust `\s`; U+FEFF is not.
    expect(
        redactor.scan("https://user:pass\u0085word@example.com").detections
            .length,
    ).toBe(0);
});

function seededRandom(seed) {
    let state = seed;
    return (limit) => {
        state = (state + 0x6d2b79f5) | 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) % limit;
    };
}

test("[linear-time] linear rewrites match their reference translations", () => {
    const alphabets = {
        "token.jwt": [
            "eyJ",
            "eyJ",
            "eyJabcdefgh",
            "abcdefgh",
            "a",
            "-",
            "_",
            ".",
            ".",
            " ",
            "é",
            "\u212A",
        ],
        "credential.url-password": [
            "a",
            "x",
            "+",
            ".",
            "-",
            "://",
            "a://",
            "u",
            ":",
            ":",
            "p",
            "@",
            "/",
            " ",
            "é",
            "\u017F",
            "\u212A",
            "9",
        ],
        "credential.webhook-url": [
            "http://",
            "https://",
            "httpſ://",
            "h",
            "/",
            "hooks/",
            "HOOKS/",
            "a",
            "-",
            "0123456789abcdef",
            "?",
            "#",
            " ",
            '"',
            "é",
            ".",
        ],
    };
    for (const [ruleId, alphabet] of Object.entries(alphabets)) {
        const random = seededRandom(ruleId.length);
        const reference = regexMatcher(
            REFERENCE_PATTERNS[ruleId].source,
            REFERENCE_PATTERNS[ruleId].flags,
        );
        const linear = BUILT_IN_RULES.find((rule) => rule.id === ruleId).match;
        let matchedCases = 0;
        for (let iteration = 0; iteration < 30_000; iteration++) {
            let text = "";
            const length = 1 + random(14);
            for (let index = 0; index < length; index++)
                text += alphabet[random(alphabet.length)];
            const expected = [...reference(text)];
            if (expected.length) matchedCases++;
            expect(
                [...linear(text)],
                `${ruleId}: ${JSON.stringify(text)}`,
            ).toStrictEqual(expected);
        }
        expect(
            matchedCases > 50,
            `${ruleId} produced too few matching cases`,
        ).toBeTruthy();
    }
});

test("[linear-time] built-in patterns grow less than 8x from 256 KiB to 1 MiB", () => {
    const isSensitiveKey = (name) =>
        hasSensitiveSuffix(normalizeFieldName(name));
    const drain = (iterable) => {
        let found = 0;
        for (const _ of iterable) found++;
        return found;
    };
    const targets = [
        ...BUILT_IN_RULES.map((rule) => [
            rule.id,
            (text) => drain(rule.match(text)),
        ]),
        ["private-key.pem", (text) => detectPrivateKeys(text).length],
        [
            "field.sensitive",
            (text) => detectAssignments(text, isSensitiveKey).length,
        ],
        ["redactText", (text) => redactor.redactText(text).length],
    ];
    const fragments = [
        "eyJ-",
        "eyJabcdefgh.",
        "a.",
        "a.a://",
        "a://b:c/",
        "http://a/",
        "http://a/hooks/",
        "github_pat_",
        "AKIA",
        "SG.aaaaaaaaaaaaaaaa.",
        "Bearer ",
        "proxy-authorization:",
        "-----BEGIN PRIVATE KEY-----",
        "password=",
        "password = '",
        "password: |x\n",
        " ",
    ];
    const build = (fragment, size) =>
        `${fragment.repeat(Math.ceil(size / fragment.length)).slice(0, size - 1)}é`;
    const measure = (fn, text) => {
        let best = Number.POSITIVE_INFINITY;
        for (let run = 0; run < 3; run++) {
            const started = process.hrtime.bigint();
            fn(text);
            best = Math.min(
                best,
                Number(process.hrtime.bigint() - started) / 1e6,
            );
        }
        return best;
    };
    const inputs = fragments.map((fragment) => [
        fragment,
        build(fragment, 256 * 1024),
        build(fragment, 1024 * 1024),
    ]);
    for (const [ruleId, fn] of targets)
        for (const [fragment, smallInput, largeInput] of inputs) {
            // Sub-millisecond baselines are timer noise; floor them at 0.5 ms.
            const small = Math.max(measure(fn, smallInput), 0.5);
            const large = measure(fn, largeInput);
            expect(
                large / small < 8,
                `${ruleId} on ${JSON.stringify(fragment)}: ${small.toFixed(2)} ms -> ${large.toFixed(2)} ms`,
            ).toBeTruthy();
        }
});

test("[linear-time] redactJson on unclosed PEM lines grows less than 8x from 64 KiB to 256 KiB", () => {
    const build = (size) => ({
        text: "-----BEGIN PRIVATE KEY-----\n".repeat(Math.ceil(size / 28)),
    });
    const measure = (input) => {
        let best = Number.POSITIVE_INFINITY;
        for (let run = 0; run < 3; run++) {
            const started = process.hrtime.bigint();
            redactor.redactJson(input);
            best = Math.min(
                best,
                Number(process.hrtime.bigint() - started) / 1e6,
            );
        }
        return best;
    };
    const small = Math.max(measure(build(64 * 1024)), 0.5);
    const large = measure(build(256 * 1024));
    expect(
        large / small < 8,
        `redactJson on unclosed PEM lines: ${small.toFixed(2)} ms -> ${large.toFixed(2)} ms`,
    ).toBeTruthy();
});

test("[masking] scans render whole texts and sub-ranges from one full scan", () => {
    const source =
        'header\npassword = """\nline-one-secret\nline-two-secret\n"""\nfooter';
    const scan = redactor.scan(source);
    const lineStart = source.indexOf("line-two-secret");
    const lineEnd = lineStart + "line-two-secret\n".length;
    expect(scan.renderRange(source, lineStart, lineEnd)).toBe(
        `${REDACTION_MARKER}\n`,
    );
    expect(scan.renderRange(source, 0, 7)).toBe("header\n");
    expect(redactor.redactText(source.slice(lineStart, lineEnd))).toBe(
        "line-two-secret\n",
    );
    for (const detection of scan.detections)
        expect(Object.keys(detection).sort()).toStrictEqual([
            "end",
            "kind",
            "ruleId",
            "start",
        ]);
    expect(
        Object.isFrozen(scan) && Object.isFrozen(scan.detections),
    ).toBeTruthy();
});

test("[masking] hidden values never grow and keep CR/LF in place", () => {
    expect(hideValue("short")).toBe("*****");
    expect(hideValue("long-enough-value\r\nab\n")).toBe(
        `${REDACTION_MARKER}\r\n**\n`,
    );
    expect(hideValue(REDACTION_MARKER)).toBe(REDACTION_MARKER);
    expect(hideValue("한글")).toBe("**");
    expect(redactor.redactNamedValue("password", "x")).toBe("*");
    expect(redactor.redactNamedValue("Proxy-Password", "secret-value-1")).toBe(
        REDACTION_MARKER,
    );
    expect(redactor.redactNamedValue("description", "plain words")).toBe(
        "plain words",
    );
    expect(
        redactor.redactNamedValue("description", `ghp_${"a".repeat(36)}`),
    ).toBe(REDACTION_MARKER);
    expect(redactor.isSensitiveField("client_secret")).toBeTruthy();
    expect(redactor.isSensitiveField("authorization")).toBeFalsy();
});

test("[json] JSON masking preserves keys, structure, and preserved paths", () => {
    const pem =
        "-----BEGIN PRIVATE KEY-----\npem-body-secret\n-----END PRIVATE KEY-----";
    const input = {
        id: `ghp_${"a".repeat(36)}`,
        password: "short",
        count: 3,
        enabled: true,
        nothing: null,
        nested: [{ apiKey: "nested-secret-value" }, `note ${pem}`],
        list: { password: ["array-items-keep-field-insensitivity"] },
        ["__proto__"]: "proto-value",
        date: new Date(0),
    };
    const options = {
        shouldPreserve: (path) => path.length === 1 && path[0] === "id",
    };
    const { value, maskedLocations } = redactor.redactJson(input, options);
    expect(value.id).toBe(input.id);
    expect(value.password).toBe("*****");
    expect(value.count).toBe(3);
    expect(value.enabled).toBe(true);
    expect(value.nothing).toBe(null);
    expect(value.nested[0].apiKey).toBe(REDACTION_MARKER);
    expect(value.nested[1]).toBe(
        `note ${REDACTION_MARKER}\n${REDACTION_MARKER}\n${REDACTION_MARKER}`,
    );
    expect(value.list).toStrictEqual(input.list);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(value, "__proto__").value).toBe(
        "proto-value",
    );
    expect(value.date).toBe("1970-01-01T00:00:00.000Z");
    expect(maskedLocations).toStrictEqual([
        { path: ["password"], ruleId: "field.sensitive" },
        { path: ["nested", 0, "apiKey"], ruleId: "field.sensitive" },
        { path: ["nested", 1], ruleId: "private-key.pem" },
    ]);
    expect(
        JSON.stringify(maskedLocations).includes("secret-value"),
    ).toBeFalsy();
    const lineScoped = redactor.redactJson(
        { text: pem },
        { stringScope: "line" },
    );
    expect(lineScoped.value.text.includes("pem-body-secret")).toBeTruthy();
    const again = redactor.redactJson(value, options);
    expect(again.value).toStrictEqual(value);
    expect(again.maskedLocations).toStrictEqual([]);
});

test("[json] changed rules keep their first changed order per path, not their first detection", () => {
    const configured = createRedactor({
        rules: [
            { id: "custom.value", pattern: "\\[REDACTED\\]|secret-\\d+" },
            { id: "custom.overlap", pattern: "secret-1" },
        ],
    });
    const input = {
        unchanged: REDACTION_MARKER,
        first: "[REDACTED]\r\nsecret-1 secret-2\r\nsecret-1",
        second: "secret-2",
        pem: "-----BEGIN PRIVATE KEY-----\n".repeat(4),
    };
    for (const stringScope of ["whole", "line"]) {
        const { value, maskedLocations } = configured.redactJson(input, {
            stringScope,
        });
        expect(value).toStrictEqual({
            unchanged: REDACTION_MARKER,
            first: "[REDACTED]\r\n******** ********\r\n********",
            second: "********",
            pem: "[REDACTED]\n".repeat(4),
        });
        expect(maskedLocations).toStrictEqual([
            { path: ["first"], ruleId: "custom.overlap" },
            { path: ["first"], ruleId: "custom.value" },
            { path: ["second"], ruleId: "custom.value" },
            { path: ["pem"], ruleId: "private-key.pem" },
        ]);
        expect(configured.redactJson(value, { stringScope }).maskedLocations)
            .toStrictEqual([]);
    }
});

test("[configuration] normalization reports keys and indexes, never values", () => {
    const secret = "SYNTHETIC_CONFIG_SECRET_7f3a";
    const { config, issues } = normalizeRedactionConfig({
        sensitiveFields: ["---", secret],
        rules: [
            { id: "custom.ok", pattern: "OK_[0-9]+" },
            { id: "custom.ok", pattern: secret },
            { id: "acme", pattern: secret },
            { id: "custom.bad", pattern: `(${secret}` },
            { id: "custom.empty", pattern: `(?:${secret})?` },
            { id: "custom.flags", pattern: secret, flags: "g" },
            { id: "custom.extra", pattern: secret, note: secret },
        ],
        exceptions: [
            { ruleId: "custom.ok", value: "" },
            { ruleId: "custom.ok", value: secret },
        ],
        piiEntities: ["EMAIL"],
        [secret]: true,
    });
    expect(config.sensitiveFields).toStrictEqual([]);
    expect(config.rules).toStrictEqual([]);
    expect(config.exceptions).toStrictEqual([]);
    expect(config.piiEntities).toStrictEqual([]);
    expect(issues.map(({ key, index }) => [key, index])).toStrictEqual([
        [secret, undefined],
        ["sensitiveFields", 0],
        ["rules", 1],
        ["rules", 2],
        ["rules", 3],
        ["rules", 4],
        ["rules", 5],
        ["rules", 6],
        ["exceptions", 0],
        ["piiEntities", 0],
    ]);
    for (const issue of issues)
        if (issue.key !== secret)
            expect(JSON.stringify(issue).includes(secret)).toBeFalsy();
    expect(JSON.stringify(issues).includes("EMAIL")).toBeFalsy();
    expect(() =>
        createRedactor({
            rules: [{ id: "custom.bad", pattern: `(${secret}` }],
        }),
    ).toThrow(
        expect.toSatisfy(
            (error) =>
                error instanceof RedactionConfigError &&
                !error.message.includes(secret) &&
                error.issues.length === 1,
        ),
    );
    expect(() => createRedactor({ unknown: [] })).toThrow(RedactionConfigError);
    const valid = createRedactor({
        rules: [{ id: "custom.case", pattern: "acme_[a-z]+", flags: "i" }],
    });
    expect(valid.redactText("ACME_TOKENVALUE")).toBe(REDACTION_MARKER);
    expect(
        Object.isFrozen(valid) && Object.isFrozen(valid.config),
    ).toBeTruthy();
});

test("[configuration] host rules and fields use their own namespace", () => {
    const host = createRedactor(
        { rules: [{ id: "custom.user", pattern: "USER_[0-9]+" }] },
        {
            rules: [
                {
                    id: "host.synthetic",
                    pattern: "SYNTHETIC_[A-Z0-9_]+",
                    flags: "i",
                },
            ],
            sensitiveFields: ["authorization"],
        },
    );
    const scan = host.scan("synthetic_marker USER_42");
    expect(
        scan.detections.map(({ ruleId, kind }) => [ruleId, kind]),
    ).toStrictEqual([
        ["host.synthetic", "host"],
        ["custom.user", "custom"],
    ]);
    expect(host.redactNamedValue("Authorization", "Basic abc")).toBe(
        "*********",
    );
    expect(
        host.config.rules.some((rule) => rule.id.startsWith("host.")),
    ).toBeFalsy();
    expect(() =>
        createRedactor({}, { rules: [{ id: "custom.x", pattern: "x" }] }),
    ).toThrow(RedactionConfigError);
    expect(() =>
        createRedactor({ rules: [{ id: "host.x", pattern: "x" }] }),
    ).toThrow(RedactionConfigError);
});

test("[pii] the PII extension point is off by default and accepts only catalog names", () => {
    expect(listSupportedPiiEntities().length).toBe(90);
    expect(isSupportedPiiEntity("EMAIL_ADDRESS")).toBe(true);
    expect(piiRuleId("CREDIT_CARD")).toBe("pii.credit-card");
    expect(() => createRedactor({ piiEntities: ["EMAIL"] })).toThrow(
        RedactionConfigError,
    );
    const text = "mail user@example.com card 4111 1111 1111 1111";
    expect(createRedactor({ piiEntities: [] }).redactText(text)).toBe(text);
    expect(
        redactor.scan(text, { mode: "context-free" }).detections.length,
    ).toBe(0);
});

test("[properties] masking never grows output, keeps line breaks, and is idempotent", () => {
    expect(corpus.size > 40, `corpus has ${corpus.size} inputs`).toBeTruthy();
    for (const input of corpus) {
        for (const options of [
            {},
            { filePath: ".env" },
            { mode: "context-free" },
        ]) {
            const masked = redactor.redactText(input, options);
            expect(masked.length <= input.length).toBeTruthy();
            expect(
                [...masked.matchAll(/\r|\n/g)].map((found) => found[0]),
            ).toStrictEqual(
                [...input.matchAll(/\r|\n/g)].map((found) => found[0]),
            );
            const inputLines = input.split("\n");
            masked.split("\n").forEach((line, index) => {
                expect(line.length <= inputLines[index].length).toBeTruthy();
            });
            expect(
                redactor.redactText(masked, options),
                JSON.stringify(input),
            ).toBe(masked);
        }
    }
});

test("[properties] the engine imports nothing from Pi or auto-review", async () => {
    const sourceDirectory = fileURLToPath(
        new URL("../../src/", import.meta.url),
    );
    const files = [];
    for (const entry of await readdir(sourceDirectory, { recursive: true }))
        if (entry.endsWith(".ts")) files.push(entry);
    expect(files.length > 5).toBeTruthy();
    for (const file of files) {
        const source = await readFile(join(sourceDirectory, file), "utf8");
        expect(
            /earendil-works|pi-codex-auto-review/.test(source),
            file,
        ).toBeFalsy();
    }
    const manifest = JSON.parse(
        await readFile(
            new URL("../../package.json", import.meta.url),
            "utf8",
        ),
    );
    expect(manifest.dependencies).toBe(undefined);
});
