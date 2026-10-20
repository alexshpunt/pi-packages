# Source and artifact verification

This document is **for developers working in a source checkout**. `tests/`, `verification/` and the handoffs are not included in the npm archive. Installed users follow "Checking the installation" in the package README.

Verification needs Node >=22.19.0, pnpm, npm, the system `tar`, the dev dependencies and **Pi 1.3.0**. The current run evidence uses Node 24.14.0. Installing npm dependencies may reach the public registry. A real Devin account, browser, inference or publishing each needs separate run approval and is not part of the automated checks below.

## 1. Isolated environment and pinned Pi path

Run from `apps/pi-devin/`. Environment separation is not a security sandbox. Extension code runs with the process's permissions, so strict verification must block network access and real credential reads separately.

```bash
package_dir="$(pwd -P)"
check_dir="$(mktemp -d)"
mkdir -p "$check_dir/home" "$check_dir/tmp" "$check_dir/agent" "$check_dir/work"
: > "$check_dir/user.npmrc"
: > "$check_dir/global.npmrc"
PI_ROOT="$(node -p 'require("fs").realpathSync("node_modules/@earendil-works/pi-coding-agent")')"
node -e 'const p=require(process.argv[1]+"/package.json"); console.log(p.version); if(p.version!=="1.3.0") process.exit(1)' "$PI_ROOT"

check_env() {
  env -i PATH="$PATH" HOME="$check_dir/home" TMPDIR="$check_dir/tmp" \
    PI_CODING_AGENT_DIR="$check_dir/agent" PI_OFFLINE=1 \
    NPM_CONFIG_USERCONFIG="$check_dir/user.npmrc" \
    NPM_CONFIG_GLOBALCONFIG="$check_dir/global.npmrc" \
    NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false NPM_CONFIG_UPDATE_NOTIFIER=false \
    "$@"
}
```

`PI_ROOT` is the verified install path. Do not use this repository's default Pi 1.2 catalog or an automatic ancestor lookup instead. To check another install, pass its real install path and check its version first. The user and global npm config files must be two different empty files.

## 2. Source and real archive checks

In the same shell and package directory:

```bash
check_env pnpm typecheck
check_env pnpm verify:offline
check_env node cli.ts --help
check_env node verification/scripts/validate-package.mjs "$package_dir" \
  --expect "$package_dir/verification/inventory.json" \
  --pi-root "$PI_ROOT" --runtime --pack \
  --report "$check_dir/package-check.json"
```

Expected: exit code 0, all offline cases passing, and `status: "pass"` in `package-check.json`. The inventory independently declares the single entry point `index.ts`, one tool `devin_sidekick` and two commands `devin` and `devin-fusion`, empty flag/skill/prompt/theme registrations, 44 required files, and the dev-only paths that must be absent from the archive (`devOnlyPaths`, including the source-only CLI `cli.ts` and `src/cli/`). Check the import closure of the shipped entry point with `node verification/scripts/import-closure.mjs . --expect verification/inventory.json`.

`--pack` builds the real archive with `npm pack --ignore-scripts` and extracts it. Use `artifact.archive` and `artifact.packageDir` from the report. The `skipped` status the tool shows for `semantic import and bundle inspection` and `extracted artifact runtime and behavior` must be covered separately by the checks below. Resource checks alone do not prove the provider works. Behavior checks for features that do not exist are `not_applicable`.

## 3. Preparing production dependencies only

This **installs the real archive into a fresh consumer**. Do not link the source workspace symlinks or dev dependencies into the extracted artifact. This step needs npm registry access.

```bash
archive="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).artifact.archive' "$check_dir/package-check.json")"
artifact_dir="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).artifact.packageDir' "$check_dir/package-check.json")"
consumer_dir="$check_dir/consumer"
mkdir -p "$consumer_dir"
printf '{"name":"pi-devin-artifact-consumer","version":"0.0.0","private":true}\n' > "$consumer_dir/package.json"
check_env npm install --prefix "$consumer_dir" --omit=dev --ignore-scripts \
  --legacy-peer-deps --no-audit --no-fund "$archive"
check_env node verification/scripts/prepare-artifact.mjs "$consumer_dir" "$artifact_dir"
```

`prepare-artifact.mjs` checks the fresh consumer's lock and copies only production dependencies into the real extracted artifact. It does not overwrite an existing `node_modules`. It copies no Pi host or dev-only packages and does not change the archive's runtime files. `@types/node` may be installed as a production dependency of protobufjs.

There is no need to run `npm install` in the extracted root to resolve the dev `catalog:`/`workspace:` specifiers. Keep a regular user's tarball consumer install separate from preparing the extracted artifact for verification.

## 4. Running the extracted artifact itself

```bash
check_env node verification/scripts/validate-package.mjs "$artifact_dir" \
  --expect "$package_dir/verification/inventory.json" \
  --pi-root "$PI_ROOT" --runtime --report "$check_dir/extracted-check.json"
check_env env PI_DEVIN_TEST_PACKAGE_ROOT="$artifact_dir" PI_DEVIN_TEST_PI_ROOT="$PI_ROOT" \
  node --import "$package_dir/verification/scripts/artifact-loader.mjs" --test \
  "$package_dir"/tests/pi-provider*.test.ts \
  "$package_dir/tests/pi-integration.test.ts" \
  "$package_dir/tests/pi-runtime.test.ts" \
  "$package_dir"/tests/pi-lifecycle*.test.ts
```

Expected: the extracted resource check `pass` and provider checks **51/51**. These checks cover the account login object, catalog, exact UIDs, protobuf, images, tool results, retries, compression, cancellation, session replacement, the prompt cache, Fusion and SDK mode binding. They do not run the tool runner in place of Pi. Running all of `tests/*.test.ts` through the loader is not supported: the archive does not contain the CLI (`cli.ts`, `src/cli/`), so the CLI tests have nothing to load from it. The loader redirects only imports within the same process to the extracted artifact.

Check the real Pi execution path of the extracted artifact by passing `--package-root "$artifact_dir" --pi-root "$PI_ROOT"` to the step 6 runner. The Pi process sandbox then also refuses reads of the source `src/`, `index.ts` and `cli.ts`, and the help scenario checks that refusal (`EPERM`) as a control.

`artifact-loader.mjs` is a source-only Node preload that redirects the production imports of the source tests to the extracted artifact and pins host imports to the **public entries** of `PI_ROOT`. The tests and fake inputs are only check tools, not runtime dependencies of the archive. It uses Node's public `registerHooks()`. Setting `PI_DEVIN_TEST_REPORT_DIR` to an existing directory saves a per-process mapping record.

The recorded sandbox run used an extraction path containing spaces and Hangul characters, and a separate cwd. Its provider checks (44 at that time) passed even while the OS sandbox (`sandbox-exec`) refused network outside loopback, the real HOME outside the repository and Node, and reads of the source `apps/pi-devin/src/`, `index.ts` and `cli.ts`. Source tests run without the loader under the same profile fail with `EPERM` (negative control). The command above, which only sets environment variables, does not by itself provide the same OS isolation.

## 5. Local Pi registration and cleanup

Run this step only with the temporary settings too. The version of the `pi` executable must match the `PI_ROOT` checked earlier.

```bash
check_env pi install "$artifact_dir"
check_env pi list
check_env pi --no-skills --no-prompt-templates --no-themes --no-context-files \
  -e "$artifact_dir" --help
check_env pi remove "$artifact_dir"
```

Expected: one registered path, no extension errors, and an empty temporary registration list after removal. The local package files must remain. This is not a check of `/login` or chat in the real TUI, or of registry publishing/updates. Resume, fork, tree and reload/shutdown are checked by the public SDK integration checks above.

## 6. Real Pi execution path

Run from `apps/pi-devin/` on macOS. Each scenario runs the pinned Pi bin inside `sandbox-exec` with a fresh temporary HOME, `PI_CODING_AGENT_DIR` and cwd. `PI_OFFLINE` is not used. print and JSON use only the stored catalog, so the runner first fills `models-store.json` through a real RPC background refresh.

```bash
node verification/scripts/host-contract.mjs --report "$check_dir/host-contract.json"
# extracted artifact: --package-root "$artifact_dir" --pi-root "$PI_ROOT"
# subset: --only rpc,print,json,oauth,cache,tui,help
```

Expected: exit code 0 and `outcome: "pass"` in the report. The scope is:

- **RPC**: catalog projection, model and level selection, Unicode, one tool call, a partial tool error, cancel, `/devin-fusion` saving and applying, the `/devin` recommended filter (groups with a variant the catalog marks isRecommended, with unchanged level mappings, + Fusion), settings saving and the detailed notification with 0 catalog and model requests and no status line, the real child Pi sidekick's waiting and background reports and session file, no sidekick-only models in the lead list or the shared stored list after a sidekick run, the 8-call budget, shutdown during a stream, and 0 remaining subprocesses after exit
- **print and JSON**: tool flow, error and 401 exit codes, JSONL serialization and a single terminal event
- **OAuth only**: 0 Devin requests with `--api-key`, API key environment variables or an `api_key` in auth.json, and the OAuth path
- **Cache**: pre-request rejection of `PI_CACHE_RETENTION=long` and its acceptance for 24h models
- **TUI**: prompt, `/thinking`, shift+tab, `/model`, column switching, search and saving in the two-column `/devin-fusion` screen, usage details and saving the status toggle in the `/devin` screen, no sidekick-only models in `/model` or `/scoped-models`, usage in the footer status line, Escape cancel, `/reload`, 0 requests after `/logout`, and `/quit`

`--keep` keeps the temporary root. For the minimum version check, run the same command with the Node 22.19.0 executable.

## Result records

- The handoff snapshots under `handoffs/` and `followup/handoffs/` are verification records from each implementation point. Do not overwrite past records because their hashes differ from the current code.
- `package-check.json`, `extracted-check.json` and `handoffs/05-package-checks.json` are the distribution evidence. Read them together with the real archive path and hash, dependencies, commands run, how `skipped` was covered, and limits.
- If the final README or runtime files change, build a new archive and redo the extracted-artifact checks.
- Live service, CLI parity and the earlier cleanup findings are judged separately. The records of steps 2–5 above do not include the Node 22.19.0 minimum run or other OSes. The real Pi execution path and the Node 22.19.0 results are in `followup/handoffs/05-host-contract.json`.
