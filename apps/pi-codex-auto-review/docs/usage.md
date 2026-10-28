# Automatic review usage

**English** | [한국어](usage.ko.md)

Use this guide to install `@buyong/pi-codex-auto-review`, choose an approval method, run with protected startup, and configure policies. It describes the current source; a published npm release may not include every source change yet. Other packages from the same repository are listed in the [pi-packages README](https://github.com/buYoung/pi-packages#choose-a-package).

## Installing from npm

You need Node.js 22.19 or later, Pi 1.0.0 or later, and access to a Pi model. The JavaScript rule engine requires no Rust compiler or platform-specific rule binary.

Do not enable this extension both individually and through `@buyong/pi-codex`. If the older unscoped `pi-codex-auto-review` is installed, first remove its source as shown by `pi list`, in the same global or `--local` scope.

```sh
pi install npm:@buyong/pi-codex-auto-review
pi list
pi
```

`pi list` shows `npm:@buyong/pi-codex-auto-review` and its installed path under `User packages:`. In Pi, configure model access with `/login` if needed, run `/approve`, and choose an approval method. A request to read and summarize a project file runs without review, because ordinary in-scope reads are allowed. To see a review, ask Pi to use bash to run exactly `node --version`, as in the [quick start](../README.md#quick-start): under the default policy that command requires review with your selected method, and a successful run reports the installed Node.js version.

- Add `--local` to install in the current project's `.pi/settings.json`. Pi loads project packages only after the project trust decision.
- Append `@<version>` to pin an npm release. An unversioned source installs the latest published release.
- Pi supplies the host SDK to managed extensions. Do not add a second SDK copy or symbolic link to the managed package.
- Remove an installation with `pi remove <source>`, using the source shown by `pi list`. Use `--local` when removing a project-scoped entry.

Normal extension registration connects the guarded local tools. Auto Review does not connect MCP servers: Pi's built-in MCP support, or an extension that replaces it such as pi-mcp-adapter, connects them, and Auto Review reviews their tool calls (see [MCP approvals](#mcp-approvals)). **Registration is not a protected-startup guarantee:** Pi 1.3.0 exits with code 1 for extension loading errors on a fresh CLI startup, but reload and SDK loading have separate error handling. Auto Review defers policy, rule, and SQLite initialization to session start or first use; failures block protected operations until reload or restart. Use the [guarded CLI or SDK](#run-with-protected-startup) for an explicit readiness check before execution, including after reload.

## Choose an approval method and review model

Run `/approve` in a TUI session, or in RPC with a client that answers Pi UI requests:

| Choice | What changes |
| --- | --- |
| **Approve for me** | Uses automatic model review for calls requiring approval; the default |
| **Ask for approval** | Uses user review for those calls; ordinary policy-allowed calls still run directly |
| **Full Access** | After confirmation, skips approval and all path, command, and network restrictions |
| **Auto Review Off** | Turns the whole extension off and uses Pi's original tools; persists across sessions |
| **Review cache expiry** | Selects a read-only automatic-approval lifetime from 1–12 hours; defaults to 3 hours |

The first two choices persist. **Full Access is never saved** and lasts until Pi exits or you choose another approval mode. It also bypasses otherwise absolute path and command denials. Cancelling the confirmation returns to the picker without enabling it. Policy enforcement, approval reuse, and MCP review described below assume the extension is on and Full Access is off.

On Windows, the built-in `powershell` tool is guarded like `bash`. The extension registers a guarded `powershell` tool without activating it; enable it as in Pi through `defaultTools` (for example `"+powershell"`) or `--tools`. Guarded startup honors the same `defaultTools` selection. PowerShell commands are analyzed with their own grammar, never with bash rules; see [Windows and PowerShell](#windows-and-powershell). While off, Pi's original PowerShell tool runs.

### Turn the whole extension off or back on

Run these commands in TUI or RPC with a connected UI:

| Command | Result |
| --- | --- |
| `/approve off` | Disables automatic review, approval prompts, and protected-path, command, and network policy checks |
| `/approve on` | Restores the previous approval mode, review model, and policy settings; clears session Full Access |
| `/approve status` | Shows whether the extension is on or off and the active approval mode |

You can also select **Auto Review Off** in `/approve`. While off, local tools, direct shell calls, and MCP tools use Pi's original execution paths, without the extension's fallback shell timeout. Pi's project trust decisions and external servers' own authentication and permissions still apply.

Whether the extension is on or off, ordinary and guarded installations both use Pi's effective `shellPath`, `shellCommandPrefix`, and `images.autoResize` settings after session binding; explicit SDK `bashOptions`/`readOptions` override them. An unset shell path stays unset for Pi's platform-specific discovery, including Git Bash on Windows.

On/off changes save as `isEnabled` and apply to the current session and future runs. Approval mode and review model settings are retained. Choosing **Approve for me**, **Ask for approval**, or confirmed **Full Access** in `/approve` turns the extension back on. Changing only the cache or review model leaves it off.

### Configure the review cache and model

Set the cache lifetime through **Review cache expiry** in `/approve`, or through `/approve cache`. The selection persists; cancelling preserves the current value.

Run `/approve-model` to search available models in Pi's current `/scoped-models` scope, plus Codex's approval review model `codex-auto-review`. Selecting a reviewer does not change the main conversation model. **Use current Pi model** sets `reviewModel: null`.

- If `/scoped-models` has no scope set, the picker shows all available models.
- If a scope is set but none of its models is available, the picker shows no models; it does not fall back to the full list.
- `codex-auto-review` appears as **Codex Auto Review (openai free)** and **Codex Auto Review (openai-codex)** for the `openai` and `openai-codex` providers respectively, when that provider has credentials and lists `gpt-5.6-luna`. It reuses that provider's `gpt-5.6-luna` endpoint and limits. Pi's `/model` does not list `codex-auto-review`, so `/approve-model` shows it regardless of the model scope.
- A model removed from the scope while the picker is open is not saved.
- Esc preserves the existing settings. Fixed UI text is in English.

Selections save to `<agentDir>/guard/settings.json`, or to an explicit `settingsPath`. Menu changes apply after saving and invalidate pending reviews and exact-action grants from the previous policy. Saving writes only the changed option over the file's current contents, so options saved meanwhile by another Pi session are kept. For manual policy-file edits, reload the extension with `/reload` or restart the guarded runtime.

## Run with protected startup

The guarded CLI and `createGuardedRuntime()` check extension and controller readiness. They reject Pi versions before **1.0.0** with `UNSUPPORTED_PI`, regardless of the broader manifest peer range. They also check readiness each time the session is bound to an interface again (every `session.bindExtensions()` call starts the session anew) and for direct user shell calls.

These entry points disable automatic extension discovery. Load any additional extension explicitly and treat its code as trusted. Other extension tools do not automatically gain an approval gate; local shell/file tools and MCP tools retain theirs. These entry points load Pi's MCP extension themselves (see [MCP approvals](#mcp-approvals)).

Project instructions, settings, and MCP servers follow Pi's saved trust decision and global `defaultProjectTrust`. Without saved or explicit trust, project resources do not start. `--trust-project` or SDK `isProjectTrusted: true` trusts the initial project for this run; later directory changes use each directory's own trust record.

### CLI

Run the guarded CLI from a source checkout or from an npm installation:

- **Source checkout:** after [building from source](#building-from-source), run `node apps/pi-codex-auto-review/dist/cli.js` from the repository root, as in the examples below.
- **npm installation:** in a directory where you installed the packages listed under [SDK](#sdk), run `npx pi-codex-auto-review` with the same options. A Pi-managed package installation (`pi install`) does not guarantee that this executable is on your shell's `PATH`.

Replace `/absolute/path/to/project` with your project directory:

```sh
node apps/pi-codex-auto-review/dist/cli.js --cwd /absolute/path/to/project
```

For a one-shot response instead of the terminal UI:

```sh
node apps/pi-codex-auto-review/dist/cli.js --mode print "Read the README and summarize how to run this project. Do not change files."
```

The CLI uses your configured Pi model and credentials. `print` returns text; `json` returns JSONL events; `rpc` runs the Pi RPC interface. Automatic review works without a UI, but a call that needs user approval is not executed when no approval UI is available.

| Option | Behavior |
| --- | --- |
| `--mode tui\|print\|json\|rpc` | Selects the interface; defaults to `tui` |
| `-p` | Shorthand for `--mode print` |
| `--cwd path` | Initial project directory; defaults to the invocation directory |
| `--agent-dir path` | Pi resource directory; defaults to `PI_CODING_AGENT_DIR`, then `~/.pi/agent` |
| `--policy file` | Policy JSON file; must exist and validate. Relative paths resolve from the invocation directory. |
| `--trust-project` | Trusts the initial project for this run |
| `--extension path`, `-e path` | Repeatable trusted extension paths, resolved from the invocation directory. The containing code directory is protected from model writes. |
| `--provider provider --model model` | Selects an exact registered provider/model pair. Specify both; an unavailable model blocks startup. |
| `--` | Ends option parsing so the prompt can start with `-` |

This wrapper accepts only its own options, not every option of the standard `pi` CLI.

For an external provider, explicitly load its registration extension. This package's development dependencies include `pi-ollama-cloud` 0.12.2, which still loads from a root `index.ts`. With `OLLAMA_API_KEY` already exported in the invoking shell:

```sh
node apps/pi-codex-auto-review/dist/cli.js \
  --extension apps/pi-codex-auto-review/node_modules/pi-ollama-cloud/index.ts \
  --provider ollama-cloud --model glm-5.3 \
  --mode print "Read the README and summarize this project. Do not change files."
```

Use a model available to your account. This makes real provider calls and may consume usage. Do not pass credentials in command arguments.

### SDK

For an application outside this checkout, install the extension and matching Pi host packages in that application's directory:

```sh
npm install @buyong/pi-codex-auto-review \
  @earendil-works/pi-coding-agent \
  @earendil-works/pi-ai \
  @earendil-works/pi-tui
```

Use the public `startup` export in an ESM application. The example selects your existing Pi resources and credentials, prints the final response, and disposes the runtime:

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createGuardedRuntime } from '@buyong/pi-codex-auto-review/startup';

const runtime = await createGuardedRuntime({
  cwd: process.cwd(),
  agentDir: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'),
});
try {
  await runtime.session.prompt('Read the README and summarize this project. Do not change files.');
  console.log(runtime.session.getLastAssistantText());
} finally {
  await runtime.dispose();
}
```

| Option | Behavior |
| --- | --- |
| `cwd`, `agentDir` | Required initial project and Pi resource directories |
| `settings` | Default policy values; values in the stored settings file override them |
| `settingsPath` | Explicit policy file. Unlike the default path, a missing file blocks startup. |
| `isProjectTrusted` | Optional trust choice for the initial project |
| `model` or `modelSelection` | A model object or `{ provider, id }`; cannot be used together |
| `trustedExtensionPaths` | Extension entry paths, resolved from the initial `cwd`. Protects the containing directories, including sibling imports. |
| `profile` | Custom permission profile, including `readOnlyPaths`. Required guard control/rule-file and extension-code protection applies while the extension is on and Full Access is off. |
| `mcp` | Options for Pi's MCP extension; `false` loads no MCP extension and leaves MCP calls unreviewed |
| `mcpToolPolicies` | `approvalMode` overrides keyed by `server/tool` |
| `modelRuntime`, `settingsManager`, `sessionManager` | Optional Pi services and session storage supplied by the embedding application |
| `trustedExtensions`, `externalExtensions` | Explicit inline integrations; the caller owns trust in their code |

The SDK starts without an approval UI. Automatic reviews can still approve calls. User-review requests are declined unless your application binds a Pi UI context to the session (`runtime.session.bindExtensions({ uiContext })`). If you supply a `settingsManager` and also set `isProjectTrusted`, the two must agree; otherwise startup fails with `CONFLICTING_PROJECT_TRUST`.

## Policy file

Normal Pi installations read `<agentDir>/guard/settings.json`. The CLI's `--policy` and SDK's `settingsPath` select another file. Create an explicit file before startup. Missing keys use defaults; unknown keys and invalid values reject the file. SDK `settings` supplies defaults only: a stored file takes precedence, without deep-merging nested objects. After editing a policy file by hand, run `/reload` or restart the guarded runtime.

This example keeps default approval behavior and adds two command rules:

```json
{
  "mode": "workspace-write",
  "approvalPolicy": "on-request",
  "approvalsReviewer": "auto_review",
  "reviewModel": null,
  "commandRules": [
    {"prefix": ["git", "status"], "decision": "allow"},
    {"prefix": ["git", "push"], "decision": "deny"}
  ]
}
```

### Approval and scope settings

All scope and denial rules below assume **the extension is on and Full Access is off**.

| Field | Default | Behavior |
| --- | --- | --- |
| `isEnabled` | `true` | `false` disables all extension review, approval, and policy checks. `/approve on` and `off` apply immediately; manual file edits require a reload or restart. |
| `mode` | `"workspace-write"` | `"workspace-write"` or `"read-only"`. With `"workspace-write"`, ordinary workspace/temporary writes are allowed. `"read-only"` does not block writes: every write goes through review, and an approved write still runs. |
| `approvalPolicy` | `"on-request"` | `"on-request"`, `"never"`, or a category object (below). `"on-request"` allows review when needed. `"never"` blocks calls that need approval, but does not block policy-allowed calls. Category settings are described below. |
| `approvalsReviewer` | `"auto_review"` | `"auto_review"` or `"user"`; `"user"` requests user review |
| `reviewModel` | `null` | Current model, or a registered `{ "provider": "...", "id": "..." }` pair |
| `commandRules` | `[]` | Literal argument-prefix rules with `allow`, `ask`, or `deny` decisions |
| `ruleFiles` | `[]` | Rule-file paths, resolved from the working directory |
| `allowedDomains` | `[]` | Host patterns for interpreted network commands. `*.example.com` matches subdomains, not `example.com`. No OS network restriction is created. |
| `writableRoots` | `[]` | Additional ordinary writable roots, resolved from the working directory |
| `excludeSlashTmp` | `false` | Removes `/tmp` from the default writable roots. Windows has no `/tmp` root, so it has no effect there. |
| `excludeTmpdir` | `false` | Removes `os.tmpdir()` from the default writable roots; both exclusions may be needed when paths overlap |
| `trustedTools` | `[]` | Compatibility field; other extension tools no longer need to be listed |

`approvalPolicy` can instead enable individual categories:

```json
{
  "approvalPolicy": {
    "sandbox": true,
    "rules": false,
    "mcp_elicitations": true
  }
}
```

`sandbox` is the compatibility name for general approval requests, **not OS isolation**. `rules` controls rule-requested approval and `mcp_elicitations` controls MCP approval requests. `sandbox` and `rules` are required in this object; omitted `mcp_elicitations` is disabled. A disabled category blocks the request without model or user review.

### Review limits and project instructions

| Field | Default | Behavior |
| --- | --- | --- |
| `reviewTimeoutMs` | `20000` | Automatic-review deadline in milliseconds |
| `approvalTimeoutMs` | `60000` | Approval-dialog deadline in milliseconds |
| `executionTimeoutSeconds` | `120` | Guarded shell fallback timeout in seconds; caller-supplied timeouts take precedence |
| `reviewPolicy` | `null` | Optional replacement for the reviewer's organization policy section. Risk, source-trust, and outcome criteria remain. |
| `reviewMaxRounds` | `4` | Reviewer model rounds, including investigation; integer from 1 to 16 |
| `reviewMaxOutputTokens` | `2048` | Reviewer output limit; integer from 1 to 16384 |
| `reviewContextChars` | `60000` | Review-context character budget; integer from 1 to 500000 |
| `reviewCacheTtlHours` | `3` | Read-only automatic-approval lifetime in hours; integer from 1 to 12, also configurable through `/approve` |
| `projectDocMaxBytes` | `32768` | Combined project-instruction byte budget; integer from 0 to 1000000 |
| `projectDocFallbackFilenames` | `[]` | Instruction filenames tried after `AGENTS.override.md` and `AGENTS.md` |
| `projectRootMarkers` | `null` | Uses `.git` as the root marker. A list replaces it; `[]` disables parent traversal. |
| `redaction` | `{"sensitiveFields":[],"rules":[],"exceptions":[],"piiEntities":[]}` | Additions to mandatory reviewer masking; see [reviewer redaction](#reviewer-redaction) |

The guard discovers global instructions in `agentDir` and trusted project instructions from the root to `cwd`. In each directory it chooses `AGENTS.override.md`, then `AGENTS.md`, then a configured fallback. An instruction file that has hard-link aliases or resolves into a protected read path is rejected, and filenames mentioned in tool output never become instruction sources. Pi rereads the files whenever it reloads resources, for example on `/reload`.

## Rule files

The TypeScript engine evaluates `.rules` contracts ported from Codex revision `a956835d020762cb2b570053af06f643a11c0ecc`. [Parity tests](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-auto-review/tests/unit/execpolicy-parity.test.mjs) replay captured outputs from the former native engine; they do not prove equivalence for every Starlark program.

For example, create a user-managed rule file containing:

```python
prefix_rule(["git", "status"], decision="allow")
prefix_rule(["git", "push"], decision="forbidden")
```

Add its path to `ruleFiles` in your policy and reload or restart. JSON `commandRules` uses `ask`/`deny`; `.rules` uses `prompt`/`forbidden` for those decisions.

- Supports Starlark functions, conditionals, comprehensions, string interpolation, `prefix_rule`, `host_executable`, `network_rule`, and `match`/`not_match` validation.
- Exposes Starlark values and policy functions, not host file/network functions or JavaScript `eval`.
- Bounds input/output, evaluation steps, collection size, nesting, and time. Invalid input, unsupported syntax, or exhausted limits rejects evaluation.
- Uses a cancellable Node.js worker for asynchronous evaluation and a bounded Node.js child process for the synchronous API. No evaluator starts when no rule files are configured.
- Uses the strongest matching decision for compound commands. Network protocol labels merge into host allow/deny lists, not separate protocol permissions.
- Requires review for uninterpretable shell syntax unless a trusted full-command rule allows it. Such bash commands match `[<shell>, "-c", command]`; such PowerShell scripts match `[<powershell executable>, "-Command", script]`.
- Literal PowerShell scripts match their inner commands, as in Codex PR #20336. Nested `bash`/`sh`/`zsh`/`dash` `-c`/`-lc` and `powershell`/`pwsh` `-Command`/`-c` wrappers are unwrapped up to four levels. On Windows, wrapper names compare case-insensitively without `.exe`, `.cmd`, `.bat`, or `.com`.
- A PowerShell command that starts with a known cmdlet or default alias, in any letter case, is matched twice: as written, and with the documented cmdlet name, such as `Remove-Item` for `rm`, `del`, or `remove-item`. A rule that matches either form applies: `forbidden` and `prompt` from either one count, and `allow` still has to cover every command. Rule words compare exactly, including case, so write cmdlet rules with the documented name (such as `["Remove-Item"]`) to cover every alias and spelling; a rule written for an alias such as `["rm"]` matches only that alias. Commands from a `bash -c` script inside PowerShell keep their own names: `sort` there is not `Sort-Object`.
- Reviews `curl`/`wget` when the destination is not an explicit HTTP URL or comes from a separate configuration file.

**Keep `allow` rules narrow.** They can authorize matching commands beyond ordinary scope, but cannot override absolute denials while Full Access is off. A command with a target that has no checkable location, such as a wildcard or provider path in PowerShell or a WSL or POSIX-root path on Windows, is reviewed even when an `allow` rule matches.

## What happens during review

### Exact-action approvals and execution

Approved local tools use Pi's original executor with the final command, working directory, environment, timeout, cancellation signal, and caller options preserved. `additional_permissions` describes the scope to review; it does not enforce that scope during execution.

TUI/RPC approval dialogs offer **Allow once**, **Allow for this session**, and **Save as an allow rule**. Whole-command escalation approvals are one-use only. Other exact-action grants bind to the tool, input, working directory, invocation source, policy, and permissions. Policy or scope changes invalidate those grants. Saved allow rules (`<agentDir>/guard/grants.json`) and package approvals (`<agentDir>/guard/package-approvals.json`) are merged into the file's latest contents, so entries saved by another running Pi session are kept.

Eligible MCP tools and skill scripts can reuse a separate package approval:

- MCP fingerprints include the server name and the registered tool definition: parameters, description, annotations, and `_meta` when an extension reports it. A new server version with an unchanged definition reuses the approval.
- Skill fingerprints include files in the directory containing `SKILL.md`. Only a single `<script>` or `<interpreter> <script>` command qualifies; symbolic-link-containing skills are not cached.
- Automatic approvals and **Save as an allow rule** persist in `<agentDir>/guard/package-approvals.json`. **Allow for this session** is session-only; **Allow once** is not reused.
- Changed content is reviewed again. Additional paths/domains, shell targets without a known location (such as WSL or POSIX-root paths on Windows, wildcard, provider, or remote share paths), escalation, rule prompts, strict MCP review, and required user input always require a fresh decision.

### Read-only automatic-review cache

Structured automatic approvals of reads are stored in `<agentDir>/pi-codex-auto-review.sqlite`. The default location is `~/.pi/agent/pi-codex-auto-review.sqlite`; `PI_CODING_AGENT_DIR` or an explicit `agentDir` takes precedence. Sessions and processes using the same Pi resource directory share the database. A lookup or write waits up to 1 second while another process writes; a database still busy after that counts as a cache miss.

- Eligible actions are Pi's `read`, `grep`, `find`, and `ls` tools and single literal shell reads. Checked commands are `cat`, `head`, `tail`, `wc`, `rg`, `grep`, `find`, `ls`, `stat`, and `pwd`, plus `git status`, `git ls-files`, and `git rev-parse`. `git diff`, `log`, and `show` require both `--no-ext-diff` and `--no-textconv`. A command written with a path (for example `/usr/bin/cat`) is eligible only when its directory is `/bin`, `/usr/bin`, `/usr/local/bin`, or `/opt/homebrew/bin`. On Windows, a command name that contains `\`, `/`, or `:` is never eligible.
- PowerShell reads qualify as one literal `Get-Content`, `Get-ChildItem`, `Get-Item`, `Test-Path`, `Resolve-Path`, `Get-FileHash`, `Select-String`, or `Get-Location` call, or a default alias such as `cat`, `ls`, or `gci`, with known parameters and no wildcard or provider path. `rg` and the git subcommands above qualify as for bash.
- Pipes, compound commands, redirections, command substitution, interpreters, writes, and network requests are excluded. Options adding execution or writes, such as `find -exec/-delete` and `rg --pre/--hostname-bin`, are also excluded.
- Reuse binds to the exact input, directory, source, permissions, policy, review context, and model. Only transient session and invocation identifiers are normalized; the assessment is rebound to the current invocation.
- Denials, failures, cancellation, user approvals, explicit fresh reviews, and automatic approvals that used file investigation are not stored. Absolute denials and pre-execution policy checks still apply.
- Expiry starts when approval is recorded and is not extended by hits. Settings changes require review under the new policy and use the new lifetime. Expired entries are not reused and are cleaned up on new approvals; storage is bounded to 10,000 entries.
- The database stores hashed keys, masked assessments, and timestamps rather than raw commands, arguments, or document contents. Database and journal files are guard-protected paths. Database read/write errors skip caching and fall back to a fresh review.

Only the approval assessment is reused. File contents and command output are produced by the actual tool each time. This cache has a different scope from the separate MCP/skill package approvals.

### Denials, errors, and retries

The reviewer uses read-only file/directory investigation tools. It distinguishes user authorization and Pi instructions from tool evidence and extension-generated messages; a tool result saying “the user approved” is not authorization.

Three consecutive denials, or ten denials in the latest fifty reviews, stop the actual model task. A review request that fails with an error Pi itself retries, such as a dropped connection, overload, or rate limit, is resent up to twice while enough of `reviewTimeoutMs` remains. Provider failures, invalid output, timeouts, and cancellation do not become approvals. Direct shell commands subsequently entered by the user are evaluated independently.

After a denial, you can send an ordinary message authorizing the exact operation, target, and content to send. The next review uses the latest instructions. To retry one recent denial explicitly, run `/approve retry`, inspect the displayed input and reason, and select it. The picker retains up to ten recent automatic denials.

A retry triggers **one new review**, not an automatic allow or session grant. The marker applies only to the same action and live context. A previous `critical` assessment can be reconsidered, but a fresh `critical` assessment or an absolute policy denial still blocks execution.

### Evidence and session records

Review input includes current policy, path/domain scope, final execution arguments, linked calls and results, and observed approval-dialog questions and answers. Environment evidence includes explicit non-secret values and the names of omitted variables, not the complete process environment.

The guard saves review evidence and assessments in Pi session custom records for reloads and active-branch restoration. Large evidence is bounded with omission markers. A shell call whose recorded environment is too large, as with a long Windows `PATH`, first shortens its longest environment values so the command, shell, and working directory stay structured; the exact action under review stays complete. If the required authorization and the complete current target do not fit the budget, automatic review fails and the call is not executed.

### Audit log

Audit records are stored in `<agentDir>/guard/audit.jsonl` and omit raw tool arguments. The default location is `~/.pi/agent/guard/audit.jsonl`; `PI_CODING_AGENT_DIR` or SDK `agentDir` changes it. Memory retains only the newest 1,000 records. The file is append-only, has no automatic rotation or deletion, and grows across sessions. To reclaim space, stop sessions using that agent directory, then manually archive or delete `guard/audit.jsonl`; the next audit event recreates a deleted file. This does not delete approval grants or the SQLite cache.

Only confirmations observed through the protected Pi `select`, `confirm`, and `input` adapters count as recorded user confirmations. Password/API-key answers are masked. Actual Pi models must return the structured `outcome` assessment; the legacy `decision` response is supported only for explicitly injected SDK `ReviewProvider` implementations.

### Reviewer redaction

Reviewer-bound context, investigation output, user authorization, and request data pass through [`@buyong/redact`](https://github.com/buYoung/pi-packages/blob/main/packages/redact/README.md). This masking cannot be disabled.

Built-in and compatibility rules mask provider tokens, authorization values, URL passwords, webhook paths, PEM private keys, sensitive assignments, and legacy `SYNTHETIC_` markers. Session/context/call/item identifiers and binding digests retain their original values.

If an action contains a detected value, the reviewer receives a masked copy and `redactedActionFields` containing JSON paths and rule IDs, not values. Masking alone does not force denial or a user prompt. Approval binding and execution use the **original action**, so masking is not a mechanism for preventing the approved command from sending a secret.

Masking occurs before evidence budgets and excerpts. File investigation reads complete text from regular files up to 1 MiB, masks it with the file-path hint (including `.env` values), then renders up to 120 lines and the 12,000-character output budget. Larger files explicitly fail investigation rather than exposing an unmasked prefix. This investigation-only read does not alter the normal `read` result returned to the user. New redaction settings apply to subsequently added evidence; stored evidence remains as recorded. Detection can miss unsupported formats or mask harmless values. Review logs before sharing them.

| `redaction` key | Entry | Effect |
| --- | --- | --- |
| `sensitiveFields` | Field name | Masks the value of a matching field; names are compared after keeping letters/digits and lowercasing |
| `rules` | `{ "id": "custom.name", "pattern": "...", "flags": "i" }` | Adds a JavaScript RegExp rule. A `(?<secret>…)` group masks only that group. Flags may contain `i`, `m`, `s`, and `u`. |
| `exceptions` | `{ "ruleId": "...", "value": "..." }` | Keeps one exact value visible for one rule; another matching rule can still mask it |
| `piiEntities` | Entity name, such as `EMAIL_ADDRESS` | Enables local personal-information detection; off by default |

```json
{
  "redaction": {
    "sensitiveFields": ["sessionKey"],
    "rules": [{"id": "custom.acme", "pattern": "ACME_[A-Z0-9]+"}],
    "exceptions": [{"ruleId": "custom.acme", "value": "ACME_EXAMPLE"}],
    "piiEntities": ["EMAIL_ADDRESS"]
  }
}
```

Invalid entries cause `INVALID_SETTINGS`; redaction validation errors name the key/index without repeating the pattern or value. Versions without this setting reject files containing it with `Unknown setting: redaction`. Back up the policy and remove the key before downgrading to such a version.

## MCP approvals

Auto Review does not connect MCP servers. Pi's built-in MCP support, or an extension that replaces it such as pi-mcp-adapter, connects them and registers their tools as `mcp__<server>__<tool>`. Auto Review reviews each call to such a tool in Pi's `tool_call` hook, before Pi runs it, and blocks the call when the review denies it. A change to the tool's registration during review, or cancellation, also blocks the call.

The guarded CLI and `createGuardedRuntime()` load Pi's MCP extension themselves. It reads `<agentDir>/mcp.json` and trusted projects' `.pi/mcp.json`, and keeps credentials in `<agentDir>/mcp-auth.json` and server logs in `<agentDir>/mcp.log`. When the session is bound to an interface again (`session.bindExtensions()`), it closes the old connections and creates new ones.

SDK `mcpToolPolicies` selects an approval mode for a `server/tool` key. Pi replaces characters other than letters, digits, and `_` in tool names, so a key matches when its tool part is the same after that replacement:

| Mode | Normal approval behavior |
| --- | --- |
| `auto` | Uses annotation precedence: destructive calls require review; otherwise read-only calls skip review, and missing destructive/open-world hints default to review |
| `prompt` | Always reviews |
| `writes` | Skips review only when `readOnlyHint` is `true` |
| `approve` | Skips normal review |

Strict review, sensitive operations, and required user input override these normal skip paths. They come from the tool's `_meta`: `codex_strict_auto_review`, `codex_sensitive_action`, and `codex_requires_user_input`. Pi's built-in MCP support does not pass `_meta` to other extensions, so these flags apply only with an MCP extension that answers the `tool-meta` event channel, such as pi-mcp-adapter. `codex_requires_user_input` is not approved by the model on your behalf. The same rules apply to the `js` tool of a server named `node_repl` (the Codex Computer Use runtime's name).

Reviewing in the `tool_call` hook has these limits:

- `tool_call` handlers of extensions loaded after Auto Review run after its review and can still change the input that Pi runs.
- Auto Review does not answer approval requests that a running MCP call sends (`elicitation/create`). Pi's MCP support and pi-mcp-adapter do not handle them either.
- After approval, cancellation and timeouts of the running call follow Pi and the MCP extension. Cancelling a request already sent depends on the external server.

## Windows and PowerShell

Bash on Windows runs through Pi's discovered shell, normally Git Bash. Path checks follow the shell that runs the command:

- Git Bash, MSYS2, and Cygwin operands such as `/c/Users/...` and `/cygdrive/c/...` map to `C:\Users\...`. Other POSIX-absolute operands such as `/tmp`, `/usr`, or `/` have no known Windows location and require review.
- WSL bash (`C:\Windows\System32\bash.exe`) receives no drive mapping; its Windows-drive and POSIX-absolute operands require review. If Pi's shell cannot be identified, drive paths are still checked against protected paths, then reviewed.
- File tools accept `/c/...`, `/mnt/c/...`, `/cygdrive/c/...`, and `~\` as Pi does.
- Protected-path checks compare case-insensitively on Windows and macOS, and Unicode-normalization-insensitively on macOS. Allowed write and read roots stay exact, so a differently spelled path is reviewed rather than allowed.
- Alternate data streams (`file:stream`, `file::$DATA`), device namespaces (`\\?\`, `\\.\`), reserved device names (`CON`, `NUL`, `COM1`, ...), drive-relative paths (`C:file`), and loopback or administrative shares fail with `INVALID_PATH`. In the part of a path that does not exist yet, a path component also fails with `INVALID_PATH` if it ends in a dot or space or looks like an 8.3 short name (`~` followed by a digit, as in `PROGRA~1`).
- Paths on another host's share (`\\host\share\...`) are not resolved or probed before approval, because doing so opens an SMB connection. They are compared with protected paths as written, then reviewed.

PowerShell commands use a fail-closed literal subset ported from Codex revision `80b88a700e4300022fe1893ecca9b8376d0c85d9`:

- Supported: bare words, single quotes with `''`, double quotes without `$`, limited backtick escapes, `;`, `|`, newlines, PowerShell 7 `&&`/`||`, and `>`, `>>`, `N>`/`N>>` for streams 1–6, and `*>`/`*>>` redirections to a file. Merging streams (`2>&1`) requires review.
- Review required: variables and expressions (`$`, `@`, `(`, `)`, `{`, `}`), the call and background operator `&`, dot-sourcing, comments, here-strings, attached `-Param:value`, `--%`, `~`, language keywords, version-dependent escapes, and Unicode quote or dash spellings.
- Cmdlets and default aliases are classified like their bash counterparts: reads (`Get-Content`, `Get-ChildItem`, `Select-String`, ...), writes (`Set-Content`, `Add-Content`, `Out-File`, `New-Item`, `Remove-Item`, ...), copies and moves, and network requests (`Invoke-WebRequest`, `Invoke-RestMethod`). Every named path parameter is checked, including `-Path`, `-LiteralPath`, `-Destination`, `-FilePath`, `-OutFile`, and `New-Item -Path X -Name Y` as `X\Y`.
- Unknown commands or parameters, path-qualified commands, provider paths (`Env:`, `HKLM:`, `FileSystem::`), pipeline input to path-taking commands, symbolic links from `New-Item`, and `curl`/`wget` (aliases of `Invoke-WebRequest` only in Windows PowerShell 5.1) require review. Wildcard paths, including redirection targets (which PowerShell resolves like `Out-File -FilePath`), are checked for protected paths up to the directory before the first wildcard, then reviewed.
- Native `git`, `rg`, `curl`, and `wget` follow the bash rules when their arguments contain no `"`.

Analysis assumes the default command table and Pi's `-NoProfile` invocation. It does not model dynamic parameter binding, aliases or functions defined at run time, module autoloading, or provider semantics; these cases require review rather than being treated as safe.

## Execution limits

- Paths are normalized literally; they are not converted into OS permission patterns.
- Direct protected paths and protected paths in interpretable commands are denied before review while the extension is on and Full Access is off.
- Startup and execution do not scan every directory tree or hard-link alias.
- Indirect access inside approved interpreters and destination changes during execution are not isolated. There is no network proxy or OS sandbox.
- Trusting an extension protects its containing code directory from model writes, not every dependency it might import elsewhere.

See the [verification matrix](testing/auto-review-protection.md) for current checks and clearly separated historical sandbox results. The Docker image and `verify:docker` command that checked this package against Ollama Cloud remain in the previous [pi-codex-auto-review](https://github.com/buYoung/pi-codex-auto-review) repository, not this one; the matrix keeps their recorded results.

## Building from source

Run from the [pi-packages](https://github.com/buYoung/pi-packages) repository root. The committed pnpm lockfile supplies the development SDK; no repackaged `vendor` SDK is needed.

```sh
pnpm install
pnpm --filter "@buyong/pi-codex-auto-review..." build
node apps/pi-codex-auto-review/dist/cli.js --help
```

The filter builds `@buyong/redact` before automatic review. Use `pnpm build` to build all workspace packages. The last command prints the guarded CLI's usage, starting with `Usage: pi-codex-auto-review [--cwd path]`, and exits with 0. Node.js can also print an `ExperimentalWarning` about SQLite to stderr; it does not mean the build failed.

To register the built automatic-review package permanently, run from the same repository root:

If `npm:@buyong/pi-codex-auto-review` or `@buyong/pi-codex` is installed, remove it with `pi remove` first, so that only one copy loads.

```sh
pi install ./apps/pi-codex-auto-review
pi list
```

Pi loads a local package directly from its path, without copying it. Rebuild after source changes, then reload or restart Pi.
