# Automatic review protection verification

**English** | [한국어](auto-review-protection.ko.md)

Verification checks **policy decisions, actual Pi tool results, and file and network effects** together. An allowed control case must succeed before a blocked result is meaningful. Exceptions or error messages alone do not establish successful protection.

The current source is an approval assistance extension. It does not enforce OS isolation, configure a network proxy, or recursively inspect directories. Approved tools use Pi's original executor. The earlier sandbox verification records below do not establish guarantees for the current execution structure.

## Current approval and execution checks

| Target | Result checked |
| --- | --- |
| `/approve` | Original Codex descriptions, English UI, narrow-terminal wrapping, actual file effects of the selected approval method, and persistence |
| `/approve-model` | Current `/scoped-models` scope; exclusion of unavailable and duplicate models; rejection of scope changes during selection; actual Pi reviewer selection without changing the main model |
| Settings changes | Concurrent selection merging, preservation on save failure, and blocking late approvals from previous reviews |
| Pi execution | Original SDK execution with cwd, environment, output, timeout, and cancellation signal preserved |
| Startup | Execution without an exhaustive scan even when unrelated directories cannot be traversed |
| Protection and denial | Direct protected paths and deny rules rejected before review; failures, cancellation, and timeouts never lead to execution |
| Network review before execution | curl requests with omitted schemes, configuration files, or both allowed URLs and configuration files pass through automatic or user review. Only the allowed control reaches the owned HTTP server |
| PowerShell | Replays the Codex `powershell_lowering.json` corpus and checks that scripts Codex leaves unparsed, and comment forms Codex lowers, are matched only as the whole outer invocation (`[<powershell executable>, "-Command", script]`). Also checks path, network, and rule classification of cmdlets and aliases, read-only cache reuse, opt-in activation, and controller execution |
| Windows paths | Platform-injected unit tests of MSYS/Cygwin/WSL operand mapping, Windows path aliases, case- and normalization-insensitive protection, `/tmp` roots, and executable names. Windows-only tests cover real `canonicalPath()` and Git Bash decisions |
| TypeScript rules | Replay 280 actual results captured from the pinned Codex helper; preserve rule outputs and rejected inputs, cancellation, budgets, and strict request validation |
| Distribution package | Startup through the actual Pi loader; synchronous and worker-based rule evaluation from the archive; absence of Rust artifacts, `.node` files, sandbox output, and bundled dependencies |

Checks that replay the reviewer and UI use actual Pi and file results, but do not establish the judgment accuracy of a live model. The OS does not restrict indirect file access inside approved shells, hard links, or network changes during execution. Caller environment values are preserved for execution; authentication variables are excluded only from review evidence.

In the previous repository, `verify:guard` saved the current operating system's results, source hash, and audit records. Other operating systems and live models require separate results. Unexecuted scopes are not marked as passed.

Approval descriptions follow the [official approval picker](https://learn.chatgpt.com/docs/security-administration). Reviewer separation, denial feedback, stopping after three consecutive denials or ten in the latest fifty reviews, and cancellation are compared with the [official Auto-review documentation](https://learn.chatgpt.com/docs/sandboxing/auto-review). The current implementation does not enforce OS boundaries; this does not guarantee security equivalent to Codex's sandbox.

The reference corpus is [`tests/fixtures/execpolicy-reference.json`](../../tests/fixtures/execpolicy-reference.json). It records the original executable's revision and SHA-256 hash and contains 201 accepted and 79 rejected cases, including Unicode whitespace, invalid Unicode escapes, and numeric conversion boundaries. The TypeScript implementation is checked through its public asynchronous API; the original binary is no longer required by tests or builds. POSIX-specific path cases are excluded from Windows replay, where the existing platform-specific path tests still run. This is a recorded compatibility corpus, not proof of equivalence for every possible Starlark program.

## Running verification

Run from the [pi-packages](https://github.com/buYoung/pi-packages) repository root. These commands use no actual credentials.

```sh
pnpm install
pnpm --filter "@buyong/pi-codex-auto-review..." build
pnpm --filter @buyong/pi-codex-auto-review test:unit
```

`test:unit` runs the unit, integration, conformance, execution, and end-to-end suites on the current operating system. A local pass does not replace other platform, image, or live model results. The repository workflow runs these checks on Ubuntu, macOS, and Windows (with Git Bash) when this package is selected, and on macOS and Windows only when just the Codex bundle is selected; Windows checkouts keep LF line endings.

The Docker (`verify:docker`), platform (`verify:platform`, `verify:windows`), and evidence (`verify:guard`) commands behind the historical records below remain in the previous [pi-codex-auto-review](https://github.com/buYoung/pi-codex-auto-review) repository and are not part of this repository.

## Historical OS isolation verification (v0.1.2 and earlier)

The following records concern `v0.1.2` and earlier source versions that included a sandbox. GLM5.3 verification distinguished four SDK cases and one CLI case. Earlier platform verification is preserved in the [platform qualification verification record](https://github.com/buYoung/pi-packages/blob/main/docs/verification/auto-review/17-platform-qualification.json), and the earlier 112 checks in the [protection matrix verification record](https://github.com/buYoung/pi-packages/blob/main/docs/verification/auto-review/10-protection-matrix.json). Check current execution results against the latest run records with a matching source hash.

Before the improvements, at `85008b0`, the same source passed 142 checks each on macOS, actual Linux x64, native Docker, and emulated Docker. Four GLM5.3 cases and separate Windows rule and pre-execution denial checks also passed. The record confirmed that 217 audit entries and seven live model logs and reports did not expose keys. A later comprehensive review found defects not covered by those checks. These historical results do not replace the regression cases below or passing results for the current source.

The changes from that comprehensive improvement, final execution evidence, and remaining platform conditions are documented in the [Pi runtime alignment verification record](https://github.com/buYoung/pi-packages/blob/main/docs/verification/auto-review/25-pi-runtime-alignment.md).

### Protected and allowed cases in the earlier structure

| Boundary | Allowed control | Blocked or reviewed target | Final observation |
| --- | --- | --- | --- |
| Six file tools | Workspace `read`, `grep`, `find`, `ls`, `write`, and `edit` | Same tool calls on absolutely protected paths | Tool error, zero reviewer calls, protected files unchanged, no content exposure |
| Default read and temporary paths | Ordinary external file reads and default temporary-path writes | Same write after excluding the temporary writable root | Reads still work; writes are reviewed and denied |
| Read-only profile | Explicitly approved write to an existing file | Unapproved sibling workspace or temporary files, and the next call | Only the approved file changes |
| Path changes during review | Initially reviewed symbolic-link target | Link replaced with a sibling or protected path during review | Stale approval rejected; all three targets unchanged |
| Risk and authorization | Synthetic high-risk case with sufficient authorization | Explicit low-risk policy denial, insufficient authorization, or critical risk | Tool results delivered to the main model agree with actual writes |
| Technical review errors | Correctly structured approval response | Provider error, invalid JSON, injected additional permission fields, or timeout | Failure distinct from policy denial; files unchanged |
| Approval path settings | Ordinary workspace writes and shell output | Disabled sandbox or command-rule approval categories | Rejected without calling the reviewer |
| Command rules | Normal command matching no rule | Deny rule matching alongside an allow rule, or nested shell | Direct and nested execution rejected; no target file created |
| Review cancellation | Review begins through actual Pi direct tools or `codemode` | Late approval after cancellation during review | Cancellation signal propagated; no write executed |
| Seven file mutations | Workspace append, resize, delete, move, copy, mode change, and hard-link creation | Same operations outside scope | Contents, existence, mode, and original file checked separately |
| Network destinations | Subdomain of an allowed wildcard | Root domain, similar suffix, or explicitly denied domain | Actual receive counts on an owned server |
| HTTP redirects | Initial request to an allowed host | Redirect to a denied host | Only initial request arrives; denied target is not reached |
| Environment variables | Explicit ordinary values passed to a child interpreter | Synthetic secrets in authentication, loader, or user proxy variables | Secrets absent from child environment; ordinary values preserved |
| Docker process cleanup | `--init` reaps exited orphan processes | Container whose PID 1 cannot reap orphans | `/proc/<pid>` disappears within the limit; failure blocks entry into verification |
| Preexisting hard links | Same inode with all names inside the allowed scope | Protected-file alias, out-of-scope write alias, or sibling alias of a narrowly approved file | Blocked before execution; external content unchanged. Directory approval covering every alias is allowed |
| Untraversable directories | Normal file write beside an inaccessible subtree | Subtree permission change or read; unverified tree accessible with a known name | OS boundary also blocks inaccessible tree; startup rejected for incompletely verified searchable scope |
| HTTPS CONNECT | Owned-server request with a verified synthetic certificate | Disallowed destination or untrusted certificate | Actual HTTPS response and server receive count; authentication failure produces no HTTP effect |
| SOCKS5 and UDP | Allowed SOCKS5 TCP and a host UDP control request | Explicitly denied SOCKS5 destination or direct sandbox UDP | Only allowed TCP arrives; no additional direct UDP receipt |
| IPv6 | Proxy approval of equivalent IPv6 notation; exact destination approval during execution | Explicit IPv6 denial or direct IPv6 communication | Address and port reach review; only allowed requests reach the server |
| Original `.rules` | Starlark functions, string interpolation, alternative arguments, executable paths, and network rules | Incorrect examples, path violations, invalid rules, or cancellation | Pinned Codex engine results reach actual policy and native settings |
| Automatic context | Instructions from a trusted root to cwd; global instructions and file precedence | Untrusted project, protected-path alias, or byte-limit overflow | Source and content reach Pi and reviewer; updated after refresh |
| Final MCP execution | Ordinary read-only or configured allowed call; exact reviewed and approved call | Strict request skipping review using annotations or past approval; denial, registration change, or review cancellation | Actual Pi client and stdio server calls agree with file effects |
| Project MCP startup | Saved trust or explicit trust selection | Project with no decision, or explicit distrust | Trust decision limits server startup effects before tool invocation |
| MCP name collision | Explicit user approval for `node_repl/js` | Missing approval UI or explicit denial | Actual stdio server file effects agree with approval dialog counts |
| Pi control files | MCP settings directly changed by the user on the host | Model changes to MCP settings, trusted extension entry points, or relative imports | Files unchanged; external effects blocked after reload. User changes apply at next startup |
| Review response types | String risk level and valid approval | Invalid risk or authorization level such as arrays or `null` | External file unchanged; technical failure reaches the next model request |
| Literal paths | `[route]` and `*` filenames inside the allowed workspace | Additional permission roots containing pattern characters and direct SDK profiles | Blocked before approval and execution; similarly named siblings unchanged |
| Direct command after denial stop | Newly requested direct user shell command | Follow-up execution by stopped model, caller cancellation, or stale session | No model write; direct command succeeds; original cancellation contract preserved |
| Audit records | Valid approval with a quoted review reason | Recording synthetic secrets | Valid JSON, masked values, and approved file changes |
| Normal Pi and CLI entry points | Official MCP through default package extension; explicit CLI provider and model selection | Duplicate MCP connection or fallback execution for a nonexistent model | Actual Pi and CLI effects agree with model and review calls |
| Pi resources | Global skills and trusted project skills, prompts, and themes | Untrusted project resources or automatic extension execution | Resources reach model context and expanded prompts; no untrusted code effects |
| MCP reconnection cleanup | Approved call after reconnecting from output mode to RPC | Leftover previous server processes | Both created PIDs absent after normal shutdown |

### Codex-based harness in the earlier structure

The baseline is public source `rust-v0.160.0`, commit `a956835d020762cb2b570053af06f643a11c0ecc`. The public harness's verification contracts were adapted to Pi's stream and tool paths. The earlier versions evaluated `.rules` with the actual Rust `codex-execpolicy` dependency; the current source uses the TypeScript port and reference corpus described above. Neither record means that the entire upstream Rust test suite was run.

| Codex baseline | Adapted verification |
| --- | --- |
| [`responses.rs::mount_sse_sequence`](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/tests/common/responses.rs#L1466) | Replays responses in a fixed sequence and fails on excess or missing main-model or reviewer calls. |
| [`exec_policy.rs::execpolicy_blocks_shell_invocation`](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/tests/suite/exec_policy.rs#L517) | Checks that policy denials reach the next main-model request as tool results. |
| [`request_permissions.rs`](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/tests/suite/request_permissions.rs#L834) | Checks that additional read-only permissions do not expand to unapproved workspace or temporary writes. |
| [`guardian_review_cancellation.rs`](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/tests/suite/guardian_review_cancellation.rs#L39) | Checks that late approval cannot execute after cancelling review in direct tools or nested code execution. |
| [`execpolicy`](https://github.com/openai/codex/tree/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/execpolicy) | In the earlier Rust-backed versions, connected the original Starlark engine, example validation, executable paths, and network rule conversion. |
| [`agents_md.rs`](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/src/agents_md.rs) | Checks project root, instruction precedence, byte limits, and trust state. |
| [`mcp_tool_call.rs`](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/src/mcp_tool_call.rs), [`session/mcp.rs`](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/src/session/mcp.rs) | Checks annotation precedence, strict automatic review, and binding to the call source. |

The current replay harness is in [`tests/harness/scenarios.mjs`](../../tests/harness/scenarios.mjs), and scenarios are in [`tests/conformance/protection.test.mjs`](../../tests/conformance/protection.test.mjs). Earlier OS isolation checks are preserved in the [`v0.1.2` tests](https://github.com/buYoung/pi-codex-auto-review/blob/v0.1.2/test/native/sandbox.test.mjs). The harness itself checks missing and excess calls and requests already cancelled.

Extension verification reproduced 131 zombie processes accumulating under Docker PID 1 and `grep` failing to create threads. Harness `--init` and a preliminary orphan-reaping check addressed this while retaining the 256-PID limit and internal file, network, and seccomp restrictions.

Follow-up checks reproduced preexisting hard links bypassing protected-file reads and external-file writes on macOS. Comparing link counts with names in the allowed scope before execution addressed this. Pi's default trust value also allowed a new project's MCP server to start before approval tool calls; startup was restricted to saved trust or explicit selection. Reproduction and fix evidence is in the [hard-link verification record](https://github.com/buYoung/pi-packages/blob/main/docs/verification/auto-review/15-hard-links.json) and [platform follow-up verification record](https://github.com/buYoung/pi-packages/blob/main/docs/verification/auto-review/18-platform-followups.json).

In actual Ubuntu Docker, external AppArmor policy blocked internal `bwrap` mounts. The harness checks AppArmor availability and sets `apparmor=unconfined` only for owned verification containers. Requested values and actual profiles are recorded in run reports, while internal sandbox file, network, and seccomp checks still run. This is a verification environment setting using [Docker's per-container profile selection](https://docs.docker.com/engine/security/apparmor/). Before-and-after runs are preserved in the [AppArmor verification record](https://github.com/buYoung/pi-packages/blob/main/docs/verification/auto-review/20-docker-apparmor.json).

Additional verification running x64 programs on an ARM64 kernel found that one normal shell-output case out of 142 exceeded a three-second limit. The caller-specified timeout for that functional check was adjusted to fifteen seconds. A separate lifecycle check continues to verify an actual two-second timeout, a 3.5-second return limit, and blocking delayed file changes. Executor timeout handling was unchanged. The initial failure and focused results are in the [emulated shell timing verification record](https://github.com/buYoung/pi-packages/blob/main/docs/verification/auto-review/22-emulated-shell-timing.json).

The first final macOS aggregation exceeded the package check's twenty-second observation window. A diagnostic copy with a longer window completed normally in 12.6 seconds. Reaggregation retaining the original check and twenty-second limit also passed. The specific cause of the initial delay was not determined. The [package timing verification record](https://github.com/buYoung/pi-packages/blob/main/docs/verification/auto-review/24-macos-package-timing.json) preserves both the initial failure and subsequent success.

Normal MCP approval and strict review are distinct. Codex's normal path follows annotations and approval modes even with an automatic reviewer; strict review does not allow those skip conditions. Corrected behavior and regression checks are recorded in the [MCP routing verification record](https://github.com/buYoung/pi-packages/blob/main/docs/verification/auto-review/19-mcp-routing.json).

Current E2E checks are in [`tests/e2e/guard.test.mjs`](../../tests/e2e/guard.test.mjs). Before fixes, actual Pi and OS paths reproduced array risk levels changing external files, `[]` in restricted paths allowing sibling writes, and `node_repl/js` producing MCP effects without approval. Audit JSON failures and direct command failures after a denial stop were also reproduced this way. The default package check was expanded to run a public Pi session and actual MCP server, so its subprocess observation limit changed from twenty to sixty seconds. Actual executor cancellation and timeout checks remain separate.

The CLI observer instruments the actual `ModelRuntime` referenced by Pi 0.99.1's extension compatibility registry. Wrapping only that registry misses main-agent calls. A local HTTP provider control compares two main execution calls and one review call actually received with observation records. Passing requires the review output limit `777` and main execution limit of 4096 tokens to reach HTTP requests and the final file to change. This instrumentation is verification code for the pinned version; it does not replace product responses.

Each test process uses a `TMPDIR` directory created for that run and removes it on exit. This followed an observation that shared host temporary paths exceeded the 100,000-entry directory inspection limit. The executor's inspection limit and blocking policy for incomplete inspection remain intact. Separate controls check default temporary-root access and explicit exclusion.

In the first ARM64 Docker run, one normal `grep` control out of 154 failed. Further checks and actual mount observation showed that a nonexistent `.git` was bound to `/dev/null` and denied reads because of `nodev`. Passing a `.git/HEAD` child block as well made the runtime create an empty read-only directory. The original parent block remained. An initial change expanding read declarations was reverted after a separate control showed it was unnecessary. SDK callers' read-only path choices were preserved. Additional controls check normal searches, ordinary directory creation, and blocked Pi settings creation together. Allowed and absolutely blocked roots that overlap directly or through aliases are normalized to actual paths and rejected before execution.

Additional approval binding checks reproduced a denied file changing when two MCP requests overlapped with the same caller ID, and additional approvals were then bound to a unique ID generated for each MCP transmission. Auto Review no longer connects MCP servers or answers additional approval requests: it reviews MCP calls in Pi's `tool_call` hook, so that binding and its concurrent-call check were removed.

### Scope of the earlier OS isolation verification

- Scenarios replaying the main model and reviewer used actual Pi and an OS sandbox. They do not establish live GLM5.3 judgment accuracy. Four live SDK cases and one CLI case were executed and aggregated separately. Integrated passing results also required actual CLI review calls, file changes, and no credential recording.
- Default temporary-directory writes and ordinary external-file reads were allowed by the default profile. Operations were not assumed always blocked solely because they were outside the workspace.
- Shell execution is not transactional. If a first allowed write succeeds and a second write is denied, the first change remains. Tests explicitly checked these partial effects.
- Creating new files on Linux may require approval of the parent directory scope. Narrow approval of an existing file and creation of a new file are distinct scopes.
- Preexisting hard links and alternative names for narrowly approved files were checked. Concurrent changes to link structure by host programs outside isolation during execution were not covered. Inspection failures and limit overflows blocked execution.
- Linux x64 host execution and x64 execution on an ARM64 kernel were recorded separately. Final aggregation required actual Linux x64 host results from the same source.
- Windows verification separately checked the original rule engine, approval policy, and pre-execution rejection of unsupported native execution on the actual OS. It does not establish successful Windows native isolation.
- External MCP executors are trusted integration layers. Cancellation of requests already sent to external servers, and every provider's account identification or side effects, are not guaranteed. Auto Review does not answer elicitation requests from MCP servers. Computer Use classifications and approval exceptions absent from Pi were removed.
- Native permission roots containing pattern characters were blocked because the runtime cannot represent them literally. This is distinct from support for special-character filenames in ordinary workspaces. Trusted extension directories are protected as control code, but all dependencies that arbitrary trusted extensions execute or import elsewhere are not automatically analyzed.
- HTTPS CONNECT, SOCKS5 TCP, IPv6, and direct UDP blocking were checked. This does not claim support or verification of SOCKS5 UDP or every network protocol.
- Identical decisions to the proprietary Codex model are not guaranteed. Public policies and flows are distinct from observed results of the selected GLM5.3 model.
