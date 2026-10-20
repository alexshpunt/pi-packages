export const HELP = `Devin protocol CLI PoC (no dependency on Pi or the Devin CLI)

Usage: node cli.ts <command> [options]

  login               Account selection and browser PKCE login (REST code exchange)
  status              Account and quota status, without name or email
  models              Current model list (select with --model UID/alias)
  chat                Streaming chat with images, sessions and a controlled tool loop
  tool-roundtrip      add(17,25) check (at most 2 model HTTP requests)
  verify-live         1 text check + 2 tool round-trip checks
  logout              Deletes only this PoC's local token (does not revoke the server token)

Options:
  --model UID         Default swe-2-medium. Aliases and routers are supported
  --expect-user-id ID Confirms the account for status/chat/verify-live
  --allow-model-calls  Allows quota use for inference, routing and title generation
  --max-tokens N      chat default: the selected model's maximum. Check commands use 128/512
  --max-model-calls N Model HTTP request limit for chat (default 8, max 100)
  --timeout-ms N      RPC default 90000, login default 300000
  --prompt TEXT       chat input
  --prompt-file PATH  UTF-8 input file
  --image PATH        Repeatable. 4 MiB each, 5 MiB total
  --resume ID         Continue a saved PoC session (same account only)
  --enable-add-tool   Enables only a tool that adds two finite numbers
  --no-title          Skips the auxiliary title generation request
  --no-analytics      Does not send session/message/tool analytics events
  --rest-server URL   Sets the REST server for chat explicitly
  --output PATH       Saves the result JSON. verify-live default results/live.json
  --json              Prints text deltas as JSON Lines
  --api-server-url URL login RPC server (default https://server.codeium.com)
  --webapp-url URL     login web app (default https://app.devin.ai)
  --login-api-url URL  REST code exchange server (default https://api.devin.ai)
  --force-manual-token-flow manual code flow (Connect exchange, not an API key prompt)
  --no-browser        Shows the URL without opening a browser
  --login-encoding MODE Selects the legacy Connect flow when set: proto or json

Storage: ~/.local/share/devin-protocol-poc (change with DEVIN_POC_STATE_DIR)
Existing Devin CLI credentials and token environment variables are never read.
A compressed inference request is resent once uncompressed on HTTP 408/415/500/502/503/504; that attempt counts toward the request limit.
`;
