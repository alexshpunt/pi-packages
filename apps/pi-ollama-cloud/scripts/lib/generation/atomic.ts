import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface GenerationWriter {
  write(path: string, source: string): void;
  replace(temporary: string, target: string): void;
}
const writer: GenerationWriter = {
  write: (path, source) => writeFileSync(path, source, { flag: "wx", mode: 0o644 }),
  replace: renameSync,
};
/** Exactly one data artifact is replaced. Fixed root facades are not rewritten by generation. */
export function replaceGeneratedFile(
  path: string,
  source: string,
  signal?: AbortSignal,
  io: GenerationWriter = writer,
): void {
  signal?.throwIfAborted();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    io.write(temporary, source);
    signal?.throwIfAborted();
    io.replace(temporary, path);
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* A leftover temporary file never replaces the committed snapshot. */
    }
  }
}
