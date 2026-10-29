# @buyong/pi-redact

**English** | [한국어](README.ko.md)

A Pi extension that masks credentials and private keys before Pi sends them to a language model. Tool results are masked before Pi stores or shows them, and every model request, compaction, and branch summary is checked again just before it is sent. Detected values become `{{REDACTED}}`, and the model is blocked from writing that marker back into files or commands.

Three pages manage it inside Pi: `/redact` shows the current state and turns masking on or off for the session or by default, `/redact-custom` edits the rules, and `/redact-analytics` shows what was masked, before and after.

Detection comes from [`@buyong/redact`](https://github.com/buYoung/pi-packages/blob/main/packages/redact/README.md): built-in token and credential rules, PEM private keys, sensitive assignments such as `PASSWORD=…`, and personal information for the `piiEntities` you turn on in [Settings](#settings) (off by default). It does not guarantee that every secret is found. Read [What is not masked](#what-is-not-masked) before relying on it.

## Requirements

- Node.js 22.19 or later.
- Pi 1.3.0 or later. The package is tested with `@earendil-works/pi-coding-agent` 1.3.0 and 1.4.0; earlier versions are not tested.

## Install

Install the published release:

```sh
pi install npm:@buyong/pi-redact
```

## Check that masking works

This check needs a model configured in Pi.

1. Create a scratch directory with a `.env` file containing `API_KEY=sk-example0123456789abcd`, start `pi` in that directory, and ask the model to read `.env`. The result shows `API_KEY={{REDACTED}}`.
2. Run `/redact`. The page starts with `Masking is on (this session follows the global default).` and reports `1 tool results masked` for the session.
3. Run `/redact-analytics` and press Enter on the `read` record of `.env`. The diff shows the original line `-1 API_KEY=sk-example0123456789abcd` and the masked line `+1 API_KEY={{REDACTED}}`.

## What it does

| When | What pi-redact does |
| --- | --- |
| A tool returns a result (`read`, `bash`, `grep`, MCP tools, …) | Masks the result's text and `details` before Pi stores them in the session file and shows them, and the `structuredContent` copy that Pi passes to event listeners such as JSON-mode output and RPC clients. A `read` result, that copy included, is scanned with the file's path, so `.env`, `.ini`, `.properties`, and `.cfg` values are masked to the end of the line. |
| Every model request | Masks user messages, assistant text, tool-call arguments, tool results, `!` shell output, extension messages, and summaries in the copy that is sent. It runs after every `context` handler, so text other extensions add is masked too. |
| Compaction and branch summaries (made when you leave a branch with `/tree`) | Masks the conversation that Pi summarizes. Pi sends these requests without the context hooks, so they are handled separately. |
| The model calls `write`, `edit`, `bash`, or `powershell` | The write guard blocks the call when it would write `{{REDACTED}}`: a shell command that contains it, a `write` that adds more markers than the file already has, or an `edit` whose `newText` has more markers than its `oldText`. The model receives the reason and the user sees a warning. |
| Every agent run | Adds one guideline to the system prompt: `{{REDACTED}}` stands for a masked value, must not be written, and the model should edit around it or ask the user. |

While masking is turned off with [`/redact`](#turn-masking-on-or-off), the first three rows stop. The write guard and the guideline stay, because results masked earlier can still contain the marker.

Lines prefixed by `grep -n`, `rg`, `cat -n`, numbered viewers, and diffs are scanned again without the prefix, so `.env:2:DB_PASSWORD=value` and `+API_TOKEN=value` are masked like the plain assignment.

### The marker

Every masked span becomes `{{REDACTED}}`, whatever its length. Each masked line is replaced separately and line breaks stay, so line numbers in a masked file still match the file on disk. The model can therefore edit other lines of a file that contains secrets; an edit whose `oldText` includes a masked line fails to match.

## Pages

| Command | What it opens |
| --- | --- |
| `/redact` | The current state, with switches for this session and the global default. See [Turn masking on or off](#turn-masking-on-or-off). |
| `/redact-custom` | Built-in rules, personal information, field names, patterns, exceptions, and a masking preview. See [Customize the rules](#customize-the-rules). |
| `/redact-analytics` | What was masked, with the original and masked lines. See [See what was masked](#see-what-was-masked). |

The commands take no arguments; every choice is made on the page. In the terminal each page closes with Esc. RPC clients, which have dialogs but no terminal, and modes without a UI get the replacements described in each section. Version 0.2.0 replaced the earlier `/pi-redact` status command with `/redact`.

## Turn masking on or off

`/redact` lists the masking state, the settings files in use, files that were skipped, this session's counts, and the number of analytics records. Below them are two switches; press Enter or Space to change one.

| Switch | Where it is saved | What it affects |
| --- | --- | --- |
| This session | A `pi-redact-session` entry in the session file, which the model does not see | This session only. Resuming the session, `/reload`, and `/tree` restore the choice recorded on the current branch. |
| Global default | `"enabled": false` in the global settings file; turning it on again removes the key | New sessions, and sessions that have no choice of their own |

The session's own choice wins over the global default. A session without one follows the global default, including changes made on the page.

While masking is off:

- Tool results are stored in the session file and sent to the model as they are, and model requests, compaction, and branch summaries are not masked. Nothing is recorded for `/redact-analytics`.
- Results masked while masking was on stay masked: the original values were never stored.
- The write guard still blocks `{{REDACTED}}`, and the system prompt keeps the guideline.
- Pi's status bar shows `redact off`, or `redact off (this session)` when the session's own choice turned it off.

Turning masking on again masks the whole conversation from the next model request. What was already sent, and what the session file already stores unmasked, cannot be changed.

Without a terminal, `/redact` shows the same state as a notification, then offers the two switches in a selection dialog until you choose `Close`. Without any UI, it prints the state to stderr.

## Customize the rules

`/redact-custom` edits one settings file at a time. Every change is checked, saved, and applied to the running session at once; `/reload` is not needed.

| Row | What you can do |
| --- | --- |
| Settings file | Choose `global` or `project`. `project` is offered only in a trusted project. |
| Built-in rules | Turn off one of the 16 built-in rules, for example `token.jwt` when the model must pass a token on. Only the global file can do this, because it weakens masking. |
| Personal information | Turn on personal-information entities; type to search the 90 names. |
| Sensitive field names | Add, edit, or remove exact field names such as `OPENAI_KEY`. |
| Custom patterns | Add, edit, or remove regular expressions. The form asks for the id (`custom.` is added when missing), the pattern, and optional flags. |
| Exceptions | Keep one exact value visible for one rule. The form offers the built-in rule ids and the ids of this file's patterns and personal-information entities. |
| Try masking | Type a line and see the masked result as a diff, with the rules that matched. The saved settings apply, whether masking is on or off. The line is neither stored nor sent. |

An entry the library rejects, such as an invalid pattern, is not saved, and the form shows the reason. A settings file that is invalid on disk cannot be edited on the page; the page names its problems so you can fix or delete it.

Without a terminal, `/redact-custom` opens the file's JSON in Pi's editor dialog, after asking which file when the project's file is also available. The text is saved only when it is a valid settings file; otherwise the dialog opens again with your text and a notification gives the reason. Without any UI, the command prints the paths of the settings files to stderr.

## See what was masked

`/redact-analytics` lists what pi-redact masked, newest first, with the step (tool result, model request, compaction, or branch summary), a label such as `read .env` or `user message`, and the rules that matched. Above the list are the number of records and masked lines and the records per rule.

- Tab switches between this session and all sessions of the last 30 days.
- Enter opens a record. It shows the changed lines with two lines of context, as a diff in the style of Pi's edit tool. Tab switches to separate before and after views. Use ↑ and ↓ to scroll, PgUp and PgDn to move a page, and Esc to go back.
- `d` deletes the records in the current view after you confirm with Enter.

What is recorded:

- Each text that masking changed, once per session and step. The same text in a later request, or in a `read` result's `content` and `structuredContent`, adds no record.
- At most 300 lines per record, context included. In a line longer than 400 characters, only the changed part (up to 1,000 characters) and up to 80 characters on each side are kept.
- Records are kept in `~/.pi/agent/pi-redact/analytics.sqlite` (or under `$PI_CODING_AGENT_DIR`), a SQLite file created readable only by you (mode 0600 on macOS and Linux). Every Pi session and subagent that uses the same agent directory writes to it.
- Records older than 30 days are hidden and then deleted. The period is fixed. At most the newest 50,000 records are kept.

> [!WARNING]
> The records contain the original values, so the analytics file holds your secrets on disk for up to 30 days. Delete records with `d`, or delete the file while Pi is not running.

If a record cannot be saved, masking continues and pi-redact warns once per session with `pi-redact: masked content could not be saved for /redact-analytics: <reason>`. Without a terminal, `/redact-analytics` reports this session's totals and the newest five records as text diffs.

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

Settings are optional JSON files. [`/redact-custom`](#customize-the-rules) edits them for you; you can also edit them by hand. They use the `@buyong/redact` configuration keys, which add to the built-in rules, plus two keys of pi-redact itself that only the global file may contain.

| File | Applies |
| --- | --- |
| `~/.pi/agent/pi-redact/settings.json` (or `$PI_CODING_AGENT_DIR/pi-redact/settings.json`) | Always |
| `<project>/.pi/pi-redact/settings.json` | Only when you trust the project in Pi (at Pi's startup prompt or with `/trust`) |

```json
{
  "enabled": true,
  "disabledRules": ["token.jwt"],
  "sensitiveFields": ["OPENAI_KEY", "SESSION_KEY"],
  "rules": [{ "id": "custom.env-key", "pattern": "^[A-Z0-9_]*_KEY=(?<secret>.+)$", "flags": "m" }],
  "exceptions": [{ "ruleId": "custom.env-key", "value": "example-value" }],
  "piiEntities": ["EMAIL_ADDRESS"]
}
```

- `enabled` is the global default of [`/redact`](#turn-masking-on-or-off); `false` turns masking off for sessions without their own choice. `disabledRules` lists built-in rule ids to ignore: the 14 token and credential rules, `private-key.pem`, and `field.sensitive`. A project file that contains either key is skipped as a whole. pi-redact 0.1.x does not know these keys and skips a file that contains them.
- `sensitiveFields` are exact names compared with letters and digits only, ignoring case (`OPENAI_KEY` matches `openaiKey`).
- `rules[].id` must start with `custom.`. A rule masks its whole match, or only the named group `(?<secret>…)` when the pattern has one. Patterns run on untrusted text, so avoid nested repetition.
- `exceptions` keep one exact value visible for one rule id. `piiEntities` turns on the named personal-information entities. The `@buyong/redact` README lists the built-in rule ids under [Rules](https://github.com/buYoung/pi-packages/blob/main/packages/redact/README.md#rules), the entity names under [PII](https://github.com/buYoung/pi-packages/blob/main/packages/redact/README.md#pii), and the pattern syntax and allowed `flags` under [Configuration](https://github.com/buYoung/pi-packages/blob/main/packages/redact/README.md#configuration).
- Project settings add to global settings; a project rule with the same id replaces the global one.
- A missing file is skipped without a message. A file that exists but cannot be read, is not valid JSON, or contains an invalid setting is skipped as a whole. pi-redact shows a warning once per session (on stderr when Pi has no UI), and `/redact` lists the file under `Skipped:`. The report names the setting key and array index, never the configured value. Masking then continues with the remaining files and the built-in rules.

Settings are read when a session starts and after every change made on `/redact` or `/redact-custom`. After editing a file by hand, run `/reload` or start a new session. The pages write the file again with two-space indentation and leave out defaults and empty lists.

## When masking fails

pi-redact never sends text it failed to mask. The notice that replaces such text is `[pi-redact withheld this content because masking it failed]`.

- A tool result that cannot be masked is replaced with the notice and marked as an error.
- A message in a model request or summary that cannot be masked is replaced with the notice. If even that fails for a model request, pi-redact aborts the run and replaces the request's conversation with a single notice.
- If the summary input as a whole cannot be processed, compaction or the `/tree` navigation is cancelled instead of summarizing unmasked text.

Each case shows the error `pi-redact: masking failed for <where>; the affected content was withheld instead of sent` once per session, where `<where>` is, for example, `a bash result`, `a model request`, `compaction`, or `a branch summary`. `/redact` counts the withheld items.

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

The tests run a real Pi session with a scripted model and check the requests it would send, the session file, compaction, branch summaries, the write guard, the switches, and the analytics records. They do not drive the terminal pages.

To check an installed copy in Pi, run `pi list`: it shows `npm:@buyong/pi-redact` under `User packages:`. Then type `/redact` in Pi; autocomplete lists `redact`, `redact-custom`, and `redact-analytics`.

## License

[Apache-2.0](LICENSE)
