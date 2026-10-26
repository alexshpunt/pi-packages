# Verification

**English** | [한국어](verification.ko.md) | [README](../README.md)

This report describes how pi-codex-memory is verified and what the checks found. Model-free checks run on every code change. Whether memory actually helps was checked by running a fixed scenario with real models.

## Summary

- With memory on, both models answered all six past decisions in a new session. With memory off, neither answered any.
- After the conversation was compacted, all 16 original user messages still reached extraction.
- Values corrected in the conversation appeared in new-session answers, and facts forgotten from the menu were not regenerated.
- One generation run (extraction and consolidation) used 38,632 tokens with Haiku and 21,822 with Luna.

## Checks on every code change

Run these from the repository root. None of them call a model.

```sh
pnpm --filter "@buyong/pi-codex-memory..." build
pnpm --filter @buyong/pi-codex-memory typecheck
pnpm --filter @buyong/pi-codex-memory lint
pnpm --filter @buyong/pi-codex-memory test
python3 apps/pi-codex-memory/verification/tui-smoke.py
node scripts/codex/check-package.mjs apps/pi-codex-memory
```

| Command | What it checks |
| --- | --- |
| `typecheck`, `lint` | Type errors and Biome rules |
| `test` | 83 tests. Isolated stores and fake model responses cover extraction, consolidation, recall, citation validation, correction and forgetting, cancellation, call limits, repository sharing and read consent. Some tests load the extension into the real Pi SDK and run its commands and tools. |
| `tui-smoke.py` | In the real Pi TUI, opens and cancels `/codex-memory`, opens `/codex-memory-manage` and `/codex-memory-settings`, and reopens `/codex-memory` after `/reload`. Fails if any model request is sent. Requires `pi` on `PATH`. |
| `check-package.mjs` | Confirms that the release archive contains the required files and entry points. |

The installed package was also checked once. Installed alone and through the `@buyong/pi-codex` bundle, the extension loaded and passed 41 repository-sharing cases and 6 tool cases.

## Checks with real models

The real-model checks used a version from before repository sharing and the current three-command layout were added. Both are covered only by the automated checks above.

### Scenario

1. Create a synthetic 16-turn conversation. The first turn sets `service`, a middle turn sets `region` and `verify_command`, and the last turn changes `release_gate` to a new value. The conversation also states "applies to this project only" and "no commands were run." Values are randomized on each run so the model cannot know them in advance.
2. Compact the conversation manually and continue for one more turn.
3. Generate memory from this conversation.
4. In a new session, ask for six fields with a question that does not contain the answers: `service`, `region`, `verify_command`, `release_gate`, `decision_scope` and `actions_executed`. Also check that the answer cites lines the memory tools actually read.

| Name | Model | Reasoning level |
| --- | --- | --- |
| Haiku | `claude-bridge/claude-haiku-5-5` | `medium` for dialogue and recall, `low` for extraction, `medium` for consolidation |
| Luna | `openai-codex/gpt-6-luna` | `high` throughout |

Each condition ran once on macOS with Pi 1.4.0 and Node.js 24.14.0.

### Recall

| Model | Memory off | Memory on |
| --- | --- | --- |
| Haiku | 0/6; answered "unknown" for all | 6/6 |
| Luna | 0/6; answered "unknown" for all | 6/6 |

With memory on, both models read the memory files and correctly cited the lines they read. With memory off, answering "unknown" followed the instruction not to guess.

After compaction, all 16 original user messages still reached extraction, because extraction uses the original messages of the current branch instead of the compaction summary.

### Tokens and time

| Model | Generation tokens | Generation time | Recall tokens | Recall time |
| --- | ---: | ---: | ---: | ---: |
| Haiku | 38,632 | 20.8 s | 14,040 | 10.3 s |
| Luna | 21,822 | 18.9 s | 10,940 | 11.0 s |

- Generation is one extraction and one consolidation: two model calls. Recall counts every model call needed to answer one question: two for Haiku and four for Luna.
- Tokens are the sum of input, output, cache-read and cache-write tokens, matching Pi's recorded `totalTokens`. Prices depend on the provider and plan.
- Time is the sum of model call durations only. It excludes waits between calls and tool processing, so it differs from the time you see on screen.

Asking the same question without memory used 3,453 tokens with Haiku and 1,156 with Luna, but returned no answer.

### Correction and forgetting

- **Correction in the conversation**: a follow-up turn changed `release_gate` again and memory was regenerated. In a new session, both models answered all six fields, including the new value.
- **Forgetting from the menu**: memory was forgotten from the memory menu, the conversation was actually compacted, and a manual rescan of idle conversations processed it again. Active memories, search matches for the forgotten facts and injected summary bytes all stayed at zero, and no memory was regenerated. A follow-up question to the model failed because the question was wrong: it expected no files at all, but an empty `memory_summary.md` template remains. The corrected question was not rerun.
- **Terminal check**: an earlier version was checked in a real terminal for new-session recall, correcting and forgetting from the menu, cancellation, restart and `/reload`. Forgotten values did not reappear during 90 seconds of watching automatic rescans.

### Limits of these checks

- The results come from one kind of synthetic conversation and two models, with one run per condition. They are not measurements from long-term real use.
- Raw request and response records are not published. The real-model scripts in `verification/live`, `verification/compaction` and `verification/regeneration` take these records as input, so they cannot be rerun from the repository alone.

## How the default wait times were chosen

The 30-minute idle time before extraction and the 60-minute consolidation interval are starting values chosen by comparing synthetic work patterns. They are not optimal values measured from real usage or model quality. Codex uses 6 hours for both.

```sh
pnpm --filter @buyong/pi-codex-memory benchmark
```

`benchmark` simulates five work patterns minute by minute, using the same eligibility function the extension uses: continuous work, short breaks, review waits, resuming after lunch, and separate tasks two hours apart. Build first.

| Idle time before extraction | Total extractions | Extractions during work | Delay until the last memory |
| --- | ---: | ---: | ---: |
| 5 min | 22 | 17 | 5 min |
| 15 min | 13 | 8 | 15 min |
| **30 min** | **9** | **4** | **30 min** |
| 60 min | 8 | 3 | 60 min |
| 6 h | 5 | 0 | 6 h |

Compared with 15 minutes, 30 minutes runs four fewer extractions. Compared with 60 minutes, it produces the last memory 30 minutes sooner.

Consolidation was compared with a pattern that adds new material every 10 minutes for two hours.

| Consolidation interval | Consolidations | Delay until the last material is included |
| --- | ---: | ---: |
| 15 min | 9 | 0 min |
| 30 min | 5 | 0 min |
| **60 min** | **3** | **0 min** |
| 180 min | 2 | 60 min |
| 6 h | 2 | 240 min |

The 0-minute delays occur because, in this pattern, the last material arrived at the same time as a consolidation. In practice, new material can wait up to the configured interval for the next consolidation.

### When to change them

Change settings in `/codex-memory-settings`.

- If extraction runs too often during long reviews, raise the idle time to 60 minutes.
- If memories show up too late for your next task, try 15 minutes. This increases calls.
- To reduce calls, raise the consolidation interval to 180 minutes or 6 hours.
- If you need memory right away, use **Generate from this conversation** in `/codex-memory-manage`.
