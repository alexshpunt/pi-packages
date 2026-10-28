# Changelog

## [Unreleased]

## [0.1.0] - 2026-10-28

### New

- Extract and consolidate decisions and context from Pi conversations, then recall them with citations in later sessions. Turn memory on, choose its models and scope, and manage saved memories in `/codex-memory`; change timing and limits in `/codex-memory-settings`.
- Memory starts off, and turning it on asks for consent to send masked conversation copies. Memories and the summary each use the current Pi model or a model chosen from `/scoped-models`.
- Turn closed conversations into memory in the background: one open Pi session per scope runs up to 8 conversations at once, and another open session takes over when it closes. By default a conversation becomes memory 2 hours after its last message, the summary is updated at most every 2 hours, and conversations from the last 7 days are used. **Create memories now** in `/codex-memory` runs this without the wait, and every session in the scope shows running jobs in the status bar.
- Edit and forget memories without a model call; forgotten conversations do not produce memory again. Ask the agent to remember something, and it saves the text after you confirm.
- Share memory across subfolders and worktrees of one Git repository. Read another repository's memory with per-request confirmation or saved one-way access.
- Use original user messages as extraction input even after the conversation is compacted.
- Include the extension in the `@buyong/pi-codex` bundle.
