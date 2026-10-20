# Pi provider integration verification

As of 2026-10-19, Pi 1.3.0's public loader, OAuth, AgentSession and session management APIs were connected to a fake service. The full offline suite passed **171/171**, and the separate network-blocked checks passed **32/32 + mode binding 3/3**. This does not mean a real account login, browser or Devin inference succeeded.

This document summarizes the contract and evidence for developers running the 05 artifact verification. File hashes and command results are in the [04 handoff](handoffs/04-pi-provider.json); the preceding auth and model contracts are in [auth](auth-contract.md) and [models](model-contract.md).

## Ownership

| Target | Owner and boundary |
| --- | --- |
| Registration | `index.ts` → `registerDevinExtension()`; registers one `devin` provider and only `auth.oauth` |
| Account and models | Shared login/status/catalog and the 02/03 adapters. CLI files and the Pi store are separate |
| Requests | Shared protobuf, Connect, fingerprint and HTTPS transport. No Pi-only copy of the protocol |
| Tools and retries | Pi runs tools and agent retries. The provider returns tool calls and does not call the CLI's `runConversation()` |
| Compression resend | One fallback in the shared transport. Keeps the same body, trace, stage and deadline, and counts every real send |
| State and cleanup | The provider instance and the current branch. No global account/request singletons |

The factory starts no network, login or device collection. The device fingerprint is created when a real client needs it, and verification used only fixed fake device input. CLI titles, analytics and plugin calls are not added to the Pi path. Cache warming stops without inventing Devin's unverified TTL.

## Request options and responses

- `streamSimple()` returns a stream containing `start` immediately. `stream()` uses the same path and, without a reasoning option, uses the model's lowest supported level.
- The effective thinking level is mapped to an exact UID through the scoped resolver. The request UID stays in the history even when the response/usage model differs. When a payload hook switches to a supported exact UID, that UID's capabilities and output limit are checked again.
- A replacement from `onPayload` is applied to the final protobuf. Run, session, trajectory and stage identifiers cannot be changed by the hook.
- `onResponse` is awaited before reading the body. A copy of each parsed frame is passed to `onProviderStreamEvent` and processed after it is awaited. Hook failures are also tied to the request signal and the cleanup path.
- An explicit `maxTokens: 5000`, header additions/removals and caller cancellation were checked at the final consumer. The transport manages Host and Content-Length and rejects arbitrary overrides.
- Pi 1.3's per-request `env` was applied through the environment value resolution of **per-model header settings** down to the final HTTP headers. Provider-level OAuth headers are resolved earlier through the stored credential's `env`, so that is not the same path. This package adds no environment-variable-based Devin auth.
- `maxRetries` supports only 0. No full retry loop is nested inside the provider. WebSockets and unverified long caches are explicitly rejected.
- Changed system/tool declarations, user and tool-result images, tool IDs and arguments, and own thinking signatures are kept. Signatures from other providers are not read as Devin signatures. Unsupported contracts, such as grammar tools and required strict sampling, are rejected before the request.
- Start and end of text/thinking/tool events are balanced, and there is exactly one terminal event. A failed partial tool does not become success, and real Pi did not run it. Truncated streams, Connect errors and cancellations are never merged into a successful response.
- Request, response and usage UIDs are kept apart. A cost of 0 for unknown costs is an SDK placeholder and does not mean free. The unverified state is kept in `devin_provenance` and the model metadata.

### Timeouts

| Path | RPC limit |
| --- | ---: |
| CLI, core and direct provider calls without options | 90000ms |
| Value passed by Pi 1.3's default settings | 300000ms |
| Explicit `timeoutMs: 5000` | 5000ms |

In all three cases, controlled timers confirmed that the final fetch signal ended. This is not a performance measurement that actually waited 5 minutes. The compression fallback creates no new deadline. These are per-RPC limits, not a guarantee on the total work time including queue waits and separate auth RPCs. Cancellation of remote execution or billing is not guaranteed either.

## Runs, branches and budget

- The default real model HTTP budget is **8**, and the maximum factory setting is **100**. The 101st send is rejected before sending. The regular extension entry uses the default of 8.
- A run starts at `before_agent_start` and ends at the last `agent_settled`. Retries and tool follow-ups after `agent_end` use the same budget.
- Threshold compaction before start creates a pending run that the main run takes over. If the compaction fallback exhausts the budget, the main inference is not sent.
- The initial overflow failure, two auxiliary summaries and the recovery request counted as 4 calls of the same run. The two summaries of a manual compaction counted as a separate run. Auxiliary requests omit the wire `executionId` following the CLI's rules, but share the internal budget.
- Concurrent requests are serialized within a run. Cancelling while queued never lets a later request pass first.
- `pi-devin.state.v1` stores only the session/account hash, cascade/trajectory, the next stage and the run budget. No tokens, fingerprints, JWTs or duplicate transcripts.
- resume/reload restore the ID and stage of the same branch, including an unfinished budget, so reload does not reset it. fork/new session use a new ID; moving in the tree uses a new trajectory and stage 0.
- When the verified account/endpoint owner differs, the earlier history is not sent. Blocking after an account switch and a normal request in a new session were checked with the real session API.
- The checked default Pi registry had no `devin`. If a registration after this extension overrides `devin`, the session start reports the collision and stops this extension's requests. There is no public API to query the existing registry from the factory, so collision detection for every registration order is not guaranteed. Avoid duplicate installs; this package does not remove other extensions or change settings.

## Auth failures, cleanup and sensitive values

A 401 of the current auth generation stops in-flight and queued requests and rejects later direct calls before sending. Late failures of an earlier generation do not affect a new login or a new run. Invalidation from the status check RPC uses the same path. 403, 429 and local timeouts are not turned into token expiry.

Closing the owned client and releasing the lease are safe to call more than once. Caller cancellation, hook failures, server redaction and reload/shutdown were checked. Uncooperative fetches, observers and body cancels do not block termination. A voluntary `return()` on the shared stream keeps the original cleanup deadline contract.

Tokens, fingerprints and explicit header values are stripped from errors. Trusted callers' hooks receive the raw values, so the hooks' own logs are not controlled. A late server redaction erases the final content but cannot recall deltas already delivered.

## Evidence and remaining boundaries

| Evidence | Scope checked |
| --- | --- |
| `pi-lifecycle-contract.test.ts` | Real Pi tool/retry/settled order and pre-start compaction order |
| `pi-provider*.test.ts` | Final wire, options, hooks, errors, signatures, images and auth races |
| `pi-lifecycle.test.ts` | State restore, queue cancel, unfinished budget and the cap |
| `pi-integration.test.ts` | Public loader → OAuth → model/thinking → real Pi tools, retries, headers and collisions |
| `pi-runtime.test.ts` | Public fork/resume/tree/reload, account separation, timeouts, compaction budget and mode binding |

Response termination and unauthenticated failure of the **public SDK bindings** for `print`, `tui`, `json` and `rpc` were checked. This is not a run of real TUI interaction or of the full CLI JSON/RPC serialization. Discovery, loading and commands of the real archive are checked separately in 05.

The total of 171 includes the earlier 136 and 35 new ones. A regression found by the existing shared cleanup checks was fixed without changing the existing assertions. The earlier PoC baseline, the CLI default browser, token TTL, HTTPS and the final deadline remain unverified and are neither promoted nor resolved by this result.
