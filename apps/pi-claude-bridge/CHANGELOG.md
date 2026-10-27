# Changelog

## UNRELEASED

### Improved

- The bridge now uses Claude Code 2.1.311 (Agent SDK `^0.3.311`).
- Pi MCP tools reach Claude Code with the `_meta` their server declared, unchanged. If the server declares `anthropic/maxResultSizeChars`, its value replaces the bridge's default of 500,000. The bridge reads this `_meta` from `meta` in `pi.getAllTools()` and from extensions that answer `tool-meta` requests on `pi.events`, such as `@buyong/pi-mcp-adapter`; Pi 1.4.0 needs such an extension.

### Fixed

- Pass Pi tool results to Claude in full up to 500,000 characters. Claude Code used to save a result over 50,000 characters to a file and show Claude only a 2KB preview, and replaced one over 25,000 tokens with an error naming that file, because the bridge did not declare `anthropic/maxResultSizeChars` on its tools. Results already replaced in an earlier turn keep their preview.

## 0.13.1 — 2026-10-21

### Improved

- The README is rewritten in English, and the package now ships a Korean README (`README.ko.md`). It adds a first-request check, an update and removal table, and a license section.

## 0.13.0 — 2026-10-21

### Improved

- The bridge now uses Claude Code 2.1.304 (Agent SDK `^0.3.304`).
- Avoid serializing tool results for debug previews when debugging is off.
- Document diagnostic and CC CLI log locations and manual cleanup; logs are not rotated or deleted automatically.

### Fixed

- On Pi 1.3.0, Haiku 5.5 no longer offers turning reasoning off. Claude Code keeps thinking on for this model, so choosing off had no effect.
- Ignore non-object configuration files without blocking startup or overwriting their contents.
- Keep diagnostic write failures from interrupting provider calls or hiding the original error.
- Show non-streamed assistant replies only once when Claude Code repeats them in the final result.
- Report token usage for isolated summaries, skip already canceled requests, and distinguish cancellation from other failures.
- Release shared hooks after shutdown even when the last query or session finishes later.
- Expand home-relative agent directory overrides in the documented manual log cleanup commands.
- Replace the global config in one step when recording the startup notice or detected plan, so a Pi process or sub-agent starting at the same moment no longer reads a partial file and runs without the user's settings. A symlinked config stays a symlink.

## 0.12.0 — 2026-10-20

- **Fix: forward only completed tool calls and compatible MCP schemas** — Drop unfinished streamed blocks before dispatch (elidickinson/pi-claude-bridge#146), flatten top-level schema combinators for Claude Code while retaining Pi-side validation (elidickinson/pi-claude-bridge#180), and stop injecting an unrequested bash timeout (elidickinson/pi-claude-bridge#204).
- **Fix: recover interrupted and rewritten conversations** — Resume tool results after restart (elidickinson/pi-claude-bridge#174), rebuild shortened session histories instead of starting without context (elidickinson/pi-claude-bridge#191), and keep failed turns from advancing the synchronization cursor (elidickinson/pi-claude-bridge#198, retry handling only). Rebind cancellation to the current run, detach the previous run's listener, and report cancellation consistently on normal and error completion (elidickinson/pi-claude-bridge#200).
- **Fix: preserve session cwd and reasoning options** — Run provider and isolated summary queries in the owning session's directory (elidickinson/pi-claude-bridge#175). Forward isolated-call reasoning through model-specific effort mappings (elidickinson/pi-claude-bridge#184), and explicitly disable SDK thinking when Pi requests off and the model supports it (elidickinson/pi-claude-bridge#209). 현대 Claude 모델의 추론 켜짐에는 타입 있는 adaptive·summarized 옵션을 provider와 요약에 공통 적용하며, 기존 4.5 모델과 항상 추론하는 모델의 예외는 유지한다.
- **Add: expose subscription usage through response headers** — Translate SDK usage-limit events into `anthropic-ratelimit-unified-*` headers for `after_provider_response` consumers (elidickinson/pi-claude-bridge#171), keeping deferred events query-local. Label exhausted subscription windows as quota exhaustion so Pi does not retry them as transient rate limits.
- **Add: preserve explicit prompt and tool guidance** — Forward additional guidelines and snippets for selected, non-hidden tools, including SDK customTools, without classifying SDK registration as built-in-only behavior. Copy captured guidance, retain it through prompt inheritance, deduplicate rules, and validate raw instructions before formatting.

- **Bump: Agent SDK `^0.3.303`** — Claude Code 2.1.303을 사용한다. SDK와 플랫폼별 바이너리만 올리고 다른 의존성과 패키지 버전은 유지한다.
- **Tests: Haiku 5.5로 통합 검증 전환** — 실행 대상 통합 테스트가 Haiku 5.5를 사용하고, 컴팩션 임계값은 브리지의 등록 창 크기에서 계산한다. 첨부파일 대조군은 임시 cwd와 무작위 토큰으로 격리하고 도구·hook·메모리를 차단한다. 길이 초과 오류와 추론 사용량 계약은 로컬 모의 API로 재현하며, Git 캐시 검사는 CC 프롬프트의 고정 문구 대신 테스트 고유 표식으로 요청을 찾는다. 도구 결과 기록 검사는 `api-request-blob` 메타데이터를 대화 레코드와 구분하고 호출 ID의 정확한 대응도 확인한다.

- **Remove: provider 전용 확장으로 정리** — AskClaude 도구·설정·전용 UI와 native 도구 이름 변환, `change-case` 의존성을 제거한다. 기존 활성화 설정에는 TUI에서 프로세스당 한 번 제거 안내를 표시하며 설정 파일에는 기록하지 않는다. 컴팩션과 branch summary는 pi와 요약 확장에 맡기고, isolated 요약 요청·세션 cwd·기록 변경 알림은 유지한다.

- **Refactor: 브리지 책임 모듈과 SDK 옵션 경계 분리** — 등록·env·실행 설정·요청 옵션·mirror·스트림·도구 연결·완료 처리·isolated 요약을 나누고 런타임별 쿼리 주입 지점을 통일한다. 비필수 트래픽 차단 값은 호스트 대신 자식 env에 적용한다. 기존 등록·스트림 계약과 SDK 전달값을 유지하며, 배포에 불필요한 이미지 파일은 묶음에서 제외한다.

- **Tests: 공용 모듈 기반 검증 CLI** — 옵션·최종 SDK 인자·실제 MCP 왕복 검사를 자동 발견하고 버전·소스 해시·사용량을 기록한다. 실제 호출은 명시적 실행과 구독 OAuth·Haiku 5.5로 제한하며 임시 세션을 정리한다. 요청 원문 대신 해시를 남기고 기존 진단 프록시의 공통 처리부를 재사용한다.

- **Fix: Claude Code 실행 경계 교정** — 부모 세션 표식을 자식 환경에서 제거하고 인증·서버 연결 값은 보존한다. provider와 요약의 사용자·프로젝트 hook을 끄고 요약은 기본 설정 소스를 읽는다. provider 권한은 브리지 MCP만 허용하는 `dontAsk`로 바꾸며 CC 자체 MCP 차단을 항상 적용한다. `provider.strictMcpConfig` 설정은 제거해 남아 있는 값도 무시한다. 브리지 도구 호출과 cwd 밖 `@file` 확장은 실제 실행에서 유지됐다.

- **Fix: 요청 프롬프트 갱신과 모델 전달** — provider의 preset에 `snapshot: false`를 적용해 resume에도 현재 pi 지침을 전달하고, 모델은 중복 없는 타입 옵션으로 넘긴다. Haiku 5.5를 명시적 `[1m]`·1M 창으로 등록해 실제 제공 값과 맞춘다. 캐시 회귀는 기존 snapshot 대조군과 격리된 동일 조건으로 비교한다.

- **Fix: rebuild 내용·저장 파일과 재시작 연결 보존** — 예외 뒤에도 mirror ID와 cursor를 유지하고, 문맥 attachment와 도구 결과의 실제 MCP 표현·키 순서를 복원한다. 이미지·큰 결과는 현재 Pi 내용과 일치할 때만 재사용하며 같은 UUID의 `tool-results/`를 보존한다. 읽기는 같은 프로젝트의 일반 파일·비심볼릭 링크·32MiB 이내로 제한한다. 현재 Pi 브랜치의 비공개 연결 기록으로 재시작 시 자료를 찾아 새 CC 세션을 만들고, 세션별 쓰기 핸들로 기록 대상을 분리한다. CC 2.1.303의 일반 resume에서도 남는 마지막 system 메시지 캐시 차이는 해결했다고 주장하지 않는다.

- **Fix: Pi 세션별 쿼리 상태와 재진입 판정** — 프로세스 단일 최상위 쿼리 상태를 런타임의 Pi 세션별 상태로 나눈다. 다른 세션이 도구 결과를 기다리는 동안에도 짧아진 이력은 자기 세션 기록으로 rebuild하고, 중단 뒤 고아 도구 결과는 자기 세션에 진행 중인 쿼리가 없으면 그 세션의 cursor만 갱신한다. 같은 세션의 재진입과 세션 ID 없는 호출의 `(none)` 동작은 유지한다. `session_shutdown`은 실제로 그 세션을 제공하는 모듈 인스턴스까지 해당 세션 상태만 정리하며, 실행 중인 쿼리와 다른 세션의 쿼리는 종료하지 않는다.

- **Tests: 컴팩션 통합 테스트 제거와 캐시 검사 분리** — Pi가 담당하는 컴팩션을 실제 모델로 구동하던 `int-compact-*`·`int-session-compact` 통합 테스트 6개와 전용 fixture를 없앤다. 이력 변경 뒤 폐기·rebuild를 검사하는 unit 테스트는 유지한다. 캐시 측정 검사와 `int-cache.sh`는 선택 사항으로 돌려 `verify --all`·`test`에서 빼고 `verify --cache`·`test:cache`로만 실행한다. 재시작 연속성 검사는 연결 계약과 내용 보존만 판정한다.

- **Fix: 다시 불러오기와 세션 교체 뒤 전역 훅 누적 방지** — `/reload`·`/new`·`/resume`·`/fork`마다 새 모듈 인스턴스가 rebuild·세션 정리 훅을 추가하고 이전 인스턴스의 훅은 남던 문제를 고친다. 자기 `session_shutdown` 뒤 쿼리 상태가 없는 인스턴스는 두 훅 레지스트리에서 빠지고, 이전 레지스트리를 통해 다시 호출되면 stream 진입 때 재등록한다. 레지스트리 키와 `Set` 구조는 그대로라 `pi-claude-compact`의 호출은 바뀌지 않는다.

- **Fix: Pi 1.x 기준으로 패키지 요구사항 정리** — Node 엔진 요구를 Pi와 같은 22.19.0 이상으로 올리고, `src/`에서 쓰지 않는 `pi-tui`·`typebox` peer 선언을 제거한다. 모델 목록이 비었을 때의 안내도 Pi 1.0.0 이상 기준으로 바꾼다.

- **Add: Claude Code 로그인으로 요금제 자동 판별** — `provider.plan`이 없으면 첫 provider 쿼리에서 `accountInfo().subscriptionType`을 읽어 Max·Enterprise는 `max`, Pro는 `pro`로 적용한다. 추가 모델 요청은 없다. 값이 바뀌면 provider를 다시 등록해 현재 세션의 Opus 4.6 문맥 크기에 바로 반영하고, 전역 설정의 `detectedPlan`에 기록해 다음 시작부터 사용한다. 명시적 `provider.plan`이 항상 우선하며, Team처럼 판별할 수 없을 때만 Opus 4.6 기준으로 고친 요금제 안내를 한 번 표시한다.

## 0.11.0 — 2026-10-18

- **Refactor: move into pi-packages** — Keep the `@buyong/pi-claude-bridge` npm identity while preserving the source history under `apps/pi-claude-bridge`. Development uses the root pnpm workspace; releases use package-specific tags and the monorepo's npm trusted publisher. Repository, support, and contributor links now point to the monorepo. Upstream updates remain manual and are documented rather than automatically connected.

- **Add: defer compaction to pi-claude-compact** — While `@buyong/pi-claude-compact` is loaded and enabled for the pi session being compacted, the `session_before_compact` takeover for bridge models stands down and that extension's Claude Code-style engine compacts instead. Its summary requests still reach Claude Code through the isolated one-off path (`cacheRetention: "none"`), and its boundary compactions (after a turn, or before the run settles to recover from a media-size error) report the history rewrite through the existing `claude-bridge:markRebuildHooks` registry, so parked queries rebuild as they do after `session_compact`.

## 0.10.1 — 2026-10-08

- **Remove: interim Claude Sonnet 5.5 entry, now that pi-ai lists it** — pi-ai 0.99.1 brings `claude-sonnet-5-5` with 1M context, so the entry 0.10.0 built from Sonnet 5's metadata is gone and pi-ai's own metadata applies; dev peers move to `^0.99.1`. With pi-ai 0.99.1 or later, Sonnet 5.5 keeps its 1M context and stays what `claude-bridge/sonnet` selects; on older pi-ai it no longer appears in `/model` until pi is updated.
- **Fix: synthetic failure notices no longer stream as assistant output (#162)** — keeps pre-output failover working for consumers like pi-model-fallback-alias; the notice text stays on the failed turn's error event. A notice following a stalled stream also drops the dead stream's abandoned partial blocks.
- **Fix: system prompt sections survive prompt capture (issue #153)** — pi 0.99.2+ adds an `mcp_servers` section through its MCP extension. The transcript replay now ranks unlisted sections after the built-ins, matching pi's builder, so the capture key matches instead of failing every turn; and recorded sections are projected to Claude Code instead of being silently dropped. The failure message points at a section-order divergence instead of blaming extension load order.
- **Fix: duplicate AGENTS.md instructions (#151)** — Exclude Claude Code's native copy, matching the existing CLAUDE.md exclusions.
- **Fix: unresolvable or refused system prompt ends the turn as a stream error (#124)** — The prompt-capture checks end the returned stream with an error event instead of throwing out of the provider call, so callers outside pi's agent loop see a failed turn too. The fallback to the freshest capture proposed in #124 is not included: an unmatched mid-query turn still fails, now as a failed turn rather than a throw. Thanks @jmtoepperwien.
- **Fix: thinking tokens never reached pi's `usage.reasoning` (#139)** — Read the SDK's nested `output_tokens_details.thinking_tokens`, as pi's own Anthropic provider does. Reasoning stays a subset of output tokens and out of cost. Thanks @cmembreno048.
- **Fix: write the debug and diagnostics logs into pi's agent dir (#147, #164)** — Honour `PI_CODING_AGENT_DIR` instead of always writing to (and recreating) `~/.pi/agent`; `CLAUDE_BRIDGE_DEBUG_PATH` still overrides the debug log. Paths now resolve per call instead of at import time, and the unit-test preload points `HOME` and pi's and Claude Code's config dirs at a throwaway directory, so config tests no longer overwrite real user settings. Thanks @Susensio.
- **Bump: Agent SDK `^0.3.293`** — bundles Claude Code 2.1.293, which serves Haiku 5.5; it reaches `/model` once pi-ai lists it (0.99.2 does not yet).
- **Tests: add PR CI** — Run unit tests on GitHub Actions without Claude credentials.

## 0.10.0 — 2026-09-29

- **Add: Claude Sonnet 5.5 (`claude-bridge/claude-sonnet-5-5`)** — Claude Code 2.1.284 added the model, so the Agent SDK goes to `^0.3.284` and `@anthropic-ai/sdk` to `^0.129.0` (types only); `tests/int-cc-contracts.mjs` passes unchanged. pi-ai 0.87.1, the latest release, does not list it yet, so the bridge registers an interim entry built from Sonnet 5's (Anthropic documents the same 1M context, 128K output and effort levels) and steps aside once pi-ai lists the id; requests go out as `claude-sonnet-5-5` either way. It gets 1M context: upstream measured the bare and `[1m]` ids serving 1M on Pro with and without Extra Usage and added it to the 1M list (see `diag/CONTEXT-SIZE.md`). As the newest Sonnet it is what the `sonnet` pattern now selects, so `claude-bridge/sonnet` moves from Sonnet 5 to Sonnet 5.5, both at 1M.
- **Fix: make mid-turn compaction rebuilds session-safe (issue #101)** — Restart parked queries from pi's rewritten history, with separate Claude Code mirrors per pi session. Prevents compaction loops and subagents taking over the parent's conversation; covered by `tests/int-compact-midturn-rebuild.mjs` and `tests/unit-cross-session-turns.mjs`. Thanks @andreypopp (PR #128), @chigkim, and @QuBiit0.
- **Fix: rebuild after an undelivered steer** — keep the rebuild request through successful completion, including on a first turn without a session mirror. Turn-level tests check that the next turn restores the missed message.
- **Tests: strengthen integration and cache diagnostics** — Fail runs on bridge-origin `BUG:`/stranded-handler warnings and add a rebuild-fidelity probe. The probe confirms cache loss beyond the system prompt after rebuilds on CC 2.1.263+; see `diag/AUDIT.md`.

## 0.9.1 — 2026-09-25

- **Remove: fast mode models** — the `claude-bridge/claude-fast-*` picker entries and the `claude-bridge/fast` shortcut added in 0.9.0 are gone, along with the notices relayed when Claude Code declined to serve fast mode. On a subscription fast mode bills usage credits only, never the plan's included usage, so with no credits every turn sent a fast request that was rejected and retried at standard speed. The provider path no longer sets `settings.fastMode` at all, as before 0.9.0. A session saved on a fast entry has to be switched to its standard model (e.g. `claude-bridge/claude-opus-5-5`).

## 0.9.0 — 2026-09-25

- **Add: published as `@buyong/pi-claude-bridge`, with release automation** — this fork publishes under its own scope, since `pi-claude-bridge` on npm belongs to the upstream repository; install with `pi install npm:@buyong/pi-claude-bridge`. `npm run release` (release-it) picks the version, stamps the `UNRELEASED` changelog section, and commits, tags and pushes after a confirmation at each step; the pushed `v*` tag runs `.github/workflows/publish.yml`, which publishes to npm through trusted publishing (OIDC, with provenance) and creates the GitHub Release from the changelog section. Prereleases publish under their identifier's dist-tag, never `latest`.
- **Add: fast mode models** — Opus 5.5, Opus 5 and Opus 4.8 each get a fast picker entry (`claude-bridge/claude-fast-opus-5-5`, …; `claude-bridge/fast` selects the newest) that runs the same model with Claude Code's fast mode: up to 2.5x output speed at premium rates, paid from usage credits only on a subscription. Claude Code serves fast mode to an SDK host only through flag settings, so the provider path now always sets `settings.fastMode` (true for a fast entry, false otherwise), which keeps a `fastMode` saved by `/fast` in `~/.claude/settings.json` from reaching standard entries. The marker is a prefix rather than a `-fast` suffix because pi resolves a partial `--model` pattern to the matching id that sorts highest, and a suffixed id sorts above its base: `claude-bridge/opus` would have resolved to `claude-opus-5-fast`. When Claude Code runs a fast entry at standard speed anyway (no usage credits, organization policy, rate-limit cooldown) the bridge relays the reason once per cause. Verified against local capture servers (no request reaches Anthropic): a fast entry sends `speed: "fast"` with the `fast-mode-2026-02-01` beta, a standard entry sends neither, and the beta does not carry across `--resume`, so every switch between a model's fast and standard entries re-reads the conversation uncached (see README).
- **Bump: Agent SDK `^0.3.282` (Claude Code 2.1.282), `@anthropic-ai/sdk` `^0.128.0` (types only)** — `tests/int-cc-contracts.mjs` passes unchanged, including the in-process MCP server contract that 0.3.281's move of the MCP handshake into the SDK could have broken.
- **Fix: reject leaked pi harness prompts (issue #88)** — Prompts that somehow still reference pi's harness now fail loudly instead of being forwarded and potentially being billed as extra usage. See note in README.
- **Fix: AskClaude reports its effective configured defaults (issue #65)** — its schema, description, and TUI now agree on mode and isolation, and disabling full mode removes it from the enum.
- **Bump: require pi ≥0.86.1, drop pre-0.86 compat** — `src/transcript.ts` now replays prompt/tool state through pi-ai's helpers instead of a vendored copy (canonical section re-rank stays local). Also removes the event-stream factory fallback and version-tolerance casts. devDeps move to `^0.87.1`; Agent SDK to `^0.3.280` (the API now rejects older clients); fixes a model-catalog test bug from 0.87.1's added `claude-opus-5-5`.

- **Fix: turns hang on "Working" after a stalled response stream** — when a response stream stops arriving, Claude Code abandons it and repeats the request without streaming ("Error streaming, falling back to non-streaming mode"). The answer arrives as one `assistant` message under a new message id with no stream events of its own, and the bridge skipped it as already streamed because the dead stream had set `turnSawStreamEvent`. Its tool calls never reached pi, CC sat in the MCP handler waiting for their results, and the turn hung until the user aborted it; CC's own stall watchdog takes ~20 minutes to fire, so from the outside it looks like an agent that simply stopped. The bridge now tracks the streamed message id, treats an assistant message under a different id as the fallback, and drops the dead stream's partial blocks (an unsigned thinking block, a tool call CC will never dispatch) before delivering it. A stream retried as a new stream drops its predecessor the same way. Reproduced end to end with a proxy that stalls one response mid-message; covered by `tests/unit-nonstreaming-fallback.mjs`.
- **Add: Claude Opus 5.5 1M context (issue #116)** — `claude-opus-5-5` joins the 1M list based on Anthropic's documentation for Opus 4.7 and later; its `[1m]` SDK behavior on Pro has not yet been measured (see `diag/CONTEXT-SIZE.md`). The model appears when pi-ai ≥0.87.1 is installed; users on older pi versions need to update pi to see it.
- **Diag: measure what Opus 5.5 actually serves (issue #116 follow-up)** — `diag/context-size.mjs` probed every 1M model except the newest one, so the entry added for `claude-opus-5-5` stayed documentation-only. It is now in the probe's model list, and a run on Max with Extra Usage off records what the SDK serves: 1M/128K from the bare id *and* from `[1m]`, the Opus 4.7 shape rather than the Opus 5 one. That replaces the `—` cells in `diag/CONTEXT-SIZE.md` for Max and narrows the untested claim in the README to Pro, which nobody has run yet.

## 0.8.0 — 2026-09-20

- **Fix: pi 0.86 support (issues #106, #109)** — 0.86 moved the provider contract to `TranscriptContext`: the system prompt and tool set arrive as `role:"system"` messages, `context.systemPrompt`/`context.tools` are gone, and `summarizeForBugReport` joined as a fourth `streamFn` consumer. Every fresh session therefore took the rebuild path with zero records, wrote no session file, and failed with `WARNING session verify: file missing after save` followed by `No conversation found with session ID`. A new `src/transcript.ts` replays the transcript back into the 0.85-shaped `Context` at the stream entry points (and `syncSharedSession` filters system messages out of history), which also repairs what else 0.86 silently broke: skills/context files not projected to Claude Code (prompt capture resolved nothing), MCP tools never served — turns ran with no tools at all, and the model wrote tool calls out as prose rather than calling them — compaction and branch summaries throwing on their `[system,user]` context, and cursor arithmetic counting system messages. One-off summarizer calls — /bug has no takeover hook, and pi marks them all `cacheRetention: "none"` — now route to the isolated-summary path (separate CC process, no session sync), so a future summarizer consumer needs no bridge change. Sections are re-emitted in pi's canonical render order so the replayed prompt still matches the key prompt capture recorded (a section deleted and re-added — skills while `read`+`bash` are disabled — would otherwise land at the Map tail and fail every later turn). Mid-conversation system messages stay in the transcript space, never enter CC sessions, and the 0.85 path is byte-identical to before.
- **Add: the model picker is driven by pi-ai's catalog** — the hardcoded 8-model allowlist is gone, so a model Anthropic ships reaches `/model` as soon as pi-ai lists it, with no bridge change. Dated snapshot ids (`claude-opus-4-5-20251101`-style) stay hidden. `claude-bridge/claude-fable-5-1`, selectable as `fable` with 1M context, arrives this way.
- **Fix: 1M context goes only to models measured to serve it** — the `[1m]` id is no longer derived from pi-ai's declared window: an unentitled `[1m]` fails every turn, so only the measured set (Fable 5/5.1, Opus 5/4.8/4.7, Sonnet 5) gets it, and everything unmeasured serves the bare id at 200K until measured and added. Opus 4.7 now sends `[1m]`, Opus 4.5 and Sonnet 4.5 are newly selectable at 200K, Opus 4.6 and Sonnet 4.6 keep their plan gates, and an optimistic id can be pinned per-user with `provider.forceTwoHundredK`. Selection now prefers an exact id over a partial match, newest partial first.
- **Fix: subagent turns resolve their captured system prompt (issues #64, #91)** — captures now live in one process-wide registry, so isolated children (fresh module instances) resolve against it; `agent_start` records the prompt again after pi widens it with MCP tool descriptions, which is the prompt a subagent embeds verbatim at dispatch (measured 23,479 vs 10,988 chars at `before_agent_start`); and `turn_start` re-keys it so a mid-run re-render (tool-loadout change on 0.85.1) still resolves. A failed resolution now names the closest known capture, where it diverges and which boundary recorded it. Covered by `tests/unit-agent-start-capture.mjs`; the shapes still outside are pinned in `tests/unit-agent-start-capture-gaps.mjs` (tail-stripped inheritance #88, prompts composed outside pi's pipeline #102, prompts replaced between `turn_start` and the stream call #91).
- **Fix: claude-bridge models resolve in children given their own model registry (issue #91)** — a later bridge instance registers at `session_start` when its session's registry lacks the provider, instead of skipping registration unconditionally; it stays hands-off when the parent's registry is passed down, where re-registering would overwrite the parent's pinned stream fn. Every `claude-bridge/*` dispatch in such a child failed with "Model not found", frontmatter declaration included.
- **Fix: git-status changes no longer bust the prompt cache (issue #73)** — the `claude_code` preset embeds a git-status snapshot in the cached system block, so every git transition (new file, staging, commit) rewrote the whole conversation prefix at cache-write rates. The provider path now sets `includeGitInstructions: false`; it costs nothing there, since that path also runs CC with `tools: []`.
- **Fix: an exhausted subscription triggers fallback models (issue #58)** — Claude Code words a spent quota as "You're out of extra usage · resets 6:30pm", which matches none of the patterns retry logic (`fallbackModels`, key rotation) looks for, so the turn died as a plain error. A failure preceded by a rate-limit rejection is now labelled as one, with its limit type and reset time. Same code path: the warning no longer prints "1% used" at 98% or a 1970 reset time, and repeats only past a new 5% step rather than once per request.
- **Fix: better isolate AskClaude tool (issue #59)** — AskClaude children no longer inherit the user's `~/.claude` `CLAUDE.md` files or skill listing, and now always get Claude Code's system prompt preset instead of only when pi-side skills exist. Thanks @JAtkinsonKO.
- **Fix: bogus debug message about "record count mismatch" after switching providers** — the post-rebuild integrity check did not take `@file` expansion into account when switching providers.
- **Bump: pi-ai, pi-coding-agent and pi-tui to `>=0.85.0`** — the picker reads pi-ai's Anthropic catalog, and Fable 5.1 needs Claude Code 2.1.251+, so `@anthropic-ai/claude-agent-sdk` goes to `^0.3.267` (PR #94) and `@anthropic-ai/sdk` to `^0.124.0` (types only). With an older pi-ai the catalog yields nothing and the picker comes up empty; the bridge now says which dependency to update.
- **Tests: repair two suites** — session-resume's AskClaude turns now run after the first provider exchange (a second "recall the words" exchange in one transcript made the API refuse the request: "safeguards flagged this message"), and the branch-summary mock stubs `registerTool`, which `activate()` calls when AskClaude is enabled globally (PR #95).

## 0.7.0 — 2026-08-08

- **BREAKING: AskClaude tool now off by default** — If you want to continue using the AskClaude tool, set `askClaude.enabled` to `true` in your config (see README.md).
- **New: mid-turn steering actually works (issue #39)** — a steer sent while a tool was running used to be stashed and replayed as a follow-up after Claude's whole turn finished. The prompt is now a long-lived streaming generator and the steer is written to CC's stdin (`priority: "next"`) before the tool result is released, so CC drains it at that tool boundary and acts on it in the same turn.
- **Fix: system prompt loading** — Claude Code now receives the same global and hierarchical `AGENTS.md` / `CLAUDE.md` files that Pi loads. Config settings`provider.appendSystemPrompt` / `provider.settingSources` are no longer needed and have been removed gone). Improved compatibility with for children agent (i.e. subagents) and for other extensions that modify the system prompt. Unhandled system prompt configurations should fail loudly rather than silently discarding instructions.
- **Fix: branch summarization ran through the live provider** — rewinding or forking with "summarize" runs through the *agent's* stream function, so unlike `/compact` the request reached this provider and the live Claude Code session rather than an isolated subprocess. The bridge now takes over `session_before_tree` the way it already took over `session_before_compact`.
- **Fix: `@file` mentions were lost when a session was rebuilt** — Claude Code expands an at-mention itself (unlike pi) and stores the file's contents as an `attachment` record in its own session file; pi never sees it, so a rebuild kept the prompt text and silently dropped the file the model was reasoning about. Expansions are now carried across. Requires cc-session-io `^0.4.0`.
- **Fix: images dropped from prompts and rebuilt sessions (issue #34)** — an image followed by a trailing text preview lost the image, and tool results carrying images were flattened to text whenever the bridge rewrote pi's history into a Claude Code session. Images survive both paths now.
- **Fix: session rebuilds could corrupt turn structure** — pi records one message per tool result, and `repairToolPairing` (applied inside `Session.importMessages`, so unavoidable) only pairs results sharing the user message right after their assistant message, so tool results past the first can become `[no tool result recorded]`; a turn's results are now collected into one message placed directly after its assistant message. Minor: a turn aborted before anything streamed was rebuilt as `[incompatible content omitted]` potentially misleading the agent into thinking it is missing something. Empty turns are dropped now, while genuinely filtered content keeps its slot and label. Rebuilds also incorrectly wrote pi's bare model id instead of the resolved CLI id, dropping the `[1m]` suffix (issue #42; minor metadata fix only, since `--model` was already correct).
- **Fix: errored turns could report as a successful stop** — CC flags failures with `is_error` on a result whose subtype is still `"success"`, so the bridge duplicated the error text and finalized normally (issue #43); failed results now end the turn with `stopReason: "error"`, and the compact-summary path no longer accepts an errored result. Separately, a turn that ended on a tool call has its pi stream closed, and the guard suppressing content events for a closed stream also swallowed the `result` message, so a 429 or overload mid-tool set no `stopReason` and logged nothing (part of issue #35). The no-event stream watchdog idea in #35 has not been addressed.
- **Fix: a reentrant subagent could disturb the parent's session** — the shared session cursor was written from whichever context delivered tool results, so a background subagent dragged the parent's cursor backwards and cost its next turn a full rebuild and a flushed prompt cache. Removal from the active-context set is now guarded like the cleanups beside it, and an orphaned tool result no longer resets the live top-level context's turn state.
- **Fix: bridge could deadlock on a tool name Claude can't call** — Claude sometimes called `bash` instead of `mcp__custom-tools__bash`; CC rejected it with "No such tool available" and retried under a fresh tool_use id, but the bridge had already run the rejected call, so the retry's MCP handler waited on a result that never came. Calls for anything the bridge does not serve over MCP are now ignored. Rebuilt transcripts contributed to this by sometimes naming tools as `Bash`/`Read`/`Edit`/`Write` in past calls; those names now stay in the `mcp__custom-tools__` namespace.
- **Fix: nested tool schemas flattened (issue #44)** — converting pi schemas to Zod collapsed nested objects and dropped `anyOf`/`const`, so Claude saw only the top level of tools like `edit` and `subagent`. The MCP server now serves pi's JSON Schema verbatim.
- **Fix: tool results paired by call order** — MCP handlers took their `toolCallId` from a positional cursor, so a call arriving out of order silently paired its result with the wrong tool call. Now pairs by Claude's `_meta["claudecode/toolUseId"]` and fails loudly if it is absent.
- **Fix: Claude Code could write memory from bridge turns** — provider and AskClaude queries now disable auto-memory through the SDK; set `provider.autoMemoryEnabled` to `true` to opt in if you actually want it. Isolated compaction queries always disable it.
- **Tests: suites now drive the real code** — `tests/lib/record-sdk-streams.mjs` captures verbatim SDK streams (scrubbed, and refusing any fixture the username survived) for `tests/unit-stream-replay.mjs`, replacing hand-written messages that missed the `system/status` and `rate_limit_event` frames a real stream carries. `tests/int-shutdown-kills-cc.mjs` pins that a pi shutdown and a user abort each reap the Claude Code subprocess with a tool call in flight.
- **Tests: correctness audit tooling** — `diag/audit-{transcripts,cache,warnings}.mjs` scan session transcripts and the bridge log for silent data loss, prefix-cache breaks and stranded tool handlers, gated on `--since`; `diag/replay-write-path.mjs` replays any pi session through the rebuild. `tests/int-cc-contracts.mjs` pins the undocumented Claude Code behavior the bridge depends on against the installed SDK, and `tests/unit-convert-determinism.mjs` pins that a rebuild is deterministic and extends the previous transcript rather than rewriting it.
- **Internal: trim redundant dependencies** — pi bundles typebox and its extension loader always aliases the import to that copy, so shipping our own only made consumers install a redundant one that pi ignores. Now `peerDependencies: "*"` plus a devDependency for typechecking, as pi's packaging docs require; dev peers track pi 0.83.0. `@anthropic-ai/sdk` moves to devDependencies for the same reason — it is only ever imported for types.

## 0.6.3 — 2026-07-26

- **Add: claude-opus-5 model** — Claude Opus 5 is selectable via `/model` and the `opus` shortcut now points to it.
- **Bump: pi >=0.82.1** — required for the `claude-opus-5` model catalog entry.
- **Internal: remove obsolete QueryContext stack** — remove the unused push/pop/depth infrastructure superseded by `activeQueryContexts`.

## 0.6.2 — 2026-07-06

- **Fix: Sonnet 5 and Fable 5 with 1M context** — bare model IDs (`claude-sonnet-5`, `claude-fable-5`) are 200K context. Must pass `[1m]` suffix for both, similar to Opus 4.8.
- **Fix: xhigh thinking level hidden for Sonnet 5 and Sonnet 4.6 (issue #32)** — pi-ai ships no `thinkingLevelMap` for these models, and pi's `getSupportedThinkingLevels` requires an explicit mapping to show `xhigh` in the picker. This is a workaround for https://github.com/earendil-works/pi/issues/6371

## 0.6.1 — 2026-07-01

- **Add: claude-fable-5 and claude-sonnet-5 models** — Anthropic's Claude Fable 5 (released 2026-06-09) and Sonnet 5 (released 2026-06-30) are now selectable via `/model`. Both force adaptive thinking. The `fable` and `sonnet` shortcuts resolve to these new models.
- **Bump: pi-ai >=0.80.3** — required for claude-fable-5 and claude-sonnet-5 model catalog entries.

## 0.6.0 — 2026-06-29

- **Fix: `/compact` hang (issue #18)** — the bridge now owns compaction for claude-bridge models, running split-turn summaries as isolated Claude Code subprocesses instead of routing them through the live provider stream. File ops (`<read-files>`/`<modified-files>`) carry forward across compactions. If compaction fails it is cancelled with a notification rather than falling back to the buggy native path.
- **Fix: subagent routing (issue #19)** — provider calls from subagents while a parent query is active now start a nested query instead of being mistaken for empty tool-result delivery.
- **Fix: session preservation across `/compact` and tree nav (issue #25)** — the main Claude Code session is no longer clobbered by shorter synthetic contexts (compact summaries) or stale post-rewrite history.
- **Add: plan-aware 1M context (issue #24)** — new `provider.plan` (default `"pro"`) and `provider.longContextExtraUsage` config. See README for which models get 1M on which plan.
- **Add: reasoning token tracking** — Claude Code `reasoning_tokens`/`thinking_tokens` are preserved on pi usage objects and in debug logs.
- **Bump: pi 0.80 APIs** — compat catalog import, `CONFIG_DIR_NAME`, compaction metadata. Claude Agent SDK 0.2.x, TypeBox 1.3, tsx 4.22.

## 0.5.0 — 2026-06-05

- **Add: claude-opus-4-8 model** — migrated pi imports/dev peers from deprecated `@mariozechner/*` packages to `@earendil-works/*` 0.78.x so the official pi-ai registry supplies Opus 4.8. The `opus` shortcut now resolves to 4.8; 4.7/4.6 remain available for explicit pinning.
- **Docs: Agent SDK quota warning** — note Anthropic's announced June 15, 2026 Agent SDK billing/quota change.
- **Tests: isolate AskClaude config** — AskClaude integration tests now use project-local test config so they are unaffected by a user's global `askClaude.enabled` setting.
- **Tests: harden shell integration tests** — use explicit alternate provider/model settings and pre-increment counters under `set -e`.

## 0.4.0 — 2026-05-04

- **Fix: Opus 4.7 + xhigh sent wrong effort to SDK** — pi-ai 0.72 ships per-model `thinkingLevelMap` overrides (e.g. `claude-opus-4-7` declares `xhigh→xhigh`, not `xhigh→max`), but our hardcoded `REASONING_TO_EFFORT` table ignored them. Effort lookup now consults `model.thinkingLevelMap` first, falls back to the table for older pi-ai or unmapped levels. Forwarded `thinkingLevelMap` through `buildModels` projection.
- **Fix: zero out model cost in `buildModels`** — per-token pricing in the footer was wrong because models inherited pi-ai's non-zero cost fields, which pi then multiplied by the huge token counts from the SDK. Now explicitly zeroed so pi's footer shows no cost.
- **Use `tools: []` instead of `disallowedTools` blocklist** — switch from blocking specific tools to explicitly passing an empty tools list, preventing any new default tools from silently leaking into bridge sessions.
- **Disable CC-side autocompact (`DISABLE_AUTO_COMPACT=1`)** — pi already owns context management and propagates its own `/compact` to CC. Letting CC autocompact too double-flushed the prompt cache and raced pi's threshold; manual `/compact` in CC is unaffected.
- **Fix: pi `/compact` no longer triggers CC autocompact-thrashing (issue #8)** — pi's compaction shrinks its messages array, but `syncSharedSession`'s REUSE check (`slice(cursor)`) silently returned `[]`, so the bridge kept `--resume`ing the pre-compact CC session JSONL. Over long sessions CC's own autocompact then refilled within 3 turns and tripped its anti-thrashing guard. Now subscribes to pi's `session_compact` event and forces the next sync down the REBUILD path so CC sees the post-compact history. Also subscribes to `session_tree` (branch nav has the same shape).
- **Refactor: split `needsRebuild` into `needsRebuild` + `forceRotate`** — only the abort case needs UUID rotation (to dodge late writes from the dying CC subprocess). Compact/tree now rebuild in place, preserving the sessionId and not leaking orphan JSONL files into `~/.claude/projects/`.
- **Block user-installed MCP servers from leaking into bridge sessions** — pass `--strict-mcp-config` unconditionally and set `ENABLE_CLAUDEAI_MCP_SERVERS=0` in the spawned CC env, suppressing both filesystem (`~/.claude.json`, `.mcp.json`) and claude.ai cloud MCP servers. Override with `provider.strictMcpConfig: false`.
- **Consolidate config** — SDK plumbing (`appendSystemPrompt`, `settingSources`, `strictMcpConfig`) moved from `~/.pi/agent/settings.json` (`claudeAgentSdkProvider` block) to a `provider` block in `~/.pi/agent/claude-bridge.json`. Old location no longer read. Drop deprecated, unsafe `maxHistoryMessages`.
- **Bump deps** — `@anthropic-ai/claude-agent-sdk` → ^0.2.126; migrate to TypeBox 1.x (new import paths per pi-mono 0.69); pi devDeps → ^0.72.1. Extract `registerTool` schemas to const with explicit `<typeof params>` generic to avoid TS2589 deep-instantiation under TypeBox 1.x.
- **Internal: move sources into `src/`** — `index.ts` and the extracted modules now live under `src/`; screenshots under `assets/`. `pi.extensions` and published `files` updated accordingly.

## 0.3.1 — 2026-04-18

- **Fix: empty thinking blocks on Opus 4.7** — Opus 4.7 silently changed default `thinking.display` from `"summarized"` to `"omitted"`, so streams emitted `thinking_start` + `signature_delta` with zero `thinking_delta` events, leaving `ThinkingBlock.thinking == ""`. Now pass `--thinking-display=summarized` via `extraArgs` whenever `effort` is set (both provider and AskClaude paths). Bump `@anthropic-ai/claude-agent-sdk` to ^0.2.111 (required for Opus 4.7 + `--thinking-display` CLI flag). See [anthropics/claude-agent-sdk-python#830](https://github.com/anthropics/claude-agent-sdk-python/pull/830).
- **Fix: `cachePct` debug metric misleading** — denominator was `input + cacheRead`, so once a conversation warmed up (tiny `input`, huge `cacheRead`) every turn rounded to 100% — even turns that rebuilt the cache from scratch. Now `cacheRead / (input + cacheRead + cacheWrite)`, so cache-rebuild turns show a low percentage.
- **Internal: extract pure modules from `index.ts`** — split `models`, `skills`, `session-verify`, `extract-tool-results`, and `query-state` into their own TS files with real unit tests (no more `.js`+`.d.ts` mirror drift). Add `typecheck` script, `typescript` + `tsx` devDeps; test scripts run via `--import tsx`.

## 0.3.0 — 2026-04-17

- **Add: claude-opus-4-7 model** — Added `claude-opus-4-7` as a selectable model. The `opus` shortcut now resolves to 4.7 by default; 4.6 remains available for explicit pinning. Bumped `@mariozechner/pi-ai` to ^0.67.6 to include official model definitions (removed fallback).
- **Refactor: QueryContext class replaces module-level state** — 12 mutable `let` variables + manual `SavedQueryState` push/pop replaced with a `QueryContext` class and context stack. Adding new per-query state is now 1 property instead of 6 edit sites. Fixes `deferredUserMessages` not being isolated across reentrant queries (subagent could consume parent's deferred steers). MCP handlers now close over captured context, abort handler captures context at the correct point after push.
- **Fix: MODELS baseUrl leak** — the MODELS array exported to pi's provider registration now projects only the fields pi needs (id/name/reasoning/input/cost/contextWindow/maxTokens), stripping pi-ai's `baseUrl`/`api`/`provider`/`headers` so they can't shadow the values `registerProvider` supplies.
- **Internal: `repairToolPairing` moved to cc-session-io 0.3.0**; convert logic extracted to `convert.js` with `convert.d.ts` types; various dead-code / type-safety cleanup.

## 0.2.0 — 2026-04-15

- **Fix: stale cursor after tool-using first turn (issue #4)** — after the first turn used tools, the session cursor pointed at the wrong message, causing Claude to re-process stale context. Now correctly advances past all tool_result blocks.
- **Fix: session resume on symlinked paths / CLAUDE_CONFIG_DIR** — cc-session-io now resolves symlinks (realpathSync + NFC) and honors `CLAUDE_CONFIG_DIR`, matching how Claude Code resolves session paths. Fixes "No conversation found" on macOS symlinked dirs. Bump cc-session-io → 0.2.0.
- **Verify-after-write for session files** — warns with diagnostic context if the written session file doesn't round-trip correctly, instead of letting Claude silently resume a corrupt session.
- **Session rebuild preserves sessionId** — provider switches no longer churn UUIDs.
- **CC CLI debug capture** — `CLAUDE_BRIDGE_DEBUG=1` now also writes Claude Code's own debug stream to `~/.pi/agent/cc-cli-logs/`, one file per query.
- **Fix: debug() logged Error objects as `{}`** — now formats with message and stack.
- **Repair orphan tool_use/tool_result pairs before import** — prevents potential API 400s when history starts mid-turn after a provider switch.

## 0.1.6 — 2026-04-10

- **Fix: steer messages during tool execution now reach Claude** — when a user sends a steer while a tool is executing, pi injects it into context alongside the tool result. The bridge previously only processed tool results in this path, silently dropping the steer. Now detected and replayed as a continuation query after the current query completes.
- **Fix: "No conversation found with session ID" in dirs with dots/underscores/spaces** — bump `cc-session-io` to 0.1.2; `projectPathToHash` now matches the CLI's sanitization (`/[^a-zA-Z0-9]/g` → `-`) instead of only replacing slashes
- **Fix: steer/followUp during tool execution no longer hangs** — `extractAllToolResults` now walks past injected user messages instead of stopping at them
- **ID-based tool result matching** — tool results are matched to MCP handlers by `toolCallId` instead of FIFO position; eliminates silent wrong-result delivery if order diverges
- Add integration tests for tool execution scenarios (normal, followUp, steer, parallel+steer, abort) with auto-restart on failure
- Add `defaultIsolated` config option for AskClaude
- Remove skill path aliasing (`.pi/` → `.claude/` round-trip); pass through real paths instead
- Rewrite skills block to reference MCP-bridged read tool (`mcp__custom-tools__read`)
- **Fix: AskClaude action summary showed raw SDK tool names** — normalize `mcp__custom-tools__*` and SDK names at creation; hide redundant `BashOutput` and recursive `AskClaude`; collapse only consecutive same-tool calls
