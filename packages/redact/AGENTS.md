# AGENTS.md

<!-- agents-md-generator: v1; doc-type: single_repo -->

## 1. Overview

Redact creates masked presentation copies of text and JSON containing credentials, private keys, or explicitly selected personal information. Callers choose where to apply it; the library does not intercept I/O or guarantee that every sensitive value is detected.

## 2. Ownership Map

### Stable Ownership Boundaries

- **Public configuration.** `src/config.ts` validates inputs, `src/redactor.ts` creates immutable instances, and `src/index.ts` defines exports. Preserve separate user/host rule namespaces and diagnostics that do not reveal configured values. Check invalid-configuration and host-independence cases in `tests/unit/redaction.test.mjs`.
- **Text masking.** `src/rules.ts` owns built-in patterns and PEM detection; `src/text.ts` handles assignment fallback; `src/transform.ts` renders spans. `src/detection.ts` applies exceptions before merging. Verify original UTF-16 positions, line endings, and non-growing output through core-parity, Unicode, capture-group, linear-time, and property cases.
- **JSON copies.** `src/json.ts` owns sensitive fields, preservation callbacks, and changed-location metadata. The returned copy must reach the consumer instead of the original. Check JSON cases and Auto Review's reviewer tests. Auto Review's stronger legacy whole-value withholding belongs in its adapter, not this library's defaults.
- **Personal-information detection.** Start in `src/pii/index.ts` for selection and in `patterns.ts`, `context.ts`, `regex.ts`, or `validators/` for acceptance. `scripts/generate-pii-data.mjs` produces distributable constants from vendor data. Keep catalog order, validator semantics, and `NOTICE` attribution aligned with `tests/unit/redaction-pii.test.mjs`. The Rust comparison harness is optional development tooling, not a runtime dependency.

## 3. Core Behaviors & Patterns

### Configuration and scanning

- `normalizeRedactionConfig()` returns frozen configuration and issues. One invalid member empties its entire list; unknown keys also produce issues. `createRedactor()` rejects any user or host issue rather than silently using that empty fallback. User IDs must be unique `custom.*` names; host IDs must be unique `host.*` names.
- User regex flags allow i/m/s/u once each; matchers add d/g. Reject malformed regexes and patterns matching an empty input. This does not establish a general complexity bound for arbitrary custom expressions. Diagnostics identify keys/indexes with fixed explanations, never configured patterns, exception values, or raw regex-parser errors.
- Compile rules, normalized field names, exceptions, and selected PII when creating an instance. There is no global configuration, activation flag, or detection cache. `full` scans patterns, PEM, contextual PII, and assignments. `context-free` excludes assignments and label-dependent PII. Named-value scanning adds whole-string sensitive-name detection to patterns/PEM/PII but does not run assignment fallback. Built-in sensitive suffixes and explicitly added exact field names remain separate mechanisms.
- `scan()` returns immutable detections over one original string. `renderRange()` intersects those spans with a requested range but does not verify text identity. Apply the result only to the unchanged original; never reuse its offsets against an already masked string. Positions are half-open UTF-16 offsets, not UTF-8 bytes.
- A nonempty regex group named `secret` selects the masked portion; otherwise mask the whole match. A PEM block extends through its matching END marker or to EOF if unclosed.

### Assignment, exception, and rendering rules

- Sensitive-key quoted values support prefixes, raw/triple quotes, and doubled quotes; an unclosed value extends to EOF. YAML blocks end by indentation. With `.env`, `.env.*`, or env/ini/properties/cfg hints, mask a line value including spaces and punctuation up to `#` or the line ending, but skip values beginning with `$`.
- General bare values require an empty prefix, export, a quote, `{`, or `,` before the key. Exclude null/boolean tokens, values beginning with `$`, `[` or `{`, and values containing parentheses. This is text fallback, not syntax parsing or protection for reference identifiers.
- An exception removes only a detection with the same rule ID and exactly matching original span value. Compare quoted assignment values without their outer quotes and without unescaping. Overlapping detections from other rules remain. Only afterward merge overlapping or touching spans.
- Render each line independently. Use `[REDACTED]` when it fits, otherwise `*`; preserve LF and trailing CR without increasing output length. Existing property cases exercise built-in idempotence, length, and line-ending behavior. Arbitrary custom patterns may also match a masking marker, so do not generalize that idempotence guarantee to them.

### Structured data

- `redactJson()` returns `{ value, maskedLocations }` without mutating input. Keys and non-string scalars remain unchanged. A sensitive key masks its string value, but does not propagate sensitivity to array/object descendants.
- Honor `toJSON` and construct own properties so `__proto__` remains data. `shouldPreserve(path)` bypasses an entire subtree, including serialization; use it only for explicitly safe structural positions.
- `stringScope: whole` supports multiline detection; `line` scans each line independently. `textContent: context-free` applies only to the text of a `type: text` object, and sensitive-field handling takes precedence. Report deduplicated path/rule metadata only where output actually changed; once a rule has changed a string, skip further span transformations for that rule when computing metadata.

### PII and regex compatibility

- Empty `piiEntities` avoids catalog parsing and compilation. Entity names are exact and case-sensitive. Each redactor compiles selected entities once in catalog order. Candidate discovery is followed by sticky/indexed matching at the original position, then left-boundary, context, entity-filter, and validator checks. The email optimization applies only to the exact known catalog pattern. Healthcare-labelled separators are rewritten in `accelerators.ts` for both candidate search and anchored verification, preserving captures and catalog data. Do not replace this with a loose regex over sliced candidates.
- Weak and field patterns require a label within the preceding 160 UTF-8 bytes of the same field/sentence. A previous line can supply it only through a continuing assignment/label ending in `=` or `:`, followed solely by whitespace/quotes before the value. Context-free mode excludes these patterns altogether.
- Validators normalize numeric characters. `false` rejects; `undefined` means unverified but accepted. Unknown validator names fail. IBAN handling checks complete token endings, prefers a valid exact country length, and otherwise uses the first valid fallback. Resume scanning at the accepted end to retain adjacent matches.
- Production `detect()` trims outer URL quotes and VAT trailing delimiters. Compatibility `find()` skips field patterns and does not enforce labels; it is not the production acceptance path.
- `translateRustRegex()` translates supported Unicode classes, boundaries, and LF anchors explicitly and rejects unsupported syntax. Custom patterns remain ordinary JavaScript regexes. Respect the minimum supported Node syntax and differences between runtime Unicode versions.
- Keep dedicated linear scanners for JWTs, URL passwords, webhooks, PEM, assignments, and email; replacing them with simple-looking regexes can restore quadratic behavior. PII catalog data ships as string constants for host-loader compatibility rather than runtime JSON reads. Change vendor inputs/generation, not generated snapshots. Detection uses no NLP, model calls, or network lookups.

## 4. Conventions

- Detection records contain `{ start, end, ruleId, kind }`; JSON locations contain `{ path, ruleId }`. Do not add original values. `piiRuleId("EMAIL_ADDRESS")`, for example, produces `pii.email-address`.
- Preserve external catalog keys such as `requires_context` and translate them at typed boundaries. Shared numeric/checksum logic belongs in `src/pii/validators/`; regional decisions belong with their validator.
- Use strict ESM TypeScript, `.js` relative imports, readonly interfaces, and frozen public configuration/scan values. Keep Pi and host-specific policy out of this dependency-free runtime.
- State relevant limits when changing detection: missed values, Rust-byte versus UTF-16 offsets, non-parser assignment fallback, and engine differences for custom regexes. Masking is not a universal disclosure guarantee.

## 5. Working Agreements

Apply the [root working agreements](../../AGENTS.md). After code changes, run `pnpm typecheck` from this package directory. Existing unit verification consumes built `dist/`. Fixture checks under `tests/fixtures/redaction` and optional Rust differential checks establish different evidence; TypeScript verification alone cannot prove engine equivalence.
