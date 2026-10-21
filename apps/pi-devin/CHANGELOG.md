# Changelog

## [Unreleased]

### Fixed

- A broken sidekick connection now fails its task without terminating the lead Pi. Calls cancelled before handoff no longer start sidekick work, including background calls.
- Waiting on an already-running background sidekick task no longer delivers the same report twice. Completed background tasks no longer accumulate delivery bookkeeping in long sessions.
- Sidekick report limits now include error reasons and notices on every delivery path. Saved full reports include the same status, error and report text as the delivered report.
- Requests no longer fail with "OAuth refresh failed for devin: connect ECONNREFUSED" when only the pre-request login check cannot reach the Devin server. The request is sent with the stored session, and a real outage reports the connection error itself.
- Model requests whose connection is refused, reset, times out or ends mid-response, and Devin `unavailable` or HTTP 502–504 errors, are now retried automatically by Pi.
- Several Pi sessions using Devin at once no longer wait on each other before every request. Requests could take 15–40 seconds and occasionally failed with "Credential store read failed for devin: Lock file is already being held".

## [0.1.3] - 2026-10-20

### Fixed

- Gemini models such as `gemini-4-argon` no longer fail with "There is an issue with this request, please try a different model" when a tool's parameter schema allows `null`, as `image_gen` does. Such tools stay available and are declared with a single parameter type, like Devin's own tools.
- Claude, Gemini and GPT models no longer fail complete responses with "stopReason cannot be treated as success" or "Tool calls and the stop reason do not match". Their tool calls now run in Pi, and their final answers are kept.

## [0.1.2] - 2026-10-20

- Requests no longer fail with "Devin does not support this tool's forced sampling format" when a tool such as `codemode` declares a grammar. The grammar hint is ignored and the tool's JSON schema is sent, as Pi's built-in providers without grammar tools do. Tools that require strict sampling are still rejected.

## [0.1.1] - 2026-10-20

- "Recommended models only" now keeps model families such as `swe-2` instead of listing fixed-level variants such as `swe-2-high`, so `/thinking` picks the level again.

## [0.1.0] - 2026-10-20

First release.

- Sign in to a Devin account with Pi's `/login` (OAuth). API keys are not used.
- Pick the Devin models the account can use in `/model` and the thinking level in `/thinking`. "Recommended models only" limits the list to the models Devin marks as Recommended.
- Devin Fusion (`fusion`): the lead model hands tasks to a sidekick model through the `devin_sidekick` tool. Choose the pair with `/devin-fusion`. The lead receives at most about 131,072 tokens of each sidekick report.
- `/devin` shows quota and session usage and changes display settings. Outside the TUI, settings change through arguments.
- Prompt cache: short by default. `PI_CACHE_RETENTION=long` is allowed only for models Devin marks with a 24-hour cache.
- The protocol schema ships as `.proto` sources in `proto/`, loaded directly at runtime.
