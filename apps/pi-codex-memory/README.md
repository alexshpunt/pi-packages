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
| Memory model | A model available in Pi. Needed only for creating memories. |

## Install

The package is not published to npm yet, so build it from the repository source and register it with Pi:

```sh
git clone https://github.com/buYoung/pi-packages.git
cd pi-packages
pnpm install
pnpm --filter "@buyong/pi-codex-memory..." build
pi install ./apps/pi-codex-memory
```

After installation, start Pi and the `/codex-memory` commands are available. Removing the extension with `pi remove ./apps/pi-codex-memory` keeps your stored memories.

The `@buyong/pi-codex` bundle built from the repository source also includes this extension; the bundle published to npm does not include it yet. Do not enable both the bundle and this package.

## Quick start

This walkthrough uses the verification settings to create a memory and bring it back in a new session: `claude-bridge/claude-haiku-5-5` as the memory model, with the default timing. The `claude-bridge` provider comes from the [@buyong/pi-claude-bridge](https://github.com/buYoung/pi-packages/blob/main/apps/pi-claude-bridge/README.md) extension, so install it first by following its instructions. You can also pick any other model already configured in Pi.

Creating memories sends masked copies of your conversations to the model you pick, which uses your provider quota or costs money. Masking does not catch every private value.

### 1. Turn on memory creation

1. Start Pi in the project folder where you want memory, and run `/codex-memory`.
2. Choose **Use and create memories**.
3. Pick `claude-bridge/claude-haiku-5-5`. It is used for both extraction and consolidation, with `low` reasoning for extraction and `medium` for consolidation.
4. Approve **Send conversations to create memories?**, which shows the model and the daily call limit.

The notification "Memory creation is on. A conversation becomes memory after 30 idle minutes." confirms it worked.

### 2. Turn a decision into memory

1. Record a decision in the conversation, for example: `We decided to switch the release gate to amber. This applies to this project only.`
2. Run `/codex-memory-manage`, choose **Generate from this conversation**, and approve. This item appears only while memory creation is on, and creates memory now instead of after 30 idle minutes.
3. When it finishes, a notification says "Created memories from 1 conversation(s)."
4. Run `/codex-memory-manage` and choose **Review saved memories** to see what was saved.

### 3. Bring it back in a new session

1. In the same project, open a new session with `/new`.
2. Ask `What did we pick for the release gate?`

The agent sees a memory summary with each request and searches and reads memory when it needs more. If it used memory, it answers `amber` and cites the source at the end of the answer, and the status bar shows the citation:

```text
Memory: Use and create · 1 cited
```

The status bar starts with the current mode. `1 cited` appears only when the last answer cited memory that the agent actually read; a citation that does not match what was read shows a warning instead. `updating…` means a memory job is running, and `update failed` means the last one failed.

Memory is a record of past conversations. It does not prove the code is still in that state, so check important points against the code.

## Everyday use

In **Use and create memories** mode, memories are built in the background while Pi is open. Nothing is processed while Pi is closed; conversations that were waiting are processed the next time Pi is open and idle.

- After a conversation has been idle for 30 minutes, its memories are extracted.
- Extracted content is consolidated into existing memory at most once every 60 minutes.
- When you type new input, any memory job in progress is cancelled.

To save something right away, ask the agent to "remember" it. A confirmation shows the exact text before it is saved, and it works in **Use saved memories** mode as well. To save the whole conversation instead, use **Generate from this conversation** in `/codex-memory-manage`.

### Fix a wrong memory

Run `/codex-memory-manage` and choose **Review saved memories**. Use **Search…** to narrow the list, pick a memory, and choose **View memory and source**, **Edit memory** or **Forget memory**. These actions do not call a model.

- Edited or forgotten memories leave the summary and search results immediately.
- A forgotten memory is not created again from the same conversation. Original sessions, provider-side copies and other conversations with the same fact are not erased.

## Commands

All three commands take no arguments.

| Command | What it opens |
| --- | --- |
| `/codex-memory` | The mode: **Off**, **Use saved memories** or **Use and create memories**. |
| `/codex-memory-manage` | Saved memories: **Review saved memories**, **Generate from this conversation**, **Stop current job** while a job runs, **Show what failed** after a failure, and **Forget all memories in this scope**. |
| `/codex-memory-settings` | The model, timing, retention, daily call limit, memory scope and repository access. |

Opening a page does not stop a running job. Without a UI, `/codex-memory` and `/codex-memory-manage` print the status as JSON and `/codex-memory-settings` prints the settings; they change nothing.

The agent reads memory with `pi_codex_memory_list`, `pi_codex_memory_search` and `pi_codex_memory_read`, and saves what you ask it to remember with `pi_codex_memory_note`.

## Who shares memory

Subfolders and worktrees of one Git repository share memory, settings and the daily call limit. Separate clones, nested repositories and submodules each keep their own. Outside Git, each folder keeps its own. Because settings are also per scope, you must turn on memory creation again in another repository.

Scopes are identified by the repository's local path. Moving the repository folder disconnects it from its existing memory, and placing a different repository at the same path inherits the old memory.

To share one memory across folders, run `/codex-memory-settings`, choose **Memory scope** and pick **Personal**. Every folder set to Personal shares that memory and its settings. Changing scope does not copy or merge existing memories.

If a folder in this repository has memories saved before repository sharing existed, `/codex-memory-manage` shows **Import N old memories for this folder**. It copies them into the repository's memory after showing the list.

### Read another repository's memory

For example, to check what was decided in `shop-api` while working in `shop-web`:

1. In `shop-web`, run `/codex-memory-settings` and choose **Repository access**.
2. Pick `shop-api`. If you have not opened Pi in `shop-api` since installing this extension, it is not listed; choose **Add repository…** and enter its folder path.
3. Choose **Always allow reads** to let the agent read it without asking, or **Ask each time** to confirm each read, then approve.
4. Ask the agent with the repository named, for example "find the auth method in shop-api's memory." With **Ask each time**, a confirmation appears now.

Access goes one way. Letting `shop-web` read `shop-api` does not let `shop-api` read `shop-web`. Another repository's memory is only read; it is never added to the summary, copied or edited.

## Storage and defaults

Memories are stored in `~/.pi/agent/pi-codex-memory/`, not in your project. If you set `PI_CODING_AGENT_DIR`, they are stored under that directory instead. `state.sqlite` is the source of truth; the Markdown files under `scopes/` are copies generated from it. Manage memories with `/codex-memory-manage` instead of editing the Markdown.

Change settings in `/codex-memory-settings`. Each change is saved right away for the current scope, stops a running memory job, and applies from the next job. **Edit all settings as JSON** holds the remaining settings, such as separate extraction and consolidation models and their reasoning levels.

| Setting | Default |
| --- | --- |
| Idle time before creating memories | 30 minutes |
| Consolidation interval | 60 minutes |
| Model calls per UTC day | 24 |
| Keep unused memories | 30 days. Memories you asked the agent to save and memories you edited are kept. |
| Conversations per extraction run | 2 |
| Maximum age of a conversation to extract | 10 days |
| Input per call / summary injection limit | 256 KiB / 12 KiB |

For how the 30- and 60-minute defaults were chosen and when to change them, see the [verification report](docs/verification.md#how-the-default-wait-times-were-chosen).

## Verification

Every code change runs 83 tests, a TUI smoke check and a package check, all without a model. With real models, a scenario set six facts in a 16-turn conversation and asked for them again in a new session. With memory on, both tested models (Haiku and Luna) answered all six; with memory off, neither answered any. The commands, token use and limits are in the [verification report](docs/verification.md).

## License

[Apache-2.0](LICENSE). Attribution is in [NOTICE](NOTICE).
