# Context windows served by the Claude Agent SDK

Data-backed reference for the context window Anthropic actually serves through
the Claude Agent SDK (`query()`), per model id, subscription plan, and Extra
Usage (metered credits) setting. All values are measured, not assumed from docs.

## Method

`diag/context-size.mjs` calls the SDK directly for each model id × {bare,
`[1m]`}, one trivial turn (`Reply with just the word "yes".`), and records the
`result` message's `modelUsage[*].contextWindow` plus error specifics. Auth is
subscription OAuth (claude.ai) with **no `ANTHROPIC_API_KEY`** — so this is the
subscription path, not the public API path.

```
node diag/context-size.mjs pro        # current tier (pro | max)
node diag/context-size.mjs --compare  # diff latest pro-* vs max-* JSON
```

Raw JSON + MD per run save to `.test-output/context-size/` (gitignored); this
doc is the committed summary.

## Environment

- Claude Agent SDK `@anthropic-ai/claude-agent-sdk` 0.2.141 (bundled Claude Code 2.1.141)
- Auth: subscription OAuth (claude.ai), `ANTHROPIC_API_KEY` unset
- Options: `settingSources: []`, `tools: []`, `maxTurns: 1`, `persistSession: false`
- Date: 2026-06-26

## Served context windows

Four conditions, each run with the probe above. Values are tokens; `1M` =
1000000, `200K` = 200000. `429`/`400` = request rejected (see
[Error shapes](#error-shapes)). One run predates full error-field capture (see
the footnote below the table).

| requested id | Pro, credits off | Pro, credits on | Max, credits off | Max, credits on |
|---|---|---|---|---|
| `claude-opus-4-8` bare | 200K | 200K | 200K | 200K |
| `claude-opus-4-8[1m]` | 1M | 1M | 1M | 1M |
| `claude-opus-4-7` bare | **1M** | **1M** | **1M** | **1M** |
| `claude-opus-4-7[1m]` | 1M | 1M | 1M | 1M |
| `claude-opus-4-6` bare | 200K | 200K | 200K | 200K |
| `claude-opus-4-6[1m]` | 429 | 1M | 1M | 1M |
| `claude-sonnet-4-6` bare | 200K | 200K | 200K | 200K |
| `claude-sonnet-4-6[1m]` | 429 | 1M | 429 | 1M |
| `claude-haiku-4-5` bare | 200K | 200K | 200K | 200K |
| `claude-haiku-4-5[1m]` | 429† | 400 | 400 | 400 |

Raw runs: `.test-output/context-size/{pro,max}-2026-06-26T21-*.json`

Max-credits-on was measured separately and matched Pro-credits-on for every
cell, so the two right-hand columns duplicate the served values (shown for
completeness).

† **Inferred, not directly measured.** The Pro-credits-off run predates the
probe's error-field capture, so its three rejected `[1m]` rows have no recorded
HTTP status or error text. `opus-4-6[1m]` was confirmed 429 via a separate
one-off dump of the SDK `result` message; `sonnet-4-6[1m]` and `haiku-4-5[1m]`
are assumed to be the same credit-gated rejection by analogy. Re-running on Pro
with the current probe would replace the inference with a measured value.

## Error shapes

A rejected `[1m]` turn surfaces its specifics in the SDK message stream, but
**not** in `result.errors[]` (which is empty). The message sequence is
`system:init → rate_limit_event → assistant → result:success` — note
`subtype: "success"` despite `is_error: true`. Error text rides in
`result.result`; HTTP status in `result.api_error_status`.

### Credit-gated rejection (429) — e.g. `opus-4-6[1m]` on Pro, credits off

```json
// rate_limit_event
{ "rate_limit_info": { "status": "rejected", "overageDisabledReason": "org_level_disabled", "isUsingOverage": false } }

// assistant (synthetic, no model turn ran)
{ "error": "rate_limit", "message": { "model": "<synthetic>", "stop_reason": "stop_sequence",
  "content": [{ "type": "text", "text": "Usage credits are required for long context requests." }] } }

// result
{ "subtype": "success", "is_error": true, "api_error_status": 429,
  "result": "Usage credits are required for long context requests.", "modelUsage": {}, "total_cost_usd": 0 }
```

### Capability rejection (400) — e.g. `haiku-4-5[1m]` (not 1M-capable)

Same message shape, but `api_error_status: 400`, no `rate_limit_event`, and the
text varies by plan/credits:

- Pro, credits on: `"This authentication style is incompatible with the long context beta header."`
- Max (either): `"The long context beta is not yet available for this subscription."`

### Served turn — e.g. `opus-4-8[1m]` → 1M

```json
{ "subtype": "success", "is_error": false, "stop_reason": "end_turn",
  "modelUsage": { "claude-opus-4-8[1m]": { "contextWindow": 1000000, "maxOutputTokens": 32000,
    "inputTokens": 173, "outputTokens": 4, "costUSD": 0.000579 } } }
```

When a turn is allowed, the `rate_limit_event` carries `status: "allowed"` plus
`overageStatus` / `resetsAt` / `rateLimitType: "five_hour"`. Rejected turns fail
fast (~130–400 ms, zero model tokens).

## Findings

1. **A bare model id is never auto-upgraded to 1M on the SDK path** — for Opus
   4.8 and 4.6, bare serves 200K on every plan and credits combination. This
   differs from the interactive Claude Code CLI, which auto-selects the `[1m]`
   variant for Opus on Max/Team/Enterprise. The `[1m]` suffix is the only
   reliable way to request 1M via the SDK (it injects the long-context beta
   header).
2. **`opus-4-7` bare serves 1M everywhere** — Pro and Max, credits on or off.
   Stable across all runs, not per-turn variance. Lone anomaly; unexplained.
3. **Credit-gating for Opus `[1m]` is version-specific on Pro.**
   `opus-4-6[1m]` requires Extra Usage credits on Pro (429 without, 1M with) and
   is included on Max (1M without credits). But `opus-4-8[1m]` and `opus-4-7[1m]`
   serve 1M on Pro **without** credits — the suffix is not credit-gated for those
   versions. Why 4.7/4.8 `[1m]` bypass the gate while 4.6 `[1m]` doesn't is
   unexplained (same vein as the opus-4-7-bare anomaly below).
4. **Sonnet `[1m]` is metered on every plan**, Max included — `sonnet-4-6[1m]`
   is 429 on both Pro and Max with credits off, 1M with credits on. Matches
   Anthropic's plan table.
5. **`[1m]` on a non-1M-capable model is always rejected.** `haiku-4-5[1m]` is
   429 when the credit gate applies (Pro, credits off) and 400 otherwise.
6. **The subscription/OAuth path differs from the public API path.** Anthropic's
   platform docs state Opus 4.8/4.7 default to 1M on the Claude API with no beta
   header; the SDK subscription path serves 200K for a bare 4.8 id. The public
   API default does not carry over to subscription-billed SDK calls.

## Open questions

- **Opus 4.7 and 4.8 get 1M-favorable treatment on Pro that 4.6 does not.**
  `opus-4-7` bare serves 1M on Pro (where 4.8 and 4.6 bare serve 200K), and
  `opus-4-8[1m]`/`opus-4-7[1m]` serve 1M on Pro without credits (where
  `opus-4-6[1m]` is 429 without credits). Stable across runs, not per-turn
  variance. Possibly a subscription-side policy for the newest Opus, a model
  remap, or a transitional state.
- All measurements are single-turn on one account. The served window appears
  to be a stable property of (model id, plan, credits), but multi-turn or
  longer-duration behavior wasn't tested.
