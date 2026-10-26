# Changelog

## [Unreleased]

### New

- Extract and consolidate decisions and context from Pi conversations, then recall them with citations in later sessions. Choose a mode in `/codex-memory`, manage saved memories in `/codex-memory-manage`, and change settings in `/codex-memory-settings`.
- Create memory only after you pick a model and allow masked conversation copies to be sent.
- Edit and forget memories without a model call; forgotten conversations do not produce memory again. Ask the agent to remember something, and it saves the text after you confirm.
- Share memory across subfolders and worktrees of one Git repository. Read another repository's memory with per-request confirmation or saved one-way access, and import memories saved per folder before repository sharing.
- Use original user messages as extraction input even after the conversation is compacted.
- Include the extension in the `@buyong/pi-codex` bundle.
