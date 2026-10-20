# @buyong/redact

**English** | [한국어](README.ko.md)

Mask credentials, private keys, and selected personal information (PII) before sending text or JSON to logs or language models. This ESM library has no runtime dependencies or process-global configuration. You create an immutable redactor, call it at your output boundary, and pass the masked result downstream.

The library does not intercept logging or model requests, remove original data from memory, or guarantee detection of every secret. PII detection is off unless you select entities.

The engine is a TypeScript port of the redaction module in codemap-search (revision `86a772b`). It keeps the source rule ids, the masking contract, and the configuration rules; the differences are listed under [Differences from the Rust source](#differences-from-the-rust-source).

## Install and mask a value

Requires Node.js 22.19 or later. In your application's directory, install a published release:

```sh
npm install @buyong/redact
```

Use an ESM file (`.mjs`, or `.js` in a package with `"type": "module"`). This is a library, not a Pi extension; use `npm install`, not `pi install`.

## Quick start

Save the following as `mask.mjs` in the application directory, then run `node mask.mjs`. Default rules already cover the sample password and authorization token; custom configuration is not needed for this first result.

```js
import { createRedactor } from "@buyong/redact";

const redactor = createRedactor();

console.log(redactor.redactText('password = "hunter2-value"'));
// password = "[REDACTED]"

const { value, maskedLocations } = redactor.redactJson({
    command: "curl -H 'Authorization: Bearer abcdefgh12345678' https://example.com",
});
console.log(value.command);
// curl -H 'Authorization: Bearer [REDACTED]' https://example.com
// maskedLocations contains JSON paths and rule ids, never matched values.
```

The two printed lines contain masked values, not the sample secrets. For JSON, send the returned `value` downstream: masking does not mutate or make the original object safe to log. `maskedLocations` identifies affected paths/rules without including raw matches.

JSON keys and non-string values stay visible. A sensitive parent key does not make nested objects sensitive; configure the relevant leaf-field names rather than relying on the parent's name.

## Masking contract

- A masked span becomes `[REDACTED]`. A span shorter than the marker becomes `*` repeated, so the output never grows. Lengths are counted in UTF-16 code units (`String.prototype.length`).
- Each line of a span is masked separately, so CR/LF characters and line numbers stay in place.
- Overlapping or touching spans merge before masking.
- Built-in masking preserves its already-masked output. Custom rules can match mask markers, so repeated masking depends on the rules you configure.
- Detections contain a range, rule id, and kind; `maskedLocations` contains a JSON path and rule id. Neither stores the raw match. Configuration issues and error messages do not repeat pattern or exception values.

## API

Choose `redactText` for text output, `redactJson` for payloads, or `redactNamedValue` when the field name is known. For excerpts, scan the full original text once and render a range from that scan; scanning only a fragment can miss a credential that spans its boundary.

| Export | Purpose |
| --- | --- |
| `createRedactor(config?, host?)` | Validate the configuration and return an immutable `Redactor`. Throws `RedactionConfigError` on any issue. |
| `redactor.scan(text, { mode?, filePath? })` | Detect sensitive spans in the full text and return a `TextScan`. |
| `scan.render(text)` / `scan.renderRange(text, start, end)` | Render the same original text, or a range of it, from one full scan. Offsets are UTF-16 indices; do not apply a scan to changed text. |
| `redactor.redactText(text, options?)` | `scan` plus `render`. |
| `redactor.scanNamedValue(name, value)` / `redactor.redactNamedValue(name, value)` | Mask a value; when `name` is a sensitive field, the whole value is masked. |
| `redactor.redactJson(value, options?)` | Mask a JSON-compatible value while keeping object keys, numbers, booleans, and `null`. Returns `{ value, maskedLocations }`. |
| `redactor.isSensitiveField(name)` | Whether a field name is sensitive. |
| `normalizeRedactionConfig(input)` | Return `{ config, issues }` without throwing. An invalid list is replaced by `[]`; inspect `issues` before accepting that fallback. |
| `RedactionConfigError`, `formatIssue(issue)` | Error type and value-free issue text. |
| `hideValue(value)`, `maskRanges(text, ranges)`, `REDACTION_MARKER` | Low-level masking helpers. |
| `isSupportedPiiEntity(name)`, `listSupportedPiiEntities()`, `piiRuleId(entity)` | PII entity lookup. |
| `BUILT_IN_RULE_IDS`, `PRIVATE_KEY_RULE_ID`, `SENSITIVE_FIELD_RULE_ID`, `normalizeFieldName(name)` | Rule ids and field-name normalization. |

### Scan modes

- `full` (default): every rule, label-aware PII, and the assignment fallback.
- `context-free`: rules that do not depend on surrounding text only. Use it for content that was already rendered from a scanned original.

`filePath` is a hint. For `.env`, `.env.*`, and files ending in `.env`, `.ini`, `.properties`, or `.cfg`, the assignment fallback masks the whole line value, including spaces and punctuation.

### JSON options

| Option | Default | Effect |
| --- | --- | --- |
| `stringScope` | `"whole"` | `whole` scans each string at once, so PEM blocks and YAML block scalars spanning lines are found. `line` scans each line alone. |
| `textContent` | `"full"` | `context-free` re-applies only context-free rules to `text` in objects whose `type` is `"text"`. |
| `shouldPreserve(path)` | none | Values at paths for which this returns `true` are copied unchanged, including subtrees. Use it for structural identifiers. |

A string under a sensitive key is masked whole. Numbers, booleans, and `null` remain unchanged. Arrays and objects under a sensitive key do not inherit that sensitivity; their nested strings are scanned independently. Objects with `toJSON` are serialized first, like `JSON.stringify`. `shouldPreserve` deliberately bypasses masking for a subtree, so use it only for values that may remain visible.

## Rules

| Rule id | Kind | Detects |
| --- | --- | --- |
| `token.aws-access-key` | token | `AKIA`/`ASIA` access key ids |
| `token.github` | token | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_` tokens |
| `token.openai` | token | `sk-` keys with 16 or more characters |
| `token.google` | token | `AIza` API keys |
| `token.slack` | token | `xoxb-`, `xoxa-`, `xoxp-`, `xoxr-`, `xoxs-` tokens |
| `token.jwt` | token | JSON Web Tokens starting with `eyJ` |
| `token.stripe` | token | `sk_live_`, `sk_test_`, `rk_live_`, `rk_test_` keys |
| `token.gitlab` | token | `glpat-` tokens |
| `token.npm` | token | `npm_` tokens |
| `token.sendgrid` | token | `SG.` API keys |
| `credential.authorization` | credential | `Authorization`/`Proxy-Authorization` Basic or Bearer values |
| `credential.bearer` | credential | `Bearer` values with 8 or more characters |
| `credential.url-password` | credential | The password in `scheme://user:password@` URLs |
| `credential.webhook-url` | credential | The path after `/hooks/` in HTTP webhook URLs |
| `private-key.pem` | private-key | PEM private key blocks; an unterminated block masks to the end of the text |
| `field.sensitive` | sensitive-field | Values of sensitive fields and assignments |
| `custom.*` | custom | User rules from configuration |
| `host.*` | host | Rules a host registers in code |
| `pii.*` | pii | Opt-in PII entities |

Rules with a `secret` group mask only that group; for example, `credential.url-password` keeps the user name and host visible.

### Sensitive fields

A field name is normalized by keeping letters and digits and lowercasing them (`Api-Key` → `apikey`). It is sensitive when the normalized name ends with `apikey`, `token`, `password`, `passwd`, `pwd`, `secret`, `secretkey`, `privatekey`, `accesskey`, or `accesskeyid`, or when it equals a configured `sensitiveFields` entry after the same normalization.

### Assignment fallback

In `full` mode, `key = value` and `key: value` assignments to sensitive keys mask:

- quoted bodies (`"…"`, `'…'`, backticks, triple quotes, `r`/`b`/`f`/`u`/`@` prefixes, Rust raw strings, doubled-quote escapes);
- YAML block scalars (`|` and `>` headers) by indentation;
- ENV/INI line values when `filePath` says so;
- bare values only when the text before the key on that line is empty, `export`, or ends with a quote, `{`, or `,`, skipping `null`, `None`, `nil`, `true`, `false`, values starting with `$`, `[`, or `{`, and values containing `(`.

## Configuration

The examples below use the `createRedactor` import from the quick start. Options add to built-in rules; they are validated when the instance is created and do not change an existing instance.

```ts
interface RedactionConfig {
    sensitiveFields?: string[]; // exact names after normalization
    rules?: { id: string; pattern: string; flags?: string }[];
    exceptions?: { ruleId: string; value: string }[];
    piiEntities?: string[];
}
```

- `rules[].id` is `custom.` followed by letters, digits, `.`, `_`, or `-`, and must be unique.
- `rules[].pattern` is JavaScript `RegExp` syntax, not Rust syntax. Name the group `(?<secret>…)` to mask only that group. `flags` may contain `i`, `m`, `s`, and `u`, each once; the engine adds `d` and `g`. Inline modifier groups such as `(?i:…)` are not available on Node.js 22. `\b`, `\w`, and `\d` are ASCII-only unless you use Unicode property escapes with the `u` flag.
- A pattern that matches the empty string is rejected. Unknown top-level keys and invalid entries make `createRedactor()` throw `RedactionConfigError`; normalization alone reports issues and returns fallback lists.
- Patterns run on untrusted text. Avoid nested quantifiers that can backtrack catastrophically.
- `exceptions[]` drops a detection only when its rule id matches and the entire original matched value is equal. Quoted values compare without the outer quotes and without decoding escapes. One rule's exception never exempts another rule's overlapping detection.
- Issues report the key and the index only. They never repeat a pattern, an exception value, or a `RegExp` parser message. An unknown top-level key is reported by its name.

### Add sensitive fields and custom rules

Create a separately configured instance when your application has credential names or formats that the defaults do not cover:

```js
const customRedactor = createRedactor({
    sensitiveFields: ["internalCredential"],
    rules: [{ id: "custom.acme", pattern: "ACME_[A-Z0-9]+" }],
    exceptions: [{ ruleId: "custom.acme", value: "ACME_EXAMPLE" }],
});
console.log(customRedactor.redactNamedValue("internalCredential", "credential-value"));
// [REDACTED]
```

The exception keeps the example value visible only for `custom.acme`, not for another overlapping rule. Treat `RedactionConfigError` as a failed configuration; do not discard the error and keep an unreviewed fallback list.

### Host additions

An embedding host can add separately named rules without changing user rule ids:

```js
createRedactor({}, {
    rules: [{ id: "host.legacy-marker", pattern: "SYNTHETIC_[A-Z0-9_]+", flags: "i" }],
    sensitiveFields: ["authorization"],
});
```

Host rules use the `host.` namespace, so they never collide with user `custom.` rules, and they are validated by the same rules. Host fields are exact names, like user `sensitiveFields`.

## PII

PII detection is off by default. List the entities to enable in `piiEntities`:

```js
const piiRedactor = createRedactor({ piiEntities: ["EMAIL_ADDRESS", "IBAN_CODE", "KR_RRN"] });
```

- Entity names are exact and case-sensitive. `listSupportedPiiEntities()` returns all 90 names in catalog order; an unknown name is reported as an issue for its index.
- Each entity reports the rule id `pii.` plus its name lowercased with `_` replaced by `-` (`EMAIL_ADDRESS` → `pii.email-address`). Use that id in `exceptions` to keep a specific value visible.
- With an empty list, the catalog is neither parsed nor compiled.
- The catalog is Presidio's pattern recognizers: regular expressions plus checksum and format validators (Luhn, IBAN, Verhoeff, national-id checksums, base58check, bech32, and others). There is no language model, so names, street addresses, and free-form text are not detected.
- Weak patterns accept a value only when a label for the entity, such as `passport` or `ssn`, appears in the same field or statement within 160 UTF-8 bytes before the value. A label may carry an `id`, `number`, `code`, or `no` suffix (`memberId`, `passportNumber`). These patterns run only in `full` mode; `context-free` mode applies the patterns that need no label.
- PII masking is local and deterministic. Over-masking is possible for values that only look like an identifier, and values in formats outside the catalog are not masked.

## Differences from the Rust source

- Only the text fallback is ported. Tree-sitter syntax decisions (`node_text`, literal mapping, references kept visible by syntax, identifier protection for PII) are not. As a result, a line-leading `password: str = external_value` masks `external_value`, template literals and string concatenations are masked as written, and JSON keys are not escape-decoded.
- There is no enable switch and no request-scoped activation. The caller decides whether to call a redactor.
- There is no detection cache.
- Ranges and the marker-length comparison use UTF-16 code units instead of UTF-8 bytes. A short non-ASCII value such as `한글-비밀번호` becomes `*******` where the source printed `[REDACTED]`.
- `\b`, `\w`, `\d`, and `\s` keep their Unicode meaning through explicit Unicode property classes. The property data comes from the JavaScript runtime, while the source's `regex` 1.13 uses Unicode 16.0. On a runtime using Unicode 17.0, such as this repository's Node.js 24.14.0 environment, newly assigned characters count as letters or digits. A value directly next to one can match differently from the source, usually staying unmasked where the source masks it (`AKIAIOSFODNN7EXAMPLE` followed by U+16EAA). Characters assigned in Unicode 16.0 or earlier behave the same on every supported Node.js version.
- `token.jwt`, `credential.url-password`, `credential.webhook-url`, the assignment fallback, and the PEM end-marker search use linear-time scanners that produce the same matches as the source patterns, because the direct JavaScript translations backtrack quadratically.
- The `EMAIL_ADDRESS` candidate search uses a linear-time scanner with the same results as the catalog pattern, for the same reason.
- PII ranges in `cases.jsonl` are UTF-8 byte offsets; the engine reports the same spans as UTF-16 indices.
- Without tree-sitter identifier protection, a PII match on an identifier is masked: `const member = sha256;` becomes `const member = ******;`.
- `normalizeRedactionConfig` keeps `sensitiveFields` entries as written and normalizes them when matching.
- Configuration layering between repository and global files is not part of the library.

## Build and verify from source

Run from the [pi-packages](https://github.com/buYoung/pi-packages) repository root:

```sh
pnpm install
pnpm --filter @buyong/redact build
pnpm --filter @buyong/redact test:unit
```

The build emits ESM JavaScript and declarations under `packages/redact/dist`. Source-based applications can import that built `dist/index.js`; it is not necessary to load a Pi host. The tests run against that build.

Normal builds and JavaScript tests do not require Rust. The optional Rust differential verification has separate toolchain requirements in `packages/redact/scripts/rust-differential/`; it is not an installation step.

See the [repository release process](https://github.com/buYoung/pi-packages#공통-ci와-패키지별-배포) for independent releases. Release this package before a consumer such as `@buyong/pi-codex-auto-review` that depends on its new version.

## License

[Apache-2.0](LICENSE). Presidio-derived PII data retains its MIT notice in [NOTICE](NOTICE).
