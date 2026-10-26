# @buyong/pi-codex-memory

**English** | [한국어](README.ko.md)

Codex memory v2 adapted to Pi. Keep project decisions across sessions by extracting conversation summaries, consolidating them, and retrieving relevant history when needed. Manage everything through **`/codex-memory`**.

[Verification and performance results](docs/verification.md)

## Required

| Component | Requirement |
| --- | --- |
| Pi | 1.4.0+ |
| Node.js | 22.19+ |
| Memory models | Configure the selected providers in Pi before enabling generation |

Codex CLI is not required.

## Build and try

From the repository root:

```sh
pnpm install
pnpm --filter "@buyong/pi-codex-memory..." build
pi -ne -e ./apps/pi-codex-memory
```

For persistent local registration, use `pi install ./apps/pi-codex-memory`. Remove it with `pi remove ./apps/pi-codex-memory`; this does not erase stored memories.

The `@buyong/pi-codex` bundle also includes this extension. Enable either the bundle or the individual package, not both. Rebuild the bundle after component changes.

## First use

### Save a note

1. Open `/codex-memory` → **기억 추가** (add memory).
2. Enter a project fact or decision and confirm.
3. Use **기억 조회·정정·잊기** to read, correct or forget it.

These management actions do not call a model. `/codex-memory status` shows the active scope, storage location and usage.

### Enable generation

**Generation is off by default.** Existing memory can still be read and included in context.

1. Open `/codex-memory settings`.
2. Select extraction and consolidation models, review the limits, and enable generation.
3. Save and confirm the transmission scope.
4. Use `/codex-memory extract` for the current branch, or wait until the configured idle time has passed.

Generation sends masked conversation copies to the selected providers and may consume quota or incur charges. Masking does not detect every private value. Load any provider extension needed by the selected models; changing the foreground model does not change your saved memory-model choices.

Generation runs while Pi is open and is cancelled when foreground work starts. It does not continue as a service after Pi exits.

## Commands and tools

| Command | Action |
| --- | --- |
| `/codex-memory` | Notes, settings, scope and reset |
| `/codex-memory status` | Inspect status without a model call |
| `/codex-memory settings` | Edit and confirm settings |
| `/codex-memory extract` | Confirm and extract the current branch |
| `/codex-memory run` | Confirm and extract memories from sessions that meet the idle settings |
| `/codex-memory import` | Include older conversations in the idle scan, after confirmation |
| `/codex-memory cancel` | Cancel this session's memory job |
| `/codex-memory repositories` | Register repositories and manage read connections |
| `/codex-memory legacy` | Select and confirm existing cwd memories to copy |

The agent uses `pi_codex_memory_list`, `pi_codex_memory_search`, `pi_codex_memory_read` and `pi_codex_memory_note`. Notes require confirmation. Interactive management is available in TUI and UI-capable RPC; noninteractive execution cannot silently approve changes or transmission.

## Sharing and scope

The main checkout, subdirectories and linked worktrees of one Git repository share memories, settings and call budgets. Separate clones, nested repositories and submodules remain separate. Outside Git, the scope is the current working directory.

Scope identity uses the local Git common-directory path, not the remote URL. Moving that path can change the scope; replacing a repository at the same path can reuse its old scope.

To read another repository's history:

1. Register its working-directory path with `/codex-memory repositories`.
2. Explicitly request that repository's memory. Read tools accept its registered name, scope ID or path through `repository`.
3. Confirm access for that user request, or save a directional read connection for repeated use.

A connection from `shop-web` to `shop-api` does not grant access in reverse. Reading does not automatically inject, copy or edit the other repository's memory. Notes, corrections and forgetting affect only the active scope.

Existing cwd memories are not migrated automatically. Use `/codex-memory legacy` to select records from the same repository and confirm the copy. Forgotten records are not revived, and settings or generation consent are not transferred. The copies remain independent afterward. Personal-global scope is a separate, explicit choice; switching scope does not merge existing records.

## Storage and retention

Memories stay in the central Pi agent directory, not inside the project or `.git`:

```text
~/.pi/agent/pi-codex-memory/
├─ state.sqlite
└─ scopes/
   ├─ <shop-api scope ID>/
   │  ├─ memory_summary.md
   │  ├─ rollout_summaries/
   │  └─ extensions/ad_hoc/notes/
   └─ <shop-web scope ID>/
```

`PI_CODING_AGENT_DIR` changes the agent directory. Use `/codex-memory status` for actual scope IDs. SQLite is authoritative; manage memories through `/codex-memory` rather than editing generated Markdown files.

| Setting | Default |
| --- | --- |
| Minimum idle time before extraction | 30 minutes |
| Consolidation cooldown | 60 minutes |
| Sources per run / model calls per UTC day | 2 / 24 |
| Maximum source age | 10 days |
| Unused, unpinned memory retention | 30 days |
| Model input / context injection limit | 256 KiB / 12 KiB |

Explicit expiry also applies to pinned records. Cleanup runs while Pi is open. These are configurable limits, not measured universal optima. See [timing details](docs/timing.ko.md) for the scheduling rationale.

## What memory does not guarantee

- Memory is historical evidence, not proof of the current code or permission to execute an action.
- Forgetting removes active memory and excludes its source from regeneration. It does not erase original sessions, earlier answers, backups or provider-side copies. Independent sources can contain the same fact.
- Reading a memory or validating its citation does not guarantee a correct answer. Accuracy, token use and the limits of the tested cases are covered in the [verification report](docs/verification.md).

## Verify locally

From the repository root:

```sh
pnpm --filter "@buyong/pi-codex-memory..." build
pnpm --filter @buyong/pi-codex-memory typecheck
pnpm --filter @buyong/pi-codex-memory test
pnpm --filter @buyong/pi-codex-memory benchmark
node scripts/codex/check-package.mjs apps/pi-codex-memory
```

Tests use isolated stores and fake model streams. `benchmark` reports synthetic scheduling data, not live-model performance. These commands do not request live memory-model responses.

Based on [Codex memory v2](https://github.com/openai/codex/tree/4610b573e59b211bf9430cf6ffb97cfb84623090/codex-rs/memories), adapted to Pi's providers and SQLite storage. It does not share Codex's database. [Apache-2.0](LICENSE); see [NOTICE](NOTICE) for attribution.
