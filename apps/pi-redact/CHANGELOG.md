# Changelog

## [Unreleased]

### New

- Tool results are masked before Pi stores or shows them, including their details and structured content.
- Every model request, compaction, and branch summary is masked just before it is sent, including text other extensions add.
- Masked values always appear as `{{REDACTED}}`, line by line, and calls that would write the marker into files or commands are blocked.
- Global and trusted-project settings add fields, rules, exceptions, and personal-information entities; `/pi-redact` shows the settings and session counts.
