# pi-claude-compact

Claude Code's context compaction, rebuilt as a Pi extension. The engine, prompt, and limits follow Claude Code 2.1.296; the plumbing uses Pi's own seams.

## What it does

- **Partial-preserve engine.** The conversation is split into rounds (one assistant response plus what follows it). Every round but the last is summarized; the last stays verbatim. When the summary request itself is too long, more trailing rounds are kept, sized from the overage the provider reports (`N tokens > M`), or one round at a time when no number is given. When nothing summarizable is left, a large opening round is first summarized on its own; failing that, and only where Claude Code allows it (context at the blocking limit, overflow recovery, `/compact`), it keeps only the unanswered user turn and trims the oldest rounds, at most three times, and the summary says so.
- **Deeper pass.** When the compacted context would still be over the blocking limit, its summary and kept rounds are compacted once more. Claude Code does this after a second rejection; Pi retries an overflow only once and finds nothing to compact right after a compaction, so the second pass runs before the result is used.
- **Claude Code's summary prompt.** The 9-section `<analysis>` + `<summary>` prompt, including the user-attribution and security-constraint rules. The analysis is discarded, and the summary is wrapped with Claude Code's continuation text, the session file path, and a note that the verbatim tail after it was not seen by the summarizer.
- **Post-compact restore.** Up to 5 recently read, edited, or written files are re-read from disk (5k tokens each, 50k total) and skills loaded earlier are restored (5k each, 25k total). A file over 5k tokens is not cut: only a note pointing at it is restored. A file read in the verbatim tail is skipped, a SKILL.md is restored once as a skill, and only calls that succeeded count: a read that a permission extension blocked is never replayed. An earlier restore is carried over from its compaction entry's details, never from summary text.
- **Media errors.** When a summary request is rejected for media size, images are replaced with `[image]` and it is retried. When the main request is, the failed reply is dropped, the conversation is compacted (without trimming the head), and the run continues, once per run.
- **Breakers, per run as in Claude Code.** Automatic threshold compaction (this extension's and Pi's own) stops for the rest of a run after 3 consecutive failures. A run is stopped when compaction is needed again within 3 turns, 3 times in a row, including overflow recovery. Both reset when the run settles; failed overflow recovery and `/compact` do not count.
- **Precompute (off by default, as in Claude Code).** Once context passes the precompute point, a summary is prepared in the background and reused at the threshold if the entries it covered are still the head of the context with the same content, and the result still fits under the threshold.

## How it fits into Pi

- Auto-compaction runs at `turn_end` and returns a compaction entry draft, so the run continues with the compacted context and nothing is aborted. Media-error recovery uses the `agent_before_settle` boundary the same way and asks Pi to continue.
- Pi's own compaction stays enabled as the safety net, because disabling it also disables overflow recovery. Its threshold, overflow, and `/compact [instructions]` compactions are taken over through `session_before_compact` and run through the same engine. Pi only raises that event when its own preparation finds something to compact.
- With `@buyong/pi-claude-bridge`, the bridge stands its own compaction takeover down for each session this extension serves. Summaries for bridge models go through the bridge's isolated one-off path, which forwards text only, so images reach the summarizer as `[image]`. Boundary compactions notify the bridge so a parked Claude Code query is rebuilt from the compacted history, and while a tool result is pending the last tool round is always kept so the bridge can match it.

## Thresholds

Per model, as in Claude Code: with `R = min(maxTokens, 20000)` and the compaction window `W` (the context window unless set lower):

| | |
| --- | --- |
| compact | `W - R - 13000`, or a percent of `W - R` capped there |
| warn (footer status) | compact - 20000 |
| block (Pi safety net target) | `contextWindow - R - 3000` |
| precompute | `min(0.8 * (W - R), compact)` |

A 200k model with 32k output compacts at 167k, warns from 147k, and blocks at 177k.

## Commands

- `/claude-compact` — menu, or one of:
  - `status` — thresholds per scoped model, the summarizer, and whether Pi's own trigger fires first.
  - `threshold [provider/model]` — set a threshold (`600k`, `80%`) or a compaction window, validated against the model.
  - `safety-net` — moves Pi's own trigger (`compaction.modelOverrides[...].reserveTokens` in the global `settings.json`, written under Pi's settings lock) up to the blocking limit for models where it fires first. Where Pi had an override and claude-compact has none, that old trigger point becomes the claude-compact threshold. A project `.pi/settings.json` override still wins and is reported. Takes effect after restarting Pi.
  - `on` / `off` — engine switch.
  - `precompute [on|off]`.
- `/claude-compact-model` — summarization model: the conversation model (default) or a scoped model, with a fallback to the conversation model on failure (`fallback on|off`). Warns when the chosen model's window is smaller than a scoped model's threshold.

## Configuration

`~/.pi/agent/claude-compact.json`, written by the commands:

```json
{
  "enabled": true,
  "precompute": false,
  "summaryModel": null,
  "fallbackToConversationModel": true,
  "models": {
    "openai/gpt-6-astra": { "threshold": "500k" },
    "claude-bridge/claude-opus-5-5": { "window": 400000 }
  }
}
```

## Differences from Claude Code

- Compaction is always proactive. Claude Code compacts ahead only when the window comes from settings, server data, an experiment, or a model default; for a recognized model at its default window it waits for the API to reject the request and compacts then. Pi's overflow detection depends on each provider's error wording, so this extension does not rely on it.
- The check runs after each turn, not before each request: a new prompt that crosses the threshold is compacted after its first response, or by Pi's own trigger before it.
- The conversation is sent as one transcript to a summarizer with a dedicated system prompt, not as a fork that shares the main prompt cache; project-level "compact instructions" in AGENTS.md are not seen unless passed to `/compact`. Non-user turns are tagged by origin (`<previous_summary>`, `<branch_summary>`, `<context>`), and failed or aborted replies are left out, as Pi's providers leave them out of requests.
- Thinking blocks are left out of the summarizer input and the summary request runs without extended thinking.
- Restored files and skills are part of the summary text, before the verbatim tail; Claude Code attaches them after it.
- Not ported: compacting with a larger-context model used earlier in the session, partial compaction from a selected message, the credits-boundary clamp, plan mode, task status, and compaction hooks.

## License

MIT
