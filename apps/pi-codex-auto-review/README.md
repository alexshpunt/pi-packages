# pi-codex-auto-review

**English** | [한국어](README.ko.md)

Execution approval review for [Pi](https://pi.dev), inspired by Codex's **Approve for me**. Check shell, file, and MCP tool calls against local policies, then choose automatic model review or user confirmation for calls that need approval. Approved calls use Pi's original executor.

**This is an approval assistant, not an OS sandbox.** Approved commands run with the host's permissions; the extension does not isolate files, processes, or network access.

The quick start below installs automatic review only. To install it together with Computer Use, Fast mode, and image generation, follow the [`@buyong/pi-codex` guide](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex/README.md). Other components are listed under [workspace packages](#workspace-packages).

## Requirements

| Component | What you need |
| --- | --- |
| Node.js | 22.19 or later |
| Pi | 1.0.0 or later. The guarded CLI and SDK reject Pi versions before 1.0.0 despite the broader manifest peer range. |
| Model access | A configured Pi provider and conversation model. Automatic review uses this model unless you select a separate reviewer. |

The rule engine is JavaScript compiled from TypeScript: no Rust compiler or platform-specific rule binary is needed. Pi's own native dependencies are separate. Automatic review makes additional model calls and may consume provider usage.

## Quick start

With Pi installed, install the latest published automatic-review package and start a session:

```sh
pi install npm:@buyong/pi-codex-auto-review
pi list
pi
```

In Pi:

1. Configure provider access with `/login` if needed, then select your conversation model.
2. Run `/approve` and choose **Approve for me**.
3. Send this prompt:

```text
Use bash to run exactly node --version and report the result. Do not install anything or change files.
```

With the default policy, this command requires approval review. A successful run reports the installed Node.js version; a denied or failed review does not execute the command. Custom rules and existing approvals can change the review route.

Use `/approve-model` to choose a reviewer without changing the conversation model. For user confirmation instead of model review, choose **Ask for approval** in `/approve`.

### Installation scope and migration

- Add `--local` to `pi install` for a project-scoped entry. Pi loads project packages only after trusting that project.
- Append `@<version>` to the npm package name to pin a published release. These documents describe the checkout; a published version may not include unreleased changes.
- Do not enable this extension both individually and through `@buyong/pi-codex`. Duplicate registrations can affect tools, commands, and event handlers.
- When replacing the older unscoped `pi-codex-auto-review`, remove its source as shown by `pi list` before installing the scoped package. Use the same global or `--local` scope when removing it.

**Need execution to refuse startup if approval controls fail to load?** Use the [guarded CLI or SDK](docs/usage.md#run-with-protected-startup). Normal Pi extension loading can report a failure and continue without the extension.

## Approval modes and settings

`/approve` selects an approval mode or turns the whole extension on or off. It does not make every ordinary read or workspace write require a prompt.

| Choice | Review behavior | Persistence |
| --- | --- | --- |
| **Approve for me** | Automatic model review; the default | Saved |
| **Ask for approval** | User confirmation | Saved |
| **Full Access** | After confirmation, skips approval and path, command, and network restrictions—including protected-path and deny-rule checks | Never saved; until Pi exits or another approval mode is chosen |
| **Auto Review Off** | Disables automatic review, approval prompts, and policy restrictions; uses Pi's original tools | Saved |

Use `/approve off` to turn the whole extension off, `/approve on` to restore the previous approval mode and review model, and `/approve status` to show its current state. On/off changes apply immediately and persist across sessions. Choosing an approval mode in the picker also turns the extension back on.

Settings are saved to `<agentDir>/guard/settings.json`, or the policy file selected through the CLI/SDK. `agentDir` normally is `~/.pi/agent` and honors `PI_CODING_AGENT_DIR`. Cancelling a picker preserves the existing settings. Fixed command, picker, and approval-dialog text is in English.

The [usage guide](docs/usage.md#choose-an-approval-method-and-review-model) covers model scope, saved settings, and reloading. For a denied operation, read the reason before changing your authorization or using [`/approve retry`](docs/usage.md#denials-errors-and-retries); a retry requests a new review, not an automatic approval.

## Approval boundaries

With **the extension on and Full Access off**, the default policy distinguishes ordinary scope, reviewable operations, and absolute denials:

| Target | Behavior |
| --- | --- |
| Ordinary workspace and temporary-directory writes | Allowed in `workspace-write`; writes require review in `read-only` |
| Writes outside ordinary scope or to project `.git`, `.agents`, `.codex`, `.aws`, and `.pi` metadata | Require review rather than an unconditional block |
| Guard control files, selected policy, and rule files | Protected from guarded reads and writes; project `.pi/guard` is write-protected |
| The extension's own code and explicitly trusted extension code directories | Protected from model writes |

Absolute denials are checked before model review and saved approvals. Review errors, timeouts, and cancellation never count as approval. Saved exact-action grants bind to the tool, input, execution context, policy, and requested scope; eligible MCP tools and skill scripts can separately reuse approval for unchanged versions and content.

Reviewer-bound evidence is masked with `@buyong/redact`. Custom masking rules and opt-in personal-information detection are available. Masking protects the reviewer copy, not the original action executed after approval. See [policy settings](docs/usage.md#policy-file), [approval reuse](docs/usage.md#exact-action-approvals-and-execution), and [reviewer redaction](docs/usage.md#reviewer-redaction).

### What approval does not guarantee

- **OS isolation:** reviewed scope is not an enforced permission boundary. Approved shells and interpreters can access files indirectly or contact different destinations during execution. There is no network proxy or exhaustive directory/hard-link scan.
- **Coverage of trusted code:** Pi, loaded extensions, and external MCP servers are trusted execution components. Other extensions' tools do not automatically receive this approval gate, and execution inside an external MCP server is not isolated.
- **Immediate external cancellation:** stopping a request already sent to an MCP server depends on that server's implementation.
- **Codex-equivalent security or decisions:** the baseline is the public policy and rule contracts in Codex [`rust-v0.160.0`](https://github.com/openai/codex/tree/a956835d020762cb2b570053af06f643a11c0ecc), not its proprietary model or sandbox.
- **Changes to an installed Pi host:** this repository's lockfile does not replace a separate host's dependencies. See [dependency security](docs/security/dependencies.md).

## Workspace packages

Each package has its own version and release in the [pi-packages](https://github.com/buYoung/pi-packages) repository. Choose the package for the feature you need; combined installation keeps each component's requirements.

| Package | Purpose and requirements |
| --- | --- |
| `@buyong/pi-codex-auto-review` | Automatic approval review; this README and the [usage guide](docs/usage.md) |
| [`@buyong/pi-codex`](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex/README.md) | All four extensions and the `imagegen` skill; do not also enable the same individual packages |
| [`@buyong/pi-codex-computer-use`](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-computer-use/README.md) | Computer Use and Chrome Browser Use with an installed Codex Desktop runtime; Linux is unsupported |
| [`@buyong/pi-codex-fast-mode`](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-fast-mode/README.md) | `/codex-fast` selects Standard, Fast, or Ultrafast for supported provider/model/authentication combinations; `/codex-fast status` reports local diagnostics |
| [`@buyong/pi-codex-image-gen`](https://github.com/buYoung/pi-packages/blob/main/apps/pi-codex-image-gen/README.md) | Image generation and editing using Pi's `openai-codex` subscription login |
| [`@buyong/redact`](https://github.com/buYoung/pi-packages/blob/main/packages/redact/README.md) | Credential, private-key, and opt-in personal-information masking; a library, not a Pi extension |

Check publication before installing a newly prepared package. A local manifest version is not proof that it is available on npm.

## Build and verify from source

For contributors, run from the [pi-packages](https://github.com/buYoung/pi-packages) repository root:

```sh
pnpm install
pnpm --filter "@buyong/pi-codex-auto-review..." build
pnpm --filter @buyong/pi-codex-auto-review test:unit
```

`build` also builds `@buyong/redact`, which this package imports. `test:unit` runs the unit, integration, conformance, execution, and end-to-end tests on the current OS using model/UI fixtures, not paid model calls. To load the built extension, follow [source installation](docs/usage.md#building-from-source).

A local pass does not verify another OS or live model. The Docker and Windows verification of the previous [pi-codex-auto-review](https://github.com/buYoung/pi-codex-auto-review) repository is not part of this repository; its records remain in the [verification matrix](docs/testing/auto-review-protection.md).

## Documentation and help

- [Usage](docs/usage.md) · [한국어](docs/usage.ko.md) — Installation, approval settings, CLI/SDK, policies, and verification.
- [Dependency security](docs/security/dependencies.md) · [한국어](docs/security/dependencies.ko.md) — Recorded fixes and their scope.
- [Protection verification](docs/testing/auto-review-protection.md) · [한국어](docs/testing/auto-review-protection.ko.md) — Current checks, historical results, and unverified boundaries.
- [Issues](https://github.com/buYoung/pi-packages/issues) — Bug reports and questions.

## License

[Apache-2.0](LICENSE). Attribution for the TypeScript port of Codex rule contracts and included policies is preserved in [NOTICE](NOTICE).
