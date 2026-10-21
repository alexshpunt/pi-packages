import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Synthetic credentials: each matches a built-in rule and appears nowhere else. */
export const SECRETS = Object.freeze({
  envApiKey: "sk-fixtureapikey0123456789",
  envPassword: "fixture-db-pass",
  shortPassword: "ab",
  sourceToken: "ghp_fixturesourcetoken0123456789",
  userToken: "ghp_fixtureusertoken01234567890",
  agentsKey: "AKIAFIXTUREAGENTS123",
  injected: "sk-fixtureinjected0123456789",
});

export const ENV_FILE = [
  `API_KEY=${SECRETS.envApiKey}`,
  `DB_PASSWORD=${SECRETS.envPassword}`,
  `SHORT_PASSWORD=${SECRETS.shortPassword}`,
  "PORT=8080",
  "",
].join("\n");

/** A temporary directory with the given relative files; removed when the test finishes. */
export function temporaryTree(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-redact-test-"));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

/** Secrets long enough to search for; `shortPassword` is checked by exact lines instead. */
const SEARCHABLE_SECRETS = Object.entries(SECRETS)
  .filter(([name]) => name !== "shortPassword")
  .map(([, value]) => value);

/** Raw secrets found in a serialized value. */
export function leakedSecrets(value, secrets = SEARCHABLE_SECRETS) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return secrets.filter((secret) => text.includes(secret));
}
