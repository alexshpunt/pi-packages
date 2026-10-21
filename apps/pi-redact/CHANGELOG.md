# Changelog

## [Unreleased]

## [0.1.1] - 2026-10-21

### Improved

- Masking no longer slows down on repeated unterminated private-key headers in JSON or on whitespace-heavy non-matches with healthcare-number detection (`@buyong/redact` 0.1.4).

## [0.1.0] - 2026-10-21

### New

- Tool results are masked before Pi stores or shows them, including their details and structured content.
- Every model request, compaction, and branch summary is masked just before it is sent, including text other extensions add.
- Masked values always appear as `{{REDACTED}}`, line by line, and calls that would write the marker into files or commands are blocked.
- Global and trusted-project settings add fields, rules, exceptions, and personal-information entities; `/pi-redact` shows the settings and session counts.
