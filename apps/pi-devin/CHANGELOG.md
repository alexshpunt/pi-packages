# Changelog

## [Unreleased]

### Improved

- The extension now runs on Effect 4 internally. Requests, sign-in, model list refreshes, `/devin`, `/devin-fusion` and the Fusion sidekick behave as before. Installing the package now also installs its runtime dependencies `effect` and `@effect/platform-node`.

## [0.1.5] - 2026-10-21

### Improved

- Pi checks the Devin login session again once a day instead of before every request, so Devin requests and model list refreshes no longer take Pi's shared `auth.json` lock and rewrite the file each time. Sessions saved by earlier versions keep working and are checked on their next use.
- Signing in again to the same Devin account lists its models at once instead of waiting for the list to download again. Another account still sees none of the previous account's models.
- The package now ships a Korean README (`README.ko.md`), and the README explains how to check a project-scoped installation.

### Fixed

- The status line and `/devin` now include the Devin quota used by subagents and the Fusion sidekick that share the Pi agent directory. Before, the quota changed only when the current Pi session itself sent a Devin request, so it stayed the same when Devin ran only in subagents.
- The status line's token totals now include the response that just finished. Before, they lagged one response behind during runs with tool calls.
- The quota in the status line now updates right after sign-in, sign-out and each account check instead of waiting for the next response.

## [0.1.4] - 2026-10-21

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
