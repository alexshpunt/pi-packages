# @buyong/pi-redact

**English** | [한국어](README.ko.md)

Masks credentials and private keys before Pi sends them to a language model. Tool results are masked before Pi stores or shows them, and every model request, compaction, and branch summary is checked again just before it is sent. Detected values become `{{REDACTED}}`, and the model is blocked from writing that marker back into files or commands.

Detection comes from [`@buyong/redact`](../../packages/redact): built-in token and credential rules, PEM private keys, sensitive assignments such as `PASSWORD=…`, and personal information only for the entities you select. It does not guarantee that every secret is found. Read [What is not masked](#what-is-not-masked) before relying on it.

## Requirements

- Node.js 22.19 or later.
- Pi 1.3.0. The package is built and tested against `@earendil-works/pi-coding-agent` 1.3.0; earlier versions are not tested.

## Install

Install the published release, then start Pi:

```sh
pi install npm:@buyong/pi-redact
pi
```

To try a local build from this repository for one session:

```sh
pnpm install
pnpm --filter "@buyong/pi-redact..." build
pi -e ./apps/pi-redact
```

Inside Pi, run `/pi-redact` to see the active settings and what was masked in the current session.

## What it does

| When | What pi-redact does |
| --- | --- |
| A tool returns a result (`read`, `bash`, `grep`, MCP tools, …) | Masks the result's text, `details`, and `structuredContent` before Pi stores it in the session file and shows it. A `read` result is scanned with the file's path, so `.env`, `.ini`, `.properties`, and `.cfg` values are masked to the end of the line. |
| Every model request | Masks user messages, assistant text, tool-call arguments, tool results, `!` shell output, extension messages, and summaries in the copy that is sent. It runs after every `context` handler, so text other extensions add is masked too. |
| Compaction and branch summaries | Masks the conversation that Pi summarizes. Pi sends these requests without the context hooks, so they are handled separately. |
| The model calls `write`, `edit`, `bash`, or `powershell` | Blocks the call when it would write `{{REDACTED}}`: a shell command that contains it, a `write` that adds more markers than the file already has, or an `edit` whose replacement adds markers. The model receives the reason and the user sees a warning. |
| Every agent run | Adds one guideline to the system prompt: `{{REDACTED}}` stands for a masked value, must not be written, and the model should edit around it or ask the user. |

Lines prefixed by `grep -n`, `rg`, `cat -n`, numbered viewers, and diffs are scanned again without the prefix, so `.env:2:DB_PASSWORD=value` and `+API_TOKEN=value` are masked like the plain assignment.

### The marker

Every masked span becomes `{{REDACTED}}`, whatever its length. Each masked line is replaced separately and line breaks stay, so line numbers in a masked file still match the file on disk. The model can therefore edit other lines of a file that contains secrets; an edit whose `oldText` includes a masked line simply fails to match.

## What is not masked

- **The system prompt.** `AGENTS.md`, `CLAUDE.md`, and other context files are sent unchanged. Keep secrets out of them.
- **What the user typed and `!` command output in the session file.** They are stored as entered and masked only in what is sent to the model.
- **Images.** Screenshots and image files are not scanned.
- **Thinking blocks.** Provider signatures require them to stay unchanged; they only contain what the model already saw.
- **Live tool output while a command runs.** The final result is masked; partial output streamed to the screen during execution is not.
- **Results of calls one tool makes through another** (for example inside a codemode script). They return to that tool, not the model; the outer tool's result is masked.
- **Model calls other extensions make themselves**, and full bash output that Pi saves to a temporary file when a result is truncated (reading that file with `read` is masked).
- **Formats the rules do not cover.** For example `OPENAI_KEY=…` or `SESSION_KEY=…` (names that end only in `key`), `key=value` pairs in the middle of a log line, and Slack webhook URLs of the form `hooks.slack.com/services/…`. Add [settings](#settings) for the names and patterns you use.
- **Short values written with `*`.** The write guard recognizes only `{{REDACTED}}`.
- **Instructions typed for `/compact` or a tree summary.** Pi passes them to the summarizer separately from the conversation.

### Side effects

- Values under any name ending in `token`, `password`, `secret`, `apikey`, and similar suffixes are masked, including pagination values such as `nextPageToken`. The model cannot pass such a value on.
- A secret you type in the chat is masked before the model sees it, so the model cannot write it into a file. Edit the file yourself, or keep the value in an environment variable and let the model refer to its name.

## Settings

Settings are optional JSON files with the `@buyong/redact` configuration keys. They add to the built-in rules and cannot turn them off; only `exceptions` keep exact values visible.

| File | Applies |
| --- | --- |
| `~/.pi/agent/pi-redact/settings.json` (or `$PI_CODING_AGENT_DIR/pi-redact/settings.json`) | Always |
| `<project>/.pi/pi-redact/settings.json` | Only when the project is trusted in Pi |

```json
{
  "sensitiveFields": ["OPENAI_KEY", "SESSION_KEY"],
  "rules": [{ "id": "custom.env-key", "pattern": "^[A-Z0-9_]*_KEY=(?<secret>.+)$", "flags": "m" }],
  "exceptions": [{ "ruleId": "custom.env-key", "value": "example-value" }],
  "piiEntities": ["EMAIL_ADDRESS"]
}
```

- `sensitiveFields` are exact names compared with letters and digits only, ignoring case (`OPENAI_KEY` matches `openaiKey`).
- `rules[].id` must start with `custom.`; a `secret` group limits masking to that group. Patterns run on untrusted text, so avoid nested repetition.
- `exceptions` keep one exact value visible for one rule id. `piiEntities` turns on the named personal-information entities.
- Project settings add to global settings; a project rule with the same id replaces the global one.
- A file with any problem is skipped as a whole and reported once per session, naming the key and index but never the configured value. Masking then continues with the remaining files and the built-in rules.

Settings are read when a session starts. After editing them, run `/reload` or start a new session.

## When masking fails

pi-redact never sends text it failed to mask:

- A tool result that cannot be masked is replaced with a notice and marked as an error.
- A message in a model request or summary that cannot be masked is replaced with a notice. If even that fails for a model request, the run is aborted and the request carries no conversation.
- If the summary input as a whole cannot be processed, compaction or tree navigation is cancelled instead of summarizing unmasked text.

Each case shows an error once per session, and `/pi-redact` counts it.

## Performance

Masking a model request scans the whole conversation once; later requests reuse the result for text they repeat, up to 8 Mi characters of distinct text. On Node.js 24.14 with an Apple M4 Pro, a 1 million character conversation took about 22 ms the first time and under 1 ms on later requests; 4 million characters took about 75 ms and 1–2 ms. A 50 KB tool result took about 2 ms.

## Verify

From the repository root:

```sh
pnpm install
pnpm --filter "@buyong/pi-redact..." build
pnpm --filter @buyong/pi-redact typecheck
pnpm --filter @buyong/pi-redact lint
pnpm --filter @buyong/pi-redact test:unit
```

The tests run a real Pi session with a scripted model and check the requests it would send, the session file, compaction, branch summaries, and the write guard. To check by hand, create a scratch directory with a `.env` file containing `API_KEY=sk-example0123456789abcd`, start `pi -e <path to apps/pi-redact>` there, and ask the model to read `.env`: the result shows `API_KEY={{REDACTED}}`, and `/pi-redact` reports one masked tool result. This step needs a configured model.

## License

[Apache-2.0](LICENSE)
