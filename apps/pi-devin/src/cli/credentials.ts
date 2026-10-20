import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { endpoint } from "../core/protocol/transport.ts";
import { object, requiredString, type Credential } from "../core/types.ts";

export function credentialPath(): string {
  const directory = process.env.DEVIN_POC_STATE_DIR ?? join(homedir(), ".local", "share", "devin-protocol-poc");
  return join(directory, "credentials.json");
}

export async function saveCredential(credential: Credential, file = credentialPath()): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await chmod(dirname(file), 0o700);
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(credential, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readCredential(file = credentialPath()): Promise<Credential> {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("No PoC credential found. Run login.");
    throw error;
  }
  let value: ReturnType<typeof object>;
  try { value = object(JSON.parse(text), "credential"); }
  catch { throw new Error("Invalid PoC credential file format."); }
  if (value.version !== 1) throw new Error("Unsupported credential version.");
  const fingerprint = typeof value.fingerprint === "string" ? value.fingerprint : undefined;
  return {
    version: 1,
    sessionToken: requiredString(value.sessionToken, "sessionToken"),
    apiServerURL: endpoint(requiredString(value.apiServerURL, "apiServerURL")),
    ...(fingerprint !== undefined ? { fingerprint } : {}),
    createdAt: requiredString(value.createdAt, "createdAt"),
  };
}
