# Changelog

## [Unreleased]

### New

- `/redact` shows the masking state, the settings in use, and this session's counts, and turns masking on or off for the current session or as the global default. While masking is off, Pi's status bar shows `redact off`, and the write guard still blocks `{{REDACTED}}`.
- `/redact-custom` edits the global or trusted-project settings: built-in rules, personal-information entities, field names, patterns, and exceptions. Each change is saved and applied at once, and a preview masks a typed line. Without a terminal, it edits the settings JSON in Pi's editor dialog.
- `/redact-analytics` lists what was masked and shows each record's original and masked lines as a diff or as separate before and after views. Records are kept for 30 days in `analytics.sqlite` in the agent directory and contain the original values.
- The global settings file accepts `enabled` and `disabledRules`. pi-redact 0.1.x skips a file that contains them.

### Fixed

- A `read` result's copy for event listeners, such as `pi --mode json` output and RPC clients, is masked with the file's path like its content. Before, a value with spaces in a `.env`, `.ini`, `.properties`, or `.cfg` file kept the part after its first word there, for example `DB_PASSWORD={{REDACTED}} db pass`. The model and the session file were not affected.

### Removed

- `/pi-redact`. `/redact` shows the same status.

## [0.1.2] - 2026-10-21

### Improved

- The README puts the masking check right after installation, shows the notice and error text used when masking fails, and explains when a settings file is skipped and where that is reported.

## [0.1.1] - 2026-10-21

### Improved

- Masking no longer slows down on repeated unterminated private-key headers in JSON or on whitespace-heavy non-matches with healthcare-number detection (`@buyong/redact` 0.1.4).

## [0.1.0] - 2026-10-21

### New

- Tool results are masked before Pi stores or shows them, including their details and structured content.
- Every model request, compaction, and branch summary is masked just before it is sent, including text other extensions add.
- Masked values always appear as `{{REDACTED}}`, line by line, and calls that would write the marker into files or commands are blocked.
- Global and trusted-project settings add fields, rules, exceptions, and personal-information entities; `/pi-redact` shows the settings and session counts.
