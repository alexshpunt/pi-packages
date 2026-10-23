# 07 live check procedure

This directory keeps the 07 plan to approve and the de-identified records. Credentials are never written here. Real login, lookups and inference run only after user approval that names the plan hash.

| File | Content |
|---|---|
| `plan.json` | The plan to approve and its `planHash`. Output of `live-check.mjs plan` |
| `dry-run.json` | Results of running the same plan against the mock service, plus the negative controls |
| `run.json` | Live results after approval (created only when run) |

## Plan summary

- **Input artifact**: the 06 re-run archive (`de8db88b…`, runtime digest `b13f1afa…`, `handoffs/06-artifact-r2.json`). Check the hashes again before running. The 2026-10-19 run is a record of the first archive (`6e01f924…`).
- **Authentication**: the user does a fresh Devin OAuth login with `/login` in the Pi TUI of the temporary state. API key environment variables are not passed to child processes.
- **Models**: only `swe-2-medium` and `swe-2-high` are allowed. Right before sending, the final `chatModelUid` of a chat request is decoded and checked, Fusion sidekick requests included. Anything outside the allowlist is not sent.
- **Free tier**: the catalog response must show both UIDs as active and `MODEL_COST_TIER_FREE`; otherwise all later model requests stop. The free judgment rests on the user's statement and the catalog at run time, and the cost-unknown label stays.
- **Cap**: 8 physical model HTTP requests in total, enforced across Pi processes through a ledger.
- **Hosts**: only `server.codeium.com` and `api.devin.ai` are allowed. The user opens the browser.

## Commands

Run from `apps/pi-devin/`.

```bash
state="$(mktemp -d /private/tmp/pi-devin-live.XXXXXX)"
archive=verification/followup/artifacts/buyong-pi-devin-0.1.0-de8db88b783f.tgz
node verification/scripts/live/live-check.mjs prepare --archive "$archive" --state "$state"
node verification/scripts/live/live-check.mjs login --state "$state"   # by the user: /login → Devin → browser → /quit
node verification/scripts/live/live-check.mjs run --state "$state" --authorization <approval record> --report verification/followup/live/run.json
node verification/scripts/live/live-check.mjs cleanup --state "$state"
```

The `login` session has a model request cap of 0, so it cannot send inference. `run` does not start if the approval record's `planHash` differs from the current plan. If any case fails, the remaining cases are not run. `cleanup` deletes only the temporary state holding the newly issued credentials. It does not revoke the session on the server.

## 08: live check after the Effect Layer redesign

The 08 plan runs the six 07 cases plus one long RPC session against the archive of the redesign (`89b92e7c…`, runtime digest `086c67ea…`, `pin-08.json`). The session sends 45 prompts in one Pi session: add tool calls, medium/high thinking level changes, a cancelled response, and a Pi restart that resumes the same session file, with code word recalls across them, then the `/devin` report. Together with the five single-prompt cases that makes 50 prompts. The cap is 80 model requests, on `swe-2-medium`/`swe-2-high` only, free tier required.

| File | Content |
|---|---|
| `pin-08.json` | Archive hash and runtime digest the plan is pinned to. Output of `live-check.mjs pin` |
| `plan-08.json` | The 08 plan and its `planHash` |
| `dry-run-08.json` | The same plan against the mock service, plus the negative controls |
| `authorization-08.json` | The approval the run used |
| `run-08.json` | Live results |

```bash
node verification/scripts/live/live-check.mjs pin --archive "$archive" > pin.json
node verification/scripts/live/live-check.mjs dry-run --plan 08 --pin pin.json --archive "$archive" --report dry-run.json
node verification/scripts/live/live-check.mjs prepare --plan 08 --pin pin.json --archive "$archive" --state "$state"
node verification/scripts/live/live-check.mjs login --plan 08 --pin pin.json --state "$state"
node verification/scripts/live/live-check.mjs run --plan 08 --pin pin.json --state "$state" --authorization <approval record> --report run.json
node verification/scripts/live/live-check.mjs cleanup --plan 08 --pin pin.json --state "$state"
```

Since the Effect migration the codec returns Effect values, so `live-guard.mjs` runs them with the effect copy the codec loads. Without `--plan`, the 07 plan pinned to the 06 archive is used unchanged.
