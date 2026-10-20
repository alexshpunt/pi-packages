import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  accountsFilePath,
  createAccountCredentialStore,
  validateAccountIdFormat,
} from "../src/accounts/credentials.ts";

let directory: string;
let path: string;
const originalEnv = process.env.OLLAMA_FIXTURE_ACCOUNT_KEY;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ollama-accounts-"));
  path = join(directory, "agent", "ollama-cloud-accounts.json");
  process.env.OLLAMA_FIXTURE_ACCOUNT_KEY = "env-secret";
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  if (originalEnv === undefined) delete process.env.OLLAMA_FIXTURE_ACCOUNT_KEY;
  else process.env.OLLAMA_FIXTURE_ACCOUNT_KEY = originalEnv;
});

describe("validateAccountIdFormat", () => {
  it("accepts short lowercase IDs and rejects reserved or malformed ones", () => {
    expect(validateAccountIdFormat("work")).toBeUndefined();
    expect(validateAccountIdFormat("team_2-b")).toBeUndefined();
    expect(validateAccountIdFormat("default")).toMatch(/reserved/);
    expect(validateAccountIdFormat("ollama-cloud")).toMatch(/reserved/);
    for (const id of ["", "Work", "-x", "a".repeat(33), "has space", "__proto__"]) {
      expect(validateAccountIdFormat(id)).toBeDefined();
    }
  });
});

describe("account credential store", () => {
  it("defaults to Pi's agent directory", () => {
    expect(accountsFilePath(directory)).toBe(join(directory, "ollama-cloud-accounts.json"));
  });

  it("does not create the file for reads when no account was added", async () => {
    const store = createAccountCredentialStore(path);
    expect(await store.list()).toEqual([]);
    expect(await store.resolve()).toEqual([]);
    expect(await store.remove("work")).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it("stores literals and references in auth.json format with mode 0600 and resolves them like Pi", async () => {
    const store = createAccountCredentialStore(path);
    await store.add("work", "literal-key");
    await store.add("env", "$OLLAMA_FIXTURE_ACCOUNT_KEY");
    await store.add("cmd", "!printf command-secret");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      work: { type: "api_key", key: "literal-key" },
      env: { type: "api_key", key: "$OLLAMA_FIXTURE_ACCOUNT_KEY" },
      cmd: { type: "api_key", key: "!printf command-secret" },
    });
    expect(await store.list()).toEqual(["work", "env", "cmd"]);
    expect(await store.resolve()).toEqual([
      { id: "work", apiKey: "literal-key" },
      { id: "env", apiKey: "env-secret" },
      { id: "cmd", apiKey: "command-secret" },
    ]);
    expect(await store.remove("env")).toBe(true);
    expect(await store.list()).toEqual(["work", "cmd"]);
  });

  it("rejects duplicate, invalid, empty, and built-in provider IDs on add", async () => {
    const store = createAccountCredentialStore(path);
    await store.add("work", "key");
    await expect(store.add("work", "other")).rejects.toThrow(/already exists/);
    await expect(store.add("Work", "key")).rejects.toThrow(/lowercase/);
    await expect(store.add("default", "key")).rejects.toThrow(/reserved/);
    await expect(store.add("blank", "   ")).rejects.toThrow(/required/);
    await expect(store.add("anthropic", "key")).rejects.toThrow(/built-in Pi provider/);
  });

  it("reports unusable entries without exposing keys or configured commands", async () => {
    const store = createAccountCredentialStore(path);
    await store.add("ok", "fine-key");
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    raw.anthropic = { type: "api_key", key: "colliding-secret" };
    raw.missing = { type: "api_key", key: "$OLLAMA_FIXTURE_UNSET_VARIABLE" };
    raw.failing = { type: "api_key", key: "!exit 3 # secret-command" };
    raw.BadId = { type: "api_key", key: "bad-id-secret" };
    writeFileSync(path, JSON.stringify(raw), { mode: 0o600 });
    const resolved = await store.resolve();
    expect(resolved.find((entry) => entry.id === "ok")).toEqual({ id: "ok", apiKey: "fine-key" });
    for (const id of ["anthropic", "missing", "failing", "BadId"]) {
      const entry = resolved.find((item) => item.id === id);
      expect(entry?.apiKey).toBeUndefined();
      expect(entry?.error).toBeDefined();
    }
    const serialized = JSON.stringify(resolved);
    for (const secret of ["colliding-secret", "secret-command", "bad-id-secret", "OLLAMA_FIXTURE_UNSET_VARIABLE"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("reports a corrupt or invalid file by location only and never overwrites it", async () => {
    const store = createAccountCredentialStore(path);
    await store.add("ok", "fine-key");
    const corrupt = '{"work": {"type": "api_key", "key": "leaked-secret';
    writeFileSync(path, corrupt, { mode: 0o600 });
    for (const operation of [() => store.resolve(), () => store.list(), () => store.add("new", "other-secret")]) {
      const failure = await operation().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(path);
      expect((failure as Error).message).not.toContain("leaked-secret");
    }
    expect(readFileSync(path, "utf8")).toBe(corrupt);
    writeFileSync(path, JSON.stringify({ work: { type: "api_key", key: 42 } }), { mode: 0o600 });
    await expect(store.resolve()).rejects.toThrow(/Account "work" .* is not a valid auth\.json credential entry/);
  });
});
