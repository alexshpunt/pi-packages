# Package verification tools

`validate-package.mjs`, `lib/runtime.mjs` and `lib/theme.mjs` are source-only verification tools taken from the repository's `.agents/skills/pi-package-creator/scripts/`. Their relative import structure is kept. The `verification/scripts/` directory is not included in the npm archive.

In this package's copy, the `isolatedEnv()` allowlist was extended so the caller-specified `HOME`, npm config files and audit/fund/update-notifier choices reach the child too. The original removed HOME, which caused `uv_os_homedir returned ENOENT` in a default-deny sandbox. Instead of falling back to the real user home, a temporary HOME and two different empty npm config files are kept. The tool's resource isolation is not itself a file or network sandbox.

`validate-package.mjs` also reads `devOnlyPaths` from `verification/inventory.json`: paths that may exist in the source but must be absent from the archive (a trailing `/` means the whole directory), checked only against the real archive list from `--pack`. `forbiddenFiles` are files that must be absent from the source too.

`import-closure.mjs` follows static and dynamic imports and `import.meta.url` resources from the manifest's extension entry points. The source-only CLI (`cli.ts`) is not shipped, so it is not an entry point. `import-closure.mjs` checks that every reached file is inside `files`, none points to `devOnlyPaths`, and external packages are declared dependencies. It matches string patterns, so computed specifiers are not found.

Passing the `validate-package.mjs` resource/pack checks does not replace provider behavior or cleanup success. Run these checks alongside the public SDK and extracted-artifact checks in `../README.md`.

## Real Pi execution path check

`host-contract.mjs` runs the pinned Pi 1.4.0 bin in TUI, print, JSON and RPC modes and checks the provider contract against a loopback mock Devin service. The helper files under `host-contract/` are only for this runner.

| File | Role |
|---|---|
| `mock-devin.mjs` | Replies with the source codec and `tests/fixtures/model-catalog.json`, and summarizes received requests without identifying data. |
| `guard.mjs` | Node preload for the Pi process. Refuses external connections, browser openers and keychain commands, and records the attempts. |
| `add-tool.mjs` | Extension with an `add` tool for verification that uses no files, shell or network. |
| `pty-bridge.py` | Runs the TUI in a PTY it owns and cleans up the process group on exit. |

macOS `sandbox-exec` does the real blocking. It refuses network outside the mock service port, reads of the real HOME (except the repository, Node and temp paths) and writes outside the temp root. Without the sandbox or `python3`, the result is `blocked`.

## Live check (07)

`live/live-check.mjs` prepares the 06 archive in a temporary state and runs only the cases of the approved plan with the pinned Pi bin. The procedure and plan are in `../followup/live/README.md`.

`live/live-guard.mjs` wraps `request()` of `node:http` and `node:https` in the Pi process. Before the body is sent, it enforces the host, the final `chatModelUid`, the overall model request cap and the catalog's free tier. The HTTP client bundled in Pi bypasses this path, so hosts are also checked at the socket connection stage. In live use the network cannot be restricted by domain, so the sandbox restricts only file reads and writes and the guard handles host restrictions.

The `dry-run` subcommand runs the same plan against the mock service and checks the blocking controls.
