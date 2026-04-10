# Per-Turn Queries

Replace the current single long-running `query()` with a fresh `query()` per turn.
Tool results are injected into the session JSONL between turns rather than delivered
via blocking MCP handlers.

## Status: Core architecture validated (2026-04-10)

Validated via throwaway spike:
- `tool_use` blocks stream before MCP handlers resolve (non-blocking observation works)
- Manually-built session JSONL is respected on `resume` (SDK reads tool_result from disk)
- `persistSession: false` prevents the SDK from writing any JSONL
- `resume` works against a cc-session-io-written JSONL with `persistSession: false` on
  the resuming query (the linchpin — confirms we can fully own the session file)

## What It Eliminates

- `activeQuery` tracking
- `pendingToolCalls` / `pendingResults` maps
- `queryStateStack` save/restore
- Deferred-steer-replay mechanism (`deferredUserMessages`)
- Reentrant call path complexity

## How It Works

```
Turn 1:  query(prompt, {persistSession: false, mcpServers, resume?})
         → stream yields assistant message with tool_use blocks
         → close query immediately (handlers never block)

         Pi executes tools externally, gets results.

         Write session JSONL (we own it exclusively):
           user[prompt] → assistant[tool_use] → user[tool_result]

Turn 2:  query(continuation_prompt, {resume: sessionId, persistSession: false, mcpServers})
         → model sees tool_result in history, continues
         → if it calls more tools, repeat
```

## Implementation Steps

### Phase 1: Session JSONL ownership

Use `persistSession: false` on all `query()` calls. Maintain our own message array
and write the session JSONL via cc-session-io after each turn.

### Phase 2: Non-blocking tool emission

Replace `buildMcpServers` handler logic:

- Handlers resolve immediately with a sentinel (empty string)
- After the stream yields a complete assistant message (stop_reason: "tool_use"),
  call `query.close()`
- Extract tool_use id/name/input from the streamed message
- Return control to Pi for tool execution

### Phase 3: Inter-turn session reconstruction

After Pi executes tools:

- Append assistant[tool_use] + user[tool_result] to our message array
- Write full session via cc-session-io `createSession` + `importMessages` + `save`

### Phase 4: Resume

- Next provider call does `query({prompt, options: {resume: sessionId, persistSession: false}})`
- Model sees complete history including correct tool results
- If model calls more tools, repeat from Phase 2

### Phase 5: Steer handling

Steers become trivial — just another `query()` call:

- Close current query (if in-flight)
- Append steer text as a user message to the session
- Start a new `query()` with resume

## Edge Cases to Validate During Implementation

- **Thinking blocks on resume** — cc-session-io supports them, but extended thinking
  has signatures. Does the SDK accept resumed sessions containing thinking blocks it
  didn't write itself?
- **Multi-block assistant messages** — model often emits `text → tool_use → text` in
  one message. Capture the full message (wait for stop_reason: "tool_use") before
  closing, and confirm cc-session-io writes it back in a form the SDK accepts on resume.
- **Abort mid-turn** — if Pi aborts before we write the tool_result, the session has
  an orphaned tool_use and can't be resumed. Either drop the orphaned tool_use from
  the JSONL, or write a synthetic "aborted" tool_result.
- **Prompt caching on resume** — should work since cache keys are content-based,
  but worth measuring to confirm no regression.
- **`result` message on early close** — does usage/cost info still arrive if we close
  the query after tool_use but before the turn naturally ends?
