import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const read = fs.readFileSync;
const exists = fs.existsSync;
function rejectCredentialPath(path: unknown): void {
  if (String(path).endsWith("auth.json")) {
    process.exitCode = 84;
    throw new Error("Import must not inspect credentials.");
  }
}
fs.readFileSync = ((...args: Parameters<typeof read>) => {
  rejectCredentialPath(args[0]);
  return read(...args);
}) as typeof read;
fs.existsSync = (path) => {
  rejectCredentialPath(path);
  return exists(path);
};
syncBuiltinESMExports();
globalThis.fetch = async () => {
  process.exitCode = 83;
  throw new Error("Import must not request the network.");
};
