# Dependency security fixes

**English** | [한국어](dependencies.ko.md)

The current source removes `@anthropic-ai/sandbox-runtime`, its transitive `node-forge` dependency, and `bundleDependencies`. The distribution does not include `node_modules` and uses the Pi host as a peer dependency. Its only runtime dependency is `@buyong/redact`, the masking engine published from this repository's `packages/redact`. It is pinned to an exact version, has no runtime dependencies of its own, and npm installs it with the extension. This extension does not replace dependencies in an installed Pi host.

## Current npm distribution

An installed dependency's `overrides` do not apply to the consumer project, and `package-lock.json` is not published. The sandbox runtime bundled in earlier packages has been removed from the current source. Prepack checks ensure that sandbox code and `node_modules` are absent from the archive.

The Pi host remains in `peerDependencies` and is not bundled. `@buyong/redact` is a regular `dependencies` entry, not a bundled one; the archive contains only a reference to it. This repository's development lockfile does not change or guarantee the `brace-expansion` version of a separately installed Pi.

Run `pnpm pack` in the package directory to apply the prepack checks. The current source builds and packages JavaScript without a Rust compiler or platform executable, and consumer installation needs no security patch script. See the [repository release process](https://github.com/buYoung/pi-packages#shared-ci-and-per-package-releases).

## Development dependencies in this repository

In pi-packages, development uses Pi 1.4.0 from the root `pnpm-lock.yaml`. Its `minimatch` resolves `brace-expansion 5.0.12` without an override, and both dependency security checks in `tests/unit/dependency-security.test.mjs` passed on 2026-10-29. When you update dependencies, check the installed version and run these security regression checks again.

These results apply to environments installed with this repository's lockfile. They do not change dependencies in separately installed Pi hosts or other projects. In other environments, check the dependencies actually resolved and that environment's own audit results.

## Historical records (0.1.4 and earlier)

The following sections record fixes for earlier versions, including the sandbox runtime that the current source no longer contains.

### Audit before the 0.1.3 release

For the lockfile dated 2026-10-04, `npm audit --omit=dev --audit-level=high` reported zero vulnerabilities. Including development dependencies, `npm audit --audit-level=high` reported six high-severity findings in `release-it 21.0.1`'s transitive `basic-ftp` and `undici` dependencies and their parent paths. These development tools are not included in the distribution archive.

The fix proposed by `npm audit fix --force` changes the major version to `release-it 20.2.0`, so it was not applied in that release. The development tool findings remained unresolved and are separate from the passing production dependency audit.

### Remediation for the earlier sandbox version

This record predates the sandbox removal. At that time, three high-severity audit findings were addressed; the installed versions `node-forge 1.4.1-0` and `brace-expansion 5.0.12` and zero audit findings were recorded. It does not describe an audit of all current development dependencies. The original evidence is in the [security verification record](https://github.com/buYoung/pi-packages/blob/main/docs/verification/auto-review/11-dependency-security.json).

| Item | Applied fix | Release status |
| --- | --- | --- |
| `node-forge` and its `sandbox-runtime` consumer | Pinned commit `ceba34402e329f0365134f23fe19898756527d65` from the [fix PR](https://github.com/digitalbazaar/forge/pull/1152), which rejects extra RSA `DigestAlgorithm` elements | An **unmerged development version**, not an official fixed release. Compared with 1.4.0, library code changed only in RSA verification. |
| `brace-expansion` | Used official fixed version `5.0.12` | Listed as a fixed version in the [official security advisory](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr). |

At the time of that record, the [official `node-forge` advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv) listed no fixed release. The version was not raised arbitrarily, and audit findings were not suppressed. The actual patch source was pinned and checked with valid PKCS#1 and PSS signatures and with malformed signatures that the native crypto module rejects.

### Pi package lock adjustment

Pi 0.99.1's published `npm-shrinkwrap.json` pins `brace-expansion 5.0.9`. The earlier remediation used a repackaged development archive because the installation paths checked at that time did not keep the root override. That workaround was included through 0.1.4.

Before the move to [pi-packages](https://github.com/buYoung/pi-packages), the source used **official `@earendil-works/pi-coding-agent@0.99.1` directly**, with its registry integrity recorded in `package-lock.json`. The root override and committed dependency lock kept `brace-expansion 5.0.12`. A fresh isolated `npm ci --ignore-scripts` installed that version from the official SDK, and regenerating the lockfile with `npm install --package-lock-only --ignore-scripts` kept it. Both existing dependency security checks passed. The SDK API version did not change, and the `vendor` archive, its metadata, and the repackaging script were removed. The standalone npm repository was checked at that time with these commands; they do not apply to the current pnpm monorepo:

```sh
npm ci --ignore-scripts
npm ls brace-expansion --all
npm run build
npm run test:contracts
npm audit --json
```

Docker and CI used the same committed lockfile with `npm ci`; no generated SDK archive or install-time patch was needed. The earlier archive's provenance remains in the [0.1.4 source](https://github.com/buYoung/pi-codex-auto-review/blob/v0.1.4/vendor/pi-sdk-security.json).

### Recorded results

- Before the fixes, `node-forge` passed valid signatures but also accepted a malformed signature as `true`, and the `brace-expansion` test input was stopped by a five-second limit.
- After the fixes, `node-forge` still passed valid signatures and rejected the malformed one, and the same `brace-expansion` input completed within the limit.
- Fifty-eight local checks covering contracts, Pi integration, native isolation, and package execution passed. Full platform aggregation and live model revalidation were deferred to the final source that included later feature changes.
