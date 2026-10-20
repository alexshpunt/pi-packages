# Changelog

## [Unreleased]

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
