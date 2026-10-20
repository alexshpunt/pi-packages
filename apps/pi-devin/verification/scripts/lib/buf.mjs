// Source-only helper: builds descriptors with the buf CLI pinned in the app devDependencies and decodes them losslessly.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export function bufBinary() {
  return createRequire(join(APP_ROOT, "package.json")).resolve("@bufbuild/buf/bin/buf");
}

/** The buf cache is written only to the temp path given by the caller. Inputs are local only, so there is no network dependency. */
export function runBuf(args, cacheDir) {
  return execFileSync(process.execPath, [bufBinary(), ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? "", HOME: cacheDir, BUF_CACHE_DIR: join(cacheDir, "buf-cache"), NO_COLOR: "1" },
  });
}

export function bufVersion(cacheDir) {
  return runBuf(["--version"], cacheDir).trim();
}

/**
 * Uses descriptor.proto and the buf/validate extensions included in the original descriptor set as the schema.
 * The protobufjs 7.6.6 descriptor schema drops custom options and editions fields, so it is not used as the reference decoder.
 */
export function descriptorSetJSON(schemaPath, inputPath, outputPath, cacheDir) {
  runBuf(["convert", `${schemaPath}#format=binpb`, "--type", "google.protobuf.FileDescriptorSet", "--from", `${inputPath}#format=binpb`, "--to", outputPath], cacheDir);
  return JSON.parse(readFileSync(outputPath, "utf8"));
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
