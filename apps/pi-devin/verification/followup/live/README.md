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
