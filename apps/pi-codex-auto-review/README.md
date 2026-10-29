# pi-codex-auto-review

**English** | [한국어](README.ko.md)

Execution approval review for [Pi](https://pi.dev), inspired by Codex's **Approve for me**. The extension checks shell, file, and MCP tool calls against local policies. Calls that need approval go to automatic model review or to user confirmation, whichever you choose. Approved calls use Pi's original executor.

**This is an approval assistant, not an OS sandbox.** Approved commands run with the host's permissions; the extension does not isolate files, processes, or network access.

The quick start below installs automatic review only. To install it together with Computer Use, Fast mode, and image generation, follow the [`@buyong/pi-codex` guide](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex/README.md). Other packages from the same repository are listed in the [pi-packages README](https://github.com/buYoung/pi-packages#choose-a-package).

## Requirements

| Component | What you need |
| --- | --- |
| Node.js | 22.19 or later |
| Pi | 1.0.0 or later. The [guarded CLI and SDK](docs/usage.md#run-with-protected-startup) refuse to start on earlier versions. |
| Model access | A configured Pi provider and conversation model. Automatic review uses this model unless you select a separate review model. |

The rule engine needs no Rust compiler or platform-specific rule binary. Automatic review makes additional model calls that count toward your provider usage.

## Quick start

Before installing, check two conditions:

- Do not enable this extension both individually and through `@buyong/pi-codex`. Duplicate registrations can affect tools, commands, and event handlers.
- If the older unscoped `pi-codex-auto-review` is installed, remove its source as shown by `pi list` first, in the same global or `--local` scope.

With Pi installed, install the latest published automatic-review package and start a session:

```sh
pi install npm:@buyong/pi-codex-auto-review
pi list
pi
```

`pi list` shows `npm:@buyong/pi-codex-auto-review` and its installed path under `User packages:`.

In Pi:

1. Configure provider access with `/login` if needed, then select your conversation model.
2. Run `/approve` and choose **Approve for me**.
3. Send this prompt:

```text
Use bash to run exactly node --version and report the result. Do not install anything or change files.
```

With the default policy, this command requires approval review. A successful run reports the installed Node.js version; a denied or failed review does not execute the command. Custom rules and existing approvals can change the review route.

Use `/approve-model` to choose a review model without changing the conversation model. For user confirmation instead of model review, choose **Ask for approval** in `/approve`.

### Installation scope and versions

- Add `--local` to `pi install` for a project-scoped entry. Pi loads project packages only after you trust that project.
- Append `@<version>` to the npm package name to pin a published release. These documents describe the current source. A published version may not include its latest changes.

**To refuse to start when approval controls fail to load,** use the [guarded CLI or SDK](docs/usage.md#run-with-protected-startup). Guarded startup also checks that the approval controls are ready before execution. Pi 1.4.0 exits with code 1 on extension loading errors during a fresh CLI startup, but reload and SDK loading handle such errors separately.

## Approval modes and settings

`/approve` selects an approval mode or turns the whole extension on or off. It does not make every ordinary read or workspace write require a prompt.

| Choice | Review behavior | Persistence |
| --- | --- | --- |
| **Approve for me** | Automatic model review; the default | Saved |
| **Ask for approval** | User confirmation | Saved |
| **Full Access** | After confirmation, skips approval and all path, command, and network restrictions, including protected paths and deny rules | Never saved; until Pi exits or another approval mode is chosen |
| **Auto Review Off** | Disables automatic review, approval prompts, and policy restrictions; uses Pi's original tools | Saved |

- `/approve off` turns the whole extension off.
- `/approve on` turns it back on with the previous approval mode and review model.
- `/approve status` shows its current state.

On/off changes apply immediately and persist across sessions. Choosing **Approve for me**, **Ask for approval**, or confirmed **Full Access** in `/approve` also turns the extension back on. Changing only the review cache expiry or the review model leaves it off.

Settings are saved to `<agentDir>/guard/settings.json`, or to the policy file selected with the CLI `--policy` option or the SDK `settingsPath` option. `agentDir` normally is `~/.pi/agent` and honors `PI_CODING_AGENT_DIR`. Cancelling a picker preserves the existing settings.

The [usage guide](docs/usage.md#choose-an-approval-method-and-review-model) covers which models `/approve-model` offers, how settings are saved, reloading, and how Pi's shell settings are kept. For a denied operation, read the reason first. Then authorize the exact operation in a message, or use [`/approve retry`](docs/usage.md#denials-errors-and-retries); a retry requests a new review, not an automatic approval.

## Approval boundaries

With **the extension on and Full Access off**, the default policy separates ordinary writes, operations that need review, and absolute denials:

| Target | Behavior |
| --- | --- |
| Writes in the workspace, temporary directories, and configured `writableRoots` | Allowed in `workspace-write` mode; writes require review in `read-only` mode |
| Other writes, and writes to project `.git`, `.agents`, `.codex`, `.aws`, and `.pi` metadata | Require review rather than an unconditional block |
| The extension's control files (listed below) | Reads and writes through guarded tools are denied |
| Project `.pi/guard` | Writes are denied |
| The extension's own code and explicitly trusted extension code directories | Writes by the model's tool calls are denied |
| Built-in `powershell` calls (Windows) | Guarded like `bash`, using a literal PowerShell grammar |

Control files are the `<agentDir>/guard/` directory, the selected policy file, configured rule files, and the review cache `<agentDir>/pi-codex-auto-review.sqlite` with its `-journal`, `-wal`, and `-shm` files.

The extension registers the `powershell` tool inactive. Enable it with Pi's `defaultTools` setting (for example `"+powershell"`) or `--tools`; see [Windows and PowerShell](docs/usage.md#windows-and-powershell).

Absolute denials are checked before model review and saved approvals. Review errors, timeouts, and cancellation never count as approval. Saved exact-action grants bind to the tool, input, execution context, policy, and requested scope. MCP tools and skill scripts can also reuse an approval while their version and content stay unchanged; [approval reuse](docs/usage.md#exact-action-approvals-and-execution) lists which ones qualify.

Reviewer-bound evidence is masked with `@buyong/redact`, and you can add masking rules and opt-in personal-information detection. Masking protects the reviewer's copy, not the original action executed after approval.

When the reviewer investigates a file up to 1 MiB, it applies masking to the whole file before excerpting. It refuses files larger than 1 MiB. See [policy settings](docs/usage.md#policy-file) and [reviewer redaction](docs/usage.md#reviewer-redaction).

Audit records go to `<agentDir>/guard/audit.jsonl`, which grows without rotation. Stop sessions using that directory before you archive or delete the file.

### What approval does not guarantee

- **OS isolation:** reviewed scope is not an enforced permission boundary. Approved shells and interpreters can access files indirectly or contact different destinations during execution. There is no network proxy or exhaustive directory/hard-link scan.
- **Coverage of trusted code:** Pi, loaded extensions, and external MCP servers are trusted execution components. Other extensions' tools, except MCP tools, do not automatically receive this approval gate, and execution inside an external MCP server is not isolated.
- **Immediate external cancellation:** stopping a request already sent to an MCP server depends on that server's implementation.
- **Codex-equivalent security or decisions:** this extension follows the public policy and rule contracts in Codex [`rust-v0.160.0`](https://github.com/openai/codex/tree/a956835d020762cb2b570053af06f643a11c0ecc), not its proprietary model or sandbox.
- **Dependencies of your Pi installation:** dependency fixes recorded for this repository do not change the packages that a separately installed Pi uses. See [dependency security](docs/security/dependencies.md).

## Build and verify from source

For contributors, run from the [pi-packages](https://github.com/buYoung/pi-packages) repository root. The Pi help check needs the installed Pi CLI:

```sh
pnpm install
pnpm --filter "@buyong/pi-codex-auto-review..." build
cd apps/pi-codex-auto-review
pnpm run typecheck
pnpm run lint
pnpm run test:unit
verification_dir="$(mktemp -d)"
PI_CODING_AGENT_DIR="$verification_dir" PI_OFFLINE=1 \
  pi --no-extensions -e "$PWD/dist/index.js" --help
test ! -e "$verification_dir/pi-codex-auto-review.sqlite"
```

`test:unit` runs the unit, integration, conformance, execution, and end-to-end tests on the current OS using model/UI fixtures, not paid model calls.

The help check prints Pi's help with this extension loaded, without starting a session or calling a model. Expected: every command exits 0 and no review database (`pi-codex-auto-review.sqlite`, the [read-only review cache](docs/usage.md#read-only-automatic-review-cache)) is created. Pi may create its own settings and authentication files in the temporary directory.

To load the built extension in a session, follow [source installation](docs/usage.md#building-from-source).

A local pass does not verify another OS or a live model. Docker and Windows results from the earlier [pi-codex-auto-review](https://github.com/buYoung/pi-codex-auto-review) repository are recorded in the [verification matrix](docs/testing/auto-review-protection.md).

## Documentation and help

- [Usage](docs/usage.md) · [한국어](docs/usage.ko.md) — Installation, approval settings, CLI/SDK, policies, and verification.
- [Dependency security](docs/security/dependencies.md) · [한국어](docs/security/dependencies.ko.md) — Recorded fixes and their scope.
- [Protection verification](docs/testing/auto-review-protection.md) · [한국어](docs/testing/auto-review-protection.ko.md) — Current checks, historical results, and unverified boundaries.
- [Issues](https://github.com/buYoung/pi-packages/issues) — Bug reports and questions.

## License

[Apache-2.0](LICENSE). Attribution for the TypeScript port of Codex rule contracts and included policies is preserved in [NOTICE](NOTICE).
