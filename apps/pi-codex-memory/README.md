# @buyong/pi-codex-memory

**English** | [한국어](README.ko.md)

A Pi extension that saves project decisions and context from your conversations and brings them back in later sessions. It is for Pi users who work on one project across many sessions. If you decide today to "switch the release gate to `amber`," then days later, when you ask "what did we pick for the release gate?" in a new session, the agent reads the memory and answers with a citation.

It adapts the extraction and consolidation design of [Codex memory v2](https://github.com/openai/codex/tree/4610b573e59b211bf9430cf6ffb97cfb84623090/codex-rs/memories) to Pi's model providers and SQLite storage. You don't need the Codex CLI, and it doesn't use Codex's database.

## Requirements

| Component | Requirement |
| --- | --- |
| Pi | 1.4.0 or later |
| Node.js | 22.19 or later |
| pnpm | 10, for building from source |
| Models | Models available in Pi, the current Pi model by default. Needed only for creating memories. |

## Install

Install from npm:

```sh
pi install npm:@buyong/pi-codex-memory
```

Or build from the repository source and register the local package with Pi:

```sh
git clone https://github.com/buYoung/pi-packages.git
cd pi-packages
pnpm install
pnpm --filter "@buyong/pi-codex-memory..." build
pi install ./apps/pi-codex-memory
```

After installation, start Pi and the `/codex-memory` and `/codex-memory-settings` commands are available. To remove the extension, use `pi remove npm:@buyong/pi-codex-memory` for an npm installation or `pi remove ./apps/pi-codex-memory` for a local installation. Your stored memories remain.

The `@buyong/pi-codex` bundle also includes this extension. Do not enable both the bundle and this package.

## Quick start

This walkthrough uses the verification settings to create a memory and bring it back in a new session: `claude-haiku-5-5 [claude-bridge]` as both the memory and summary model, with the default timing. The `claude-bridge` provider comes from the [@buyong/pi-claude-bridge](https://github.com/buYoung/pi-packages/blob/main/apps/pi-claude-bridge/README.md) extension, so install it first by following its instructions. Each model list starts with **Use current Pi model**, followed by the models chosen in Pi's `/scoped-models`, or every available model when none are chosen, so make sure the model you want is there.

Memory sends masked copies of your conversations to the memory and summary models, which uses your provider quota or costs money. Masking does not catch every private value.

### 1. Turn memory on

1. Start Pi in the project folder where you want memory, and run `/codex-memory`. The page looks like Pi's `/settings`: **Enabled**, **Memory model**, **Summary model** and **Memory scope**, with the highlighted row explained underneath. Both models start as **Current Pi model**, which follows the model selected for the main task.
2. On **Memory model**, press Enter, type `haiku` and pick `claude-haiku-5-5 [claude-bridge]`. Do the same on **Summary model**. The memory model extracts with `low` reasoning, and the summary model consolidates with `medium`. If a model does not offer that level, the nearest level it offers is used.
3. On **Enabled**, press Enter to change it to `on`.
4. Approve **Send conversations to create memories?**, which shows the models.

The notification "Memory is on. A closed conversation becomes memory 2 hours after its last message." confirms it worked.

### 2. Turn a decision into memory

1. Record a decision in the conversation, for example: `We decided to switch the release gate to amber. This applies to this project only.`
2. Run `/codex-memory-settings`, choose **Remember this conversation now**, and approve. This row appears only while memory is on, and creates memory now instead of after the conversation closes.
3. When it finishes, a notification says "Created memories from 1 conversation(s)."
4. Run `/codex-memory` and open **Saved memories** to see what was saved.

### 3. Bring it back in a new session

1. In the same project, open a new session with `/new`.
2. Ask `What did we pick for the release gate?`

The agent sees a memory summary with each request and searches and reads memory when it needs more. If it used memory, it answers `amber` and cites the source at the end of the answer, and the status bar shows the citation:

```text
Memory: on · 1 cited
```

`1 cited` appears only when the last answer cited memory that the agent actually read; a citation that does not match what was read shows a warning instead. While a memory job runs in any Pi session of the scope, every session shows it, for example `Memory: on · creating 3 memories…` or `Memory: on · updating summary…`; other sessions catch up within 30 seconds. `update failed` means a memory job failed and has not succeeded since.

Memory is a record of past conversations. It does not prove the code is still in that state, so check important points against the code.

## Everyday use

While memory is on, conversations become memory in the background after you close them. One open Pi session per memory scope coordinates this work; when it closes, another open session takes over within about 90 seconds. Nothing is processed while no Pi session is open.

- A conversation becomes memory once it is closed and 2 hours have passed since its last message. A conversation left open waits until you close it.
- Up to 8 conversations are processed at once.
- New memories are merged into the summary once no conversation is waiting, at most once every 2 hours.
- Typing in Pi stops only **Remember this conversation now**; background jobs read closed conversations and keep running.

While memory is on in its scope or in Personal, each Pi session records every 30 seconds that it is open. A conversation counts as closed once that record has not been renewed for 90 seconds, for example after you quit Pi or it crashes. A conversation open in a Pi without this extension counts as closed.

To save something right away, ask the agent to "remember" it; a confirmation shows the exact text before it is saved. To save the whole conversation, use **Remember this conversation now** in `/codex-memory-settings`. To turn closed conversations into memory without waiting 2 hours, choose **Create memories now** in `/codex-memory`, then pick a range:

- **All closed conversations** ignores the age limit for this run.
- **Last 7 days** uses **Use conversations from the last**; the label shows your configured number of days and is selected by default.

Both choices process only closed conversations in the current memory scope and update the summary right away. Unchanged conversations and forgotten memories are not regenerated. The choice does not change saved settings or automatic generation. Esc returns to the memory page without starting a job.

Turning memory off keeps saved memories but neither uses nor creates them.

### Fix a wrong memory

Run `/codex-memory` and open **Saved memories**. Type to filter the list by text, pick a memory, and choose **View memory and source**, **Edit memory** or **Forget memory**. Afterwards the list opens again with the same filter, so you can go on to the next memory; Esc returns to `/codex-memory`. These actions do not call a model.

- Edited or forgotten memories leave the summary and search results immediately.
- A forgotten memory is not created again from the same conversation. Original sessions, provider-side copies and other conversations with the same fact are not erased.

## Commands

Both commands take no arguments and open a page laid out like Pi's `/settings`. Enter or Space changes a row, the highlighted row is explained underneath, and Esc closes the page.

| Command | Rows |
| --- | --- |
| `/codex-memory` | **Enabled**, **Memory model**, **Summary model**, **Memory scope**, **Saved memories**, and while memory is on **Create memories now** (or **Stop current job** while a job runs) |
| `/codex-memory-settings` | **Remember this conversation now** (or **Stop current job** while a job runs), **Show what failed** after a failure, **Create memories after**, **Update the summary every**, **Use conversations from the last**, **Delete unused memories after**, **Other repositories** and **Forget all memories in this scope** |

Opening a page does not stop a running job. Without a UI, both commands print the status as JSON and change nothing.

The agent reads memory with `pi_codex_memory_list`, `pi_codex_memory_search` and `pi_codex_memory_read`, and saves what you ask it to remember with `pi_codex_memory_note`.

## Who shares memory

Subfolders and worktrees of one Git repository share memory and settings. Separate clones, nested repositories and submodules each keep their own. Outside Git, each folder keeps its own. Because settings are also per scope, you must turn memory on again in another repository.

Scopes are identified by the repository's local path. Moving the repository folder disconnects it from its existing memory, and placing a different repository at the same path inherits the old memory.

To share one memory across folders, run `/codex-memory` and change **Memory scope** to **Personal**. Every folder set to Personal shares that memory and its settings. Changing scope does not copy or merge existing memories.

### Read another repository's memory

For example, to check what was decided in `shop-api` while working in `shop-web`:

1. In `shop-web`, run `/codex-memory-settings` and open **Other repositories**.
2. Pick `shop-api`. If you have not opened Pi in `shop-api` since installing this extension, it is not listed; pick **+ Add repository** and enter its folder path.
3. Choose **Always allow reads** to let the agent read it without asking, or **Ask each time** to confirm each read, then approve.
4. Ask the agent with the repository named, for example "find the auth method in shop-api's memory." With **Ask each time**, a confirmation appears now.

Access goes one way. Letting `shop-web` read `shop-api` does not let `shop-api` read `shop-web`. Another repository's memory is only read; it is never added to the summary, copied or edited.

## Storage and defaults

Memories are stored in `~/.pi/agent/pi-codex-memory/`, not in your project. If you set `PI_CODING_AGENT_DIR`, they are stored under that directory instead. `state.sqlite` is the source of truth; the Markdown files under `scopes/` are copies generated from it. Manage memories with **Saved memories** in `/codex-memory` instead of editing the Markdown.

Settings are saved per scope. In `/codex-memory-settings`, Enter or Space cycles a value and saves it right away; a change stops a running memory job and applies from the next job.

| Setting | Default | Values | What it changes |
| --- | --- | --- | --- |
| Create memories after | 2 hours idle | 15 minutes, 30 minutes, 60 minutes, 2 hours, 6 hours | How long after its last message a closed conversation becomes memory. A shorter wait makes memories appear sooner, but a conversation you reopen and continue is extracted again. |
| Update the summary every | 2 hours | 15 minutes, 30 minutes, 60 minutes, 2 hours, 3 hours, 6 hours | New memories can be searched right away; this is how often they are merged into the summary sent with each request. |
| Use conversations from the last | 7 days | 1, 3, 7, 14, 30 days | Conversations whose last message is older are skipped, except when you choose **All closed conversations** for a manual run. |
| Delete unused memories after | 30 days | 7, 30, 90, 365 days | Memories you asked the agent to save and memories you edited are kept. |

These are fixed: up to 8 conversations at once, 256 KiB of input per model call and a 12 KiB summary per request.

For how the defaults were chosen and when to change them, see the [verification report](docs/verification.md#how-the-defaults-were-chosen).

## Verification

Every code change runs 124 tests, a TUI smoke check and a package check, all without a model. With real models, a scenario set six facts in a 16-turn conversation and asked for them again in a new session. With memory on, both tested models (Haiku and Luna) answered all six; with memory off, neither answered any. Another check ran several real Pi processes: only closed conversations became memory, each once, and another session took over when the coordinating process was killed. The commands, token use and limits are in the [verification report](docs/verification.md).

From the repository root, after installing dependencies:

```sh
pnpm --filter "@buyong/pi-codex-memory..." build
pnpm --filter @buyong/pi-codex-memory typecheck
pnpm --filter @buyong/pi-codex-memory test
python3 apps/pi-codex-memory/verification/tui-smoke.py
```

These checks require no model account. The TUI check requires `pi` on `PATH` and verifies range selection, cancellation and an empty run.

## License

[Apache-2.0](LICENSE). Attribution is in [NOTICE](NOTICE).
