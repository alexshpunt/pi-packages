# Verification and performance results

**English** | [한국어](verification.ko.md) | [README](../README.md)

This report covers recorded checks of the Codex memory v2 adaptation for Pi: recall with and without memory, retention after compaction, and token use. The results are limited to the tested cases, not a general model ranking.

## Test scope

The live comparison used saved 16-turn synthetic conversations with two models:

- **Haiku:** `claude-bridge/claude-haiku-5-5`
- **Luna:** `openai-codex/gpt-6-luna`

Requested reasoning: Haiku `medium` for dialogue/recall and `low`/`medium` for extraction/consolidation; Luna `high` throughout.

Environment: macOS, Pi 1.4.0, Node.js 24.14.0.

A turn is one user input and its completed response. We checked one question and answer per comparison condition; these results are not averages of repeated runs.

**Previous** means extraction from the compacted conversation. **Repaired** means extraction that retains original active-branch evidence. Both versions received the same per-model input, including a sanitized Haiku copy and an added post-compaction turn, and actually regenerated memory. Recall used fresh sessions whose questions did not contain the answers.

These live results predate repository sharing. Checks for the later repository-sharing implementation are listed separately below. Codex CLI itself was not benchmarked against this extension.

## Recall before and after enabling memory

Six historical fields were checked: service, region, verification command, release gate, decision scope and historical execution status.

| Model | No memory | Previous implementation | Repaired implementation |
| --- | --- | --- | --- |
| Haiku | 0/6 recovered; all unknown | 6/6 | 6/6 |
| Luna | 0/6 recovered; all unknown | Semantically 6/6 | 6/6 |

The no-memory answers were the expected abstention, not a model failure. Both repaired cases used an actual memory read and a valid source citation. This is **six more recovered facts than the no-memory control**, but not an accuracy win over the previous implementation in this comparison.

Luna's previous answer used an equivalent Korean phrase for “this project only.” The original English-string checker reported **5/6**; a separate semantic assessment accepted that scope. The original verdict was not replaced.

### Original evidence reaching extraction

| Model | Previous | Repaired | Change |
| --- | ---: | ---: | ---: |
| Haiku | 0/16 original user turns | 16/16 | +16 turns |
| Luna | 1/16 original user turns | 16/16 | +15 turns |

The repair improved **source evidence retention**. This count does not mean every detail was stored or that the full conversation is retained forever. Memory summaries and correct answers are separate outcomes.

## Retention after compaction

In the earlier experiment, both models recalled **6/6 before and immediately after compaction** in all six cases. Existing stored memory survived; regenerating it from the compacted conversation was less reliable.

| Model | Regeneration after 6 turns | After 16 turns | After 32 turns |
| --- | --- | --- | --- |
| Haiku | 6/6 after recall recheck | **2/6** | 6/6 with a 512 KiB input limit |
| Luna | Facts and citations matched after recheck; scope equivalent | **0/6** | Content and citations matched; answer-wrapper format failed, with a 512 KiB limit |

In the 16-turn failures, the regenerated text still contained the values but described confirmed decisions as unverified. The next model read them and answered that it did not know. **A value being stored is not enough to establish successful recall.**

The later repaired comparison used changed inputs and a new follow-up turn. Its success does not erase these failures or prove that the repair alone caused an accuracy improvement.

The 6- and 16-turn cases used real manual compaction; the 32-turn cases used the real automatic path with a lowered threshold. Long inputs exceeded the default **256 KiB** generation budget, so the experiment used **512 KiB**. The rejected attempt sent no generation request. Product defaults were unchanged; this was not a default-context-window saturation test.

## Token use

These totals belong to the 16-turn previous/repaired comparison. They include input, output, cache-read and cache-write tokens, matching Pi's recorded `totalTokens`. **Token counts are not prices.**

| Model and operation | Previous tokens | Repaired tokens | Change |
| --- | ---: | ---: | ---: |
| Haiku: generation | 13,184 | 38,632 | +25,448 (+193.0%) |
| Luna: generation | 5,603 | 21,822 | +16,219 (+289.5%) |
| Haiku: one recall | 31,191 | 14,040 | −17,151 (−55.0%) |
| Luna: one recall | 8,088 | 10,940 | +2,852 (+35.3%) |
| Haiku: generation + one recall | 44,375 | 52,672 | +8,297 (+18.7%) |
| Luna: generation + one recall | 13,691 | 32,762 | +19,071 (+139.3%) |

Generation includes extraction and consolidation. Recall counts every model request made to answer one question. Original dialogue creation, compaction, setup failures, earlier failed recalls, correction and forgetting are excluded.

The no-memory questions used **3,453 tokens for Haiku** and **1,156 for Luna**, but returned unknown values. They are not lower-cost examples of equivalent successful recall.

Generation used two host requests per model and version. Recall requests changed from **3 to 2 for Haiku**, and **3 to 4 for Luna**. More original evidence increased generation input; recall did not consistently use fewer tokens.

## Observed call time

| Model and operation | Previous | Repaired | Change |
| --- | ---: | ---: | ---: |
| Haiku: generation | 27.795 s | 20.829 s | −6.966 s |
| Luna: generation | 16.703 s | 18.922 s | +2.219 s |
| Haiku: recall | 14.710 s | 10.261 s | −4.449 s |
| Luna: recall | 7.488 s | 11.044 s | +3.556 s |

Times sum the host-recorded durations of the same model calls used in the token table. They exclude time between calls, other tool processing and setup. They are **not end-to-end UI latency or an average**. Cache state, output length and provider load were not controlled, so these observations do not establish a causal speed improvement.

## Correction and forgetting

- Both repaired cases regenerated a correction and recalled all six fields, including the corrected value, in a fresh session.
- After forgetting and real compaction, both had zero active records, zero matches for forgotten facts and zero injected bytes. After the required idle time, another scan produced no new memory records. We invoked `/codex-memory run`; we did not test the automatic timer in this check.
- **The final model-answer check failed.** Its question wrongly expected an empty store to have no files, although an empty `memory_summary.md` template can remain. The corrected question was not rerun. Offline absence checks do not replace that missing live-answer check.

Earlier terminal tests also checked fresh-session recall, UI correction and forgetting, cancellation, restart and reload. Forgotten values stayed absent during a **90-second** automatic-rescan observation. Those tests predate repository sharing, and cancellation does not prove that provider-side computation or billing stopped.

## Repository-sharing checks

This later implementation was checked with isolated stores, synthetic repositories and fake streams through the real Pi SDK—not new live-provider or terminal experiments.

| Check | Result |
| --- | --- |
| Source tests | 81/81 passed |
| Independent installation | Resource loading passed; 41/41 repository cases and 6/6 tool cases |
| Bundled installation | Resource loading passed; 41/41 repository cases and 6/6 tool cases |

The 41-case suites are subsets of the 81-case suite. They cover sharing and isolation, read consent, legacy import, scoped citations, forgetting and concurrency boundaries. They do not establish live-model answer quality.

## Limits and local checks

- These are small synthetic cases, not long-term production measurements or guarantees for other models and platforms.
- An earlier compaction response contained an unexplained identifier absent from the host-visible input. It was absent from final memory; its origin remains unknown. Masking and host-side checks are not proof of complete provider isolation.
- Forgetting does not erase original conversations, backups or provider copies. Independent sources can contain the same fact.
- Raw historical request/response data is not included in the public package. This report presents aggregate results; it is not a self-contained live benchmark dataset.

See the [README's local checks](../README.md#verify-locally) to run the model-free tests. The `benchmark` command reports synthetic scheduling data, not the live token and call-time measurements above.
