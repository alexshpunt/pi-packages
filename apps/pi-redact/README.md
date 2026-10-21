# @buyong/pi-redact

**English** | [한국어](README.ko.md)

A Pi extension that masks credentials and private keys before Pi sends them to a language model. Tool results are masked before Pi stores or shows them, and every model request, compaction, and branch summary is checked again just before it is sent. Detected values become `{{REDACTED}}`, and the model is blocked from writing that marker back into files or commands.

Detection comes from [`@buyong/redact`](https://github.com/buYoung/pi-packages/blob/main/packages/redact/README.md): built-in token and credential rules, PEM private keys, sensitive assignments such as `PASSWORD=…`, and personal information for the `piiEntities` you turn on in [Settings](#settings) (off by default). It does not guarantee that every secret is found. Read [What is not masked](#what-is-not-masked) before relying on it.

## Requirements

- Node.js 22.19 or later.
- Pi 1.3.0. The package is built and tested against `@earendil-works/pi-coding-agent` 1.3.0; earlier versions are not tested.

## Install

Install the published release:

```sh
pi install npm:@buyong/pi-redact
```

## Check that masking works

This check needs a model configured in Pi. Create a scratch directory with a `.env` file containing `API_KEY=sk-example0123456789abcd`, start `pi` in that directory, and ask the model to read `.env`. The result shows `API_KEY={{REDACTED}}`. Then run `/pi-redact`: it shows the active settings and reports one masked tool result for the session.

## What it does

| When | What pi-redact does |
| --- | --- |
| A tool returns a result (`read`, `bash`, `grep`, MCP tools, …) | Masks the result's text, `details`, and `structuredContent` before Pi stores it in the session file and shows it. A `read` result is scanned with the file's path, so `.env`, `.ini`, `.properties`, and `.cfg` values are masked to the end of the line. |
| Every model request | Masks user messages, assistant text, tool-call arguments, tool results, `!` shell output, extension messages, and summaries in the copy that is sent. It runs after every `context` handler, so text other extensions add is masked too. |
| Compaction and branch summaries (made when you leave a branch with `/tree`) | Masks the conversation that Pi summarizes. Pi sends these requests without the context hooks, so they are handled separately. |
| The model calls `write`, `edit`, `bash`, or `powershell` | The write guard blocks the call when it would write `{{REDACTED}}`: a shell command that contains it, a `write` that adds more markers than the file already has, or an `edit` whose `newText` has more markers than its `oldText`. The model receives the reason and the user sees a warning. |
| Every agent run | Adds one guideline to the system prompt: `{{REDACTED}}` stands for a masked value, must not be written, and the model should edit around it or ask the user. |

Lines prefixed by `grep -n`, `rg`, `cat -n`, numbered viewers, and diffs are scanned again without the prefix, so `.env:2:DB_PASSWORD=value` and `+API_TOKEN=value` are masked like the plain assignment.

### The marker

Every masked span becomes `{{REDACTED}}`, whatever its length. Each masked line is replaced separately and line breaks stay, so line numbers in a masked file still match the file on disk. The model can therefore edit other lines of a file that contains secrets; an edit whose `oldText` includes a masked line fails to match.

## What is not masked

- **The system prompt.** `AGENTS.md`, `CLAUDE.md`, and other context files are sent unchanged. Keep secrets out of them.
- **Session-file copies of user input and `!` command output.** The session file stores them as entered; they are masked only in what is sent to the model.
- **Images.** Screenshots and image files are not scanned.
- **Thinking blocks.** Provider signatures require them to stay unchanged; they only contain what the model already saw.
- **Live tool output while a command runs.** The final result is masked; partial output streamed to the screen during execution is not.
- **Results of calls one tool makes through another** (for example inside a codemode script). They return to that tool, not the model; the outer tool's result is masked.
- **Model calls other extensions make themselves.**
- **Full bash output that Pi saves to a temporary file** when a result is truncated. Reading that file with `read` is masked.
- **Formats the rules do not cover.** For example `OPENAI_KEY=…` or `SESSION_KEY=…` (names that end only in `key`), `key=value` pairs in the middle of a log line, and Slack webhook URLs of the form `hooks.slack.com/services/…`. Add [settings](#settings) for the names and patterns you use.
- **Text that another tool masked with `*`.** For example, `@buyong/redact` itself renders short values as `*`. The write guard blocks only `{{REDACTED}}`, so the model can still write such a placeholder into a file or command.
- **Instructions you type for `/compact` or for a `/tree` branch summary.** Pi passes them to the summarizer separately from the conversation.

### Side effects

- The value of any field or assignment whose name ends in `apikey`, `token`, `password`, `passwd`, `pwd`, `secret`, `secretkey`, `privatekey`, `accesskey`, or `accesskeyid` is masked, as in JSON fields and `key=value` or `key: value` assignments. Names are compared with letters and digits only, ignoring case. This includes pagination values such as `nextPageToken`, so the model cannot pass such a value on.
- A secret you type in the chat is masked before the model sees it, so the model cannot write it into a file. Edit the file yourself, or keep the value in an environment variable and let the model refer to its name.

## Settings

Settings are optional JSON files with the `@buyong/redact` configuration keys. They add to the built-in rules and cannot turn them off; only `exceptions` keep exact values visible.

| File | Applies |
| --- | --- |
| `~/.pi/agent/pi-redact/settings.json` (or `$PI_CODING_AGENT_DIR/pi-redact/settings.json`) | Always |
| `<project>/.pi/pi-redact/settings.json` | Only when you trust the project in Pi (at Pi's startup prompt or with `/trust`) |

```json
{
  "sensitiveFields": ["OPENAI_KEY", "SESSION_KEY"],
  "rules": [{ "id": "custom.env-key", "pattern": "^[A-Z0-9_]*_KEY=(?<secret>.+)$", "flags": "m" }],
  "exceptions": [{ "ruleId": "custom.env-key", "value": "example-value" }],
  "piiEntities": ["EMAIL_ADDRESS"]
}
```

- `sensitiveFields` are exact names compared with letters and digits only, ignoring case (`OPENAI_KEY` matches `openaiKey`).
- `rules[].id` must start with `custom.`. A rule masks its whole match, or only the named group `(?<secret>…)` when the pattern has one. Patterns run on untrusted text, so avoid nested repetition.
- `exceptions` keep one exact value visible for one rule id. `piiEntities` turns on the named personal-information entities. The `@buyong/redact` README lists the built-in rule ids under [Rules](https://github.com/buYoung/pi-packages/blob/main/packages/redact/README.md#rules), the entity names under [PII](https://github.com/buYoung/pi-packages/blob/main/packages/redact/README.md#pii), and the pattern syntax and allowed `flags` under [Configuration](https://github.com/buYoung/pi-packages/blob/main/packages/redact/README.md#configuration).
- Project settings add to global settings; a project rule with the same id replaces the global one.
- A missing file is skipped without a message. A file that exists but cannot be read, is not valid JSON, or contains an invalid setting is skipped as a whole. pi-redact shows a warning once per session (on stderr when Pi has no UI), and `/pi-redact` lists the file under `Skipped:`. The report names the setting key and array index, never the configured value. Masking then continues with the remaining files and the built-in rules.

Settings are read when a session starts. After editing them, run `/reload` or start a new session.

## When masking fails

pi-redact never sends text it failed to mask. The notice that replaces such text is `[pi-redact withheld this content because masking it failed]`.

- A tool result that cannot be masked is replaced with the notice and marked as an error.
- A message in a model request or summary that cannot be masked is replaced with the notice. If even that fails for a model request, pi-redact aborts the run and replaces the request's conversation with a single notice.
- If the summary input as a whole cannot be processed, compaction or the `/tree` navigation is cancelled instead of summarizing unmasked text.

Each case shows the error `pi-redact: masking failed for <where>; the affected content was withheld instead of sent` once per session, where `<where>` is, for example, `a bash result`, `a model request`, `compaction`, or `a branch summary`. `/pi-redact` counts the withheld items.

## Performance

Masking a model request scans the whole conversation once; later requests reuse the result for text they repeat, up to 8,388,608 characters (8 × 1024 × 1024) of distinct text. On Node.js 24.14 with an Apple M4 Pro, a 1 million character conversation took about 22 ms the first time and under 1 ms on later requests; 4 million characters took about 75 ms and 1–2 ms. A 50 KB tool result took about 2 ms.

## Build from source and run checks

Run these from the root of a [pi-packages](https://github.com/buYoung/pi-packages) checkout. To try a local build for one session:

```sh
pnpm install
pnpm --filter "@buyong/pi-redact..." build
pi -e ./apps/pi-redact
```

To run the automated checks:

```sh
pnpm install
pnpm --filter "@buyong/pi-redact..." build
pnpm --filter @buyong/pi-redact typecheck
pnpm --filter @buyong/pi-redact lint
pnpm --filter @buyong/pi-redact test:unit
```

The tests run a real Pi session with a scripted model and check the requests it would send, the session file, compaction, branch summaries, and the write guard.

## License

[Apache-2.0](LICENSE)
