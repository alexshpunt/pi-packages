import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { decodeCacheData } from "./data.ts";
import type { CacheData, CacheDiagnostics } from "./types.ts";

function fileRevision(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}
export function getCacheFileRevision(path: string): string | undefined {
  try {
    return fileRevision(statSync(path));
  } catch {
    return undefined;
  }
}
export function readCacheFile(
  path: string,
  maxBytes: number,
): { data: CacheData; state: CacheDiagnostics["lastRead"]; revision?: string } {
  let descriptor: number | undefined;
  let revision: string | undefined;
  const empty = () => ({ searches: {}, pages: {} });
  try {
    descriptor = openSync(path, "r");
    const stat = fstatSync(descriptor);
    revision = fileRevision(stat);
    if (!stat.isFile()) return { data: empty(), state: "unreadable", revision };
    if (stat.size > maxBytes) return { data: empty(), state: "oversized", revision };
    // A concurrent append cannot cause an unbounded read after the size check.
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length > stat.size) return { data: empty(), state: "unreadable", revision };
    const data = decodeCacheData(JSON.parse(buffer.toString("utf8", 0, length)));
    return { data: data ?? empty(), state: data ? "ok" : "invalid", revision };
  } catch (error) {
    const isMissing = error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
    return {
      data: empty(),
      state: isMissing ? "missing" : error instanceof SyntaxError ? "invalid" : "unreadable",
      revision,
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
export function writeCacheFile(path: string, data: CacheData): boolean {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    return true;
  } catch {
    return false;
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* Cache cleanup is best effort. */
    }
  }
}
