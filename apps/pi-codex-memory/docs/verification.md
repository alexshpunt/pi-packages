# Verification

**English** | [한국어](verification.ko.md) | [README](../README.md)

This report describes how pi-codex-memory is verified and what the checks found. Model-free checks run on every code change. Whether memory actually helps was checked by running a fixed scenario with real models.

## Summary

- With memory on, both models answered all six past decisions in a new session. With memory off, neither answered any.
- After the conversation was compacted, all 16 original user messages still reached extraction.
- Values corrected in the conversation appeared in new-session answers, and facts forgotten from the menu were not regenerated.
- One generation run (extraction and consolidation) used 38,632 tokens with Haiku and 21,822 with Luna.
- In real Pi processes, only closed conversations became memory, each once. When the coordinating process was killed, another session took over 90 seconds later.

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
| `test` | 116 tests. Isolated stores and fake model responses cover extraction, consolidation, recall, citation validation, correction and forgetting, cancellation, repository sharing and read consent. Several sessions sharing one store, on a fake clock, cover background coordination: one coordinator per scope, closed conversations only, at most 8 jobs, takeover after a lost lease or a long sleep, shutdown while a provider ignores cancellation, the status shown in every session, and **Create memories now**. Some tests load the extension into the real Pi SDK and run its commands and tools. |
| `tui-smoke.py` | In the real Pi TUI, opens `/codex-memory` and checks its rows, row description and key hint, opens its memory model list, opens `/codex-memory-settings`, and reopens `/codex-memory` after `/reload`. Fails if any model request is sent. Requires `pi` on `PATH`. |
| `check-package.mjs` | Confirms that the release archive contains the required files and entry points. |

The installed package was also checked once. Installed alone and through the `@buyong/pi-codex` bundle, the extension loaded and passed 41 repository-sharing cases and 6 tool cases.

## Checks with real models

The coordination check below uses the current version. The recall checks after it used a version from before repository sharing, the current command layout and background coordination were added; those are covered by the coordination check and the automated checks above.

### Background coordination

`verification/live/coordinator.py` runs real Pi TUI processes in one temporary folder with `claude-bridge/claude-haiku-5-5`. It needs `pi` on `PATH` and a Claude Code login, and sends about fifteen requests. To keep the run short, it sets **Create memories after** and **Update the summary every** to 1 minute.

```sh
python3 apps/pi-codex-memory/verification/live/coordinator.py
```

1. With memory off, an open session records nothing. After memory is turned on from outside, that session marks itself open within 30 seconds and becomes the coordinator.
2. A second session records a decision and quits. A third records another decision and stays open. A fourth stays open without a conversation.
3. The closed conversation must become memory, and the open one must not, even after it has been idle longer than the wait.
4. The coordinating process is killed. Another session must take over, and the remaining conversation must become memory once it is closed.
5. A fifth session records a third decision and quits. An open session chooses **Create memories now** in `/codex-memory`. The conversation must become memory without the 1-minute wait, and another session's status line must show the job.
6. A session asks for all three decisions. Then memory is turned off.

All 12 checks passed in 358 seconds on macOS with Pi 1.4.0:

- One session coordinated. The killed coordinator was replaced 90 seconds later.
- Each conversation became memory once. The run made three extractions and three summary updates: 6 memory model calls with 16,552 input and 6,625 output tokens.
- **Create memories now** finished 5.1 seconds after the conversation closed, and another session showed `Memory: on · creating 1 memory…`.
- The session answered `amber`, `blue-7` and `zephyr-ops`.
- Turning memory off removed every open-session record and the coordinator lease, including those the killed process left behind.

### Recall scenario

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

- The results come from one kind of synthetic conversation and two models, with one run per condition. They are not measurements from long-term real use. The coordination check ran once with one model.
- Raw request and response records are not published. The recall scripts in `verification/live`, `verification/compaction` and `verification/regeneration` take these records as input, so they cannot be rerun from the repository alone. `verification/live/coordinator.py` needs no such records.

## How the defaults were chosen

The owner set the defaults: a closed conversation becomes memory 2 hours after its last message, the summary is updated at most every 2 hours, and conversations from the last 7 days are used. Codex uses 6 hours, 6 hours and 10 days. Codex skips only the session that starts the job and judges every other conversation by idle time alone, whether or not it is still open.

Only closed conversations become memory, so the wait no longer has to keep extraction out of ongoing work. It covers the time in which you may reopen a conversation you just closed: a reopened conversation that you continue is extracted again.

### When to change them

Change settings in `/codex-memory-settings`.

- If memories show up too late for your next task, set **Create memories after** to 30 or 60 minutes. A conversation you reopen and continue within that time is extracted again, which adds calls.
- To reduce calls, set **Update the summary every** to 3 hours or 6 hours.
- To include older work, raise **Use conversations from the last**. The next scan then processes more past conversations.
- If you need memory right away, choose **Create memories now** in `/codex-memory` for closed conversations, or **Remember this conversation now** in `/codex-memory-settings` for the current one.
