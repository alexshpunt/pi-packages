# Changelog

## [Unreleased]

## [0.1.5] - 2026-10-21

### Improved

- The README now states the exact behavior of `normalizeRedactionConfig()`, `maskRanges`, `hideValue`, and host additions, how JSON arrays, `toJSON` values, and multi-line spans are masked, and which custom-pattern syntax Node.js 22 rejects.

## [0.1.4] - 2026-10-21

### Improved

- Keep JSON masking responsive on repeated unterminated private-key headers without changing masked output or location metadata.
- Avoid long delays on whitespace-heavy non-matches when healthcare-number PII detection is enabled.

## [0.1.3] - 2026-10-20

### Improved

- Source code, issues, and release notes moved to the [pi-packages](https://github.com/buYoung/pi-packages) repository.
