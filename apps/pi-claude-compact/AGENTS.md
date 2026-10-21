# AGENTS.md

<!-- agents-md-generator: v1; doc-type: single_repo -->

## 1. Overview

This extension compacts Pi history by summarizing older conversation rounds while retaining a recent tail. It coordinates background summaries, failure recovery, and bounded restoration of relevant files and skills.

## 2. Ownership Map

### Stable Ownership Boundaries

- **Event integration.** `index.ts` registers hooks; `controller.ts` decides whether and how to compact. `turn_end` and `agent_before_settle` append drafts after existing event entries, whereas `session_before_compact` returns Pi's compaction result. Inspect the final session projection, retained entry boundary, and `details.source`.
- **Summary strategy.** `engine.ts` chooses retained rounds and recovery; `transcript.ts` and `summarizer.ts` produce model input and classify failures. Changes must align `EngineResult`, attempt counts, summarized IDs, and the final `streamSimple()` options.
- **Background state.** `precompute.ts` and `session-state.ts` own jobs, reuse checks, and failure limits. Check cancellation on tree/compaction/shutdown events, current-content fingerprints, and the emitted `details.precomputed` value.
- **Restoration.** `restore.ts` selects files/skills and enforces budgets. Trace `carriedRestore` through the controller's `finish` path to the actual summary and restoration metadata. A rejected or unfinished tool call is not evidence that a file should be read again.
- **Settings and safety net.** `config.ts` and `thresholds.ts` own extension policy. `commands.ts`'s `alignSafetyNet` and `pi-settings.ts` modify Pi's global reserves. Check both effective configurations and the command's reported state; project overrides remain authoritative.

## 3. Core Behaviors & Patterns

### Dispatch and failure boundaries

- Disabled operation or a missing model leaves the host flow alone. A normal `turn_end` above threshold returns compaction drafts without stopping execution. Reentrant `session_before_compact` requests are canceled. A failed extension-owned automatic compaction leaves history intact. If Pi initiated compaction, failure cancels bridge-model or manual requests, but other automatic requests may fall through to Pi's default compactor.
- Track runtime state per session ID and ownership under `Symbol.for("pi-claude-compact")`. Shutdown removes only this instance's entry. Tree changes, completed compaction, shutdown, and disabling either compaction or precompute cancel background jobs. `agent_settled` resets run-level failures, rapid-refill history, and media recovery, but not the precompute failure count.
- Three consecutive non-cancellation automatic failures stop threshold-driven compaction for the run. Overflow and manual failures do not count. Three consecutive refills requiring another compaction within fewer than three turns stop automatic/overflow execution; the media path warns and abandons recovery. Manual compaction bypasses both breakers and does not update their records.

### Thresholds and retained history

- Reserve the smaller of a positive model `maxTokens` and 20,000 output tokens; use 20,000 when absent or nonpositive. The configured compaction window cannot exceed the actual context window. The default threshold is the effective window minus 13,000. Percentage thresholds use that effective window and cannot exceed the default; absolute thresholds above the limit are rejected. The minimum threshold is 20,000.
- Blocking uses the actual context window minus output reserve minus 3,000, not the configured compaction window. Precompute starts at approximately 80% of the effective window, capped by the compaction threshold. Keep these separate calculations when changing a setting.
- Form rounds around assistant responses and exclude system snapshots from summarization. Normally retain the last round. If input is too large, retain enough additional trailing rounds to cover a reported excess; without an excess measurement, retain one more round at a time.
- When no answer remains to summarize, only eligible paths use last-resort recovery. First consider summarizing a sufficiently large first round alone if it can cover the deficit and restoration allowance. Do not use a first response that itself failed with overflow. Failure or a result without `<summary>` abandons this strategy. Then retain an unanswered user turn or the necessary final tool round and trim older input up to three times. Stop with `exhausted` or `too_few_groups` if further useful reduction is impossible.
- Only non-size failures advance to another summary model. With no configured summary model, use the conversation model; after a configured model fails, returning to the conversation model requires `fallbackToConversationModel`. Cancellation never triggers model fallback. A summary media-size error gets one retry with images replaced by `[image]`; another failure becomes `media_unstrippable`.
- Prefix trimming is permitted for normal automatic compaction only at the blocking threshold, and for manual/ordinary overflow recovery. Media recovery and background precompute do not trim prefixes. Do not merge these distinct recovery policies.
- Recheck the size of summary, restored material, retained history, and system overhead together. Discard a precomputed result that cannot fit below the compaction threshold and summarize afresh. A new result still at or above blocking can undergo one deeper compaction when a retained boundary exists and summary plus tail form at least three rounds. Do not apply this to media recovery or precomputed results. If the deeper attempt fails, keep the first result.

### Background work and final publication

- `agent_before_settle` attempts media recovery once per run only when the last assistant has a media-size error that Pi did not classify as overflow. Exclude that failed response and compact without precompute or prefix trimming. Success appends a removing `context_edit` plus compaction drafts and returns `continue: true`. Failure preserves the original error and does not increment the automatic-failure counter.
- Maintain one precompute job per session and stop scheduling after three counted failures. Detach a job before consuming it to prevent duplicate use. Reuse requires the same latest compaction ID, summarized-entry order and content fingerprints, and the immediately following retained boundary. Cancellation or anchor changes abort it. Reconstruct the tail from the current projection rather than the job's captured tail.
- Send tagged transcript and summary instructions as one user message. Exclude thinking and failed/aborted assistant responses; do not arbitrarily truncate tool results. Summary calls have no tools, use `cacheRetention: "none"`, a separate session ID, the caller's signal, and Pi's retry policy. Bridge summaries use image markers rather than image payloads. Normal summaries require nonempty text; formatting removes analysis. If prefix trimming lost history, disclose the loss and full-transcript path without implying the retained tail was summarized.
- Restoration candidates come from successful read/edit/write results, including successful nested calls. Carry previous files only from this extension's compaction metadata and skills only from recorded locations. Exclude files read in the retained tail and skills already visible there; a file merely edited or written in the tail can still be restored.
- Reread at most five recent files from disk. Skip nonfiles, binary content, and read failures; close handles on all paths. A file above 5,000 tokens becomes a reference rather than a truncated body. File content has a 50,000-token aggregate budget. Skills have 5,000-token individual and 25,000-token aggregate budgets. Do not restore SKILL.md twice as both a file and a skill.
- For a bridge conversation ending in a tool result, retain the final tool round needed to identify the pending query. Successful boundary compaction notifies `claude-bridge:markRebuildHooks` with the affected session ID and boundary name. It does not edit Claude session files or invalidate unrelated sessions.
- Extension settings reach memory only after a successful save; load errors warn and use defaults. Safety-net alignment targets models where Pi would compact first. After user confirmation, it updates model-specific global reserves under a lock. Migrate an existing Pi override only when the extension has neither its own threshold nor window and the old effective threshold is valid. Project overrides still win and are reported. The two files are not one atomic transaction, and Pi reserve changes require reload.

## 4. Conventions

- Keep the existing root-module layout: hooks in `index.ts`, orchestration in `controller.ts`, and calculations near their owning feature. Relative TypeScript imports use `.ts`.
- Use explicit result variants such as `EngineResult`, `ThresholdResult`, and `PrecomputeTake`. Cancellation is not an ordinary failure; an `undefined` host fallback is not a completed compaction.
- Model configuration keys are exact `provider/modelId` pairs. Internal `firstKeptEntryId: null` means a full summary; distinguish it from Pi's required empty-string representation. Update restoration metadata together with the actual summary.

## 5. Working Agreements

Apply the [root working agreements](../../AGENTS.md). After code changes, run `pnpm typecheck` from this package directory. No unit-test script is declared here. Type checking alone does not establish compaction behavior, live model access, or Bridge interoperability.
