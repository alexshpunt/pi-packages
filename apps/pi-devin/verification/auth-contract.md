# Account login contract and verification scope

## Implemented flows

The CLI and Pi both use `loginAccount()` in `src/core/auth/login.ts`. Pi provides an object for `auth.oauth`, and extension registration is wired in task 04. API key input never replaces account login.

| Choice | Web app path and redirect | Code exchange | Encoding |
|---|---|---|---|
| Default browser | `/auth/cli/continue`, `http://127.0.0.1:<port>/callback` | `POST https://api.devin.ai/auth/cli/token`, `{code, code_verifier}` | REST JSON |
| CLI manual code | `/devin/account/login`, `chisel-show-auth-token` | Plain code: `ExchangeDevinCLIPKCECode`; `wspkce$`: `ExchangePKCEAuthorizationCode` without the prefix | Connect protobuf by default |
| Explicit legacy path | `/auth/cli/continue`, loopback callback | The two Connect RPCs above | `--login-encoding proto` or `json` |

- The default browser flow passes `prompt=select_account`, the state and an S256 challenge. The manual flow uses a UUID state and S256.
- In the CLI, `--force-manual-token-flow` selects the manual code flow and `--no-browser` skips opening the browser automatically. Input is not echoed.
- `--api-server-url` is the target of later RPCs and the Connect exchange server. The REST exchange server is set separately with `--login-api-url`. A single loopback option does not change every remote target.
- An explicit `--login-encoding` keeps the legacy Connect path. Specifying the REST flow together with a Connect encoding, or a REST exchange server for the manual flow, is rejected before the URL is shown.
- The flow is decided first; the code prefix alone never moves between REST and Connect. On an exchange failure, the one-time code is not resent to another endpoint or encoding.
- Only the path that first submits a valid code, callback or manual input, wins. The callback checks the state, path and method; a pasted callback URL is also checked for origin, path and state. API key and session token input is rejected.
- The overall login limit is 300000ms and the code exchange limit 30000ms. Caller cancellation applies too, and the input, the callback server and the owned transport are cleaned up.

## Evidence and remaining limits

The default browser contract is pinned to the URL, loopback and REST code exchange contract of Cognition's public `@cognitionai/opencode-devin@0.3.0` [`dist/auth.js`](https://unpkg.com/@cognitionai/opencode-devin@0.3.0/dist/auth.js). It is recorded separately from the earlier finding that the REST functions exist in the real CLI. The 10-minute callback limit used by the public client was not copied; the existing CLI's 5-minute limit was kept.

The manual flow follows the plain and prefixed manual-code observations in the preserved retry records. The Connect default contract of the existing `login()` and the 93 extracted baseline cases remain unchanged. The new UI's default REST choice is verified by additional cases.

**This task neither ran the default browser flow nor re-verified a real account login.** Local verification of the default REST flow is not turned into measured parity with the CLI's default path or live-service success. The earlier A03/A04/A05 findings and observation limits are unchanged.

## Pi's non-refreshing session representation

The stored format is `type: "oauth"`, `access: <exchange result>`, `refresh: ""`, `expires: 0` plus version 1 Devin metadata. `expires: 0` is **not a server expiry time but a sentinel meaning there is no expiry information, so the session is checked on every auth resolution**. No server TTL or refresh grant is invented.

The following behavior was checked with the public `Models` and `InMemoryCredentialStore` of Pi AI 1.3.0, the same version as the install target. Real file storage, repeated resolution and logout were also checked with coding-agent 1.3.0's public `ModelRuntime` and a temporary `authPath`. This host verification passed in an OS sandbox that blocked the network and real credential paths.

- `checkAuth()` returns `oauth` and does not look up environment API keys.
- Each `getAuth()` calls `refresh()` once. The adapter calls `GetUserStatus` with a new client and returns **the same token and the same expires**. This is a status recheck, not a successful token refresh.
- Host store changes happen at most once per explicit resolution. There are no internal loops or periodic timers. Since `expires: 0` remains, concurrent resolutions each go through their own status request and store path and are not merged into one.
- The server lifetime is unknown, so an explicit `minOAuthValidityMs` guarantee is rejected. Do not use this to export tokens with a guaranteed validity.
- `refresh({allowNetwork:false})` does no auth status check. Only the network-allowed stage rechecks before moving on to the model lookup.
- A started refresh follows the **15000ms signal** set by Pi. The original caller's cancellation can return immediately, but an already started status check and store may continue briefly under host policy. Logout is serialized with that store operation. The adapter did not override the caller's signal.
- 401/unauthenticated invalidates that auth generation and blocks automatic request replays. 403, 429 and local timeouts are not remembered as token expiry. An explicit re-login starts a new generation, and late auth failures of old requests do not apply to it.

A successful login means a successful code exchange and store. CLI permission, quota, inference success and the server token lifetime are separate results. Status rechecks are server requests too, so they are not claimed to be free or unlimited.

## Storage and verification boundaries

- The CLI keeps version 1 credentials in `DEVIN_POC_STATE_DIR` or the existing `~/.local/share/devin-protocol-poc`.
- The host stores and deletes Pi credentials. There is no automatic import or sync between the two stores.
- `ModelAuth.apiKey` is the general field through which Pi passes the request auth value. Using it, the user login and the stored auth type are still `oauth`, and no API key input UI is registered.
- CLI subprocess checks use only a temporary HOME, a separate state directory, a loopback service and `--no-browser`. They confirm that a fake Pi file remains after CLI logout.
- CLI credentials, the real Pi auth file, browser cookies, Desktop SecretStorage and token environment variables were not read. Real browser launches, account requests, inferences and publishes: 0.

## OAuth-only boundary (follow-up 01)

Authentication uses only the OAuth code exchanges in the table above. The **API key** option in the public plugin README (pasting a `cog_...` service key or session token) is not used as evidence and is not implemented. `metadata.apiKey`, the `apiKey` in the `ExchangePKCEAuthorizationCode` response and Pi's `ModelAuth.apiKey` are field names that carry the OAuth session token.

The Pi 1.3.0 host's resolution paths and the provider's behavior are as follows. `tests/pi-auth-storage.test.ts` confirms 0 Devin requests for each path through the public `ModelRuntime`.

| Input | Host resolution | Result |
|---|---|---|
| Only `pi --api-key` (runtime key), an `api_key` entry in `auth.json`, or `DEVIN_API_KEY`/`WINDSURF_API_KEY` | Not resolved, because the provider has no `auth.apiKey` | `Provider is not configured`, 0 requests |
| `providers.devin.apiKey` in `models.json` | The host synthesizes an API key method. Without OAuth, the Devin models are empty | `No API provider registered for api: devin-connect`, 0 requests |
| Stored OAuth, with the caller overriding it with another `apiKey` | Pi passes the caller's value first | The provider rejects with an OAuth-only error before model selection and sending, 0 requests |
| Stored OAuth (even with another `models.json` apiKey) | The stored credential wins and `toAuth` returns the session | Normal request. `metadata.apiKey` is the OAuth session |

- The provider remembers only hashes of session tokens learned in this process through OAuth login, refresh, `toAuth` or host OAuth credentials (model refresh). Raw tokens are not kept.
- The rejection is a plain error. It is not turned into auth invalidation or cancellation of a running run, and the key value is stripped from the error.
- The CLI rejects `--api-key` as an unknown option and does not read API key environment variables. It uses only credentials stored by its own login.
- Tokens are not rejected by key prefix. The result of a `wspkce$` exchange is also an OAuth session and can look like an API key. Instead, manual input does not accept token or key formats as authorization codes.
- Limit: a user editing the OAuth entry of Pi's `auth.json` or the CLI credential file by hand to put in another value is not a supported path, and its origin cannot be told apart without the server.
