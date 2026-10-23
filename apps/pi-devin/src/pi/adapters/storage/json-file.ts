import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Effect, Option, Schema } from "effect";
import { toDevinError, type DevinError } from "../../../core/errors.ts";

/*
 * Pi reads these small global files from synchronous callbacks, such as TUI rendering and model list rebuilds,
 * and other Pi processes may change them at any time. They are therefore read fresh and synchronously on each use;
 * Effect's FileSystem service is asynchronous only.
 */

/** The file's value when it exists, parses and matches the schema. A missing or malformed file is never repaired by reading. */
export function readJsonFile<S extends Schema.ConstraintDecoder<unknown>>(path: string, schema: S): Effect.Effect<Option.Option<S["Type"]>> {
  const decode = Schema.decodeUnknownOption(schema);
  return Effect.sync(() => {
    try { return decode(JSON.parse(readFileSync(path, "utf8"))); } catch { return Option.none(); }
  });
}

/** Replaces the file atomically within its directory. */
export function writeJsonFile(path: string, value: unknown): Effect.Effect<void, DevinError> {
  return Effect.try({
    try: () => {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
      renameSync(temporary, path);
    },
    catch: toDevinError,
  });
}
