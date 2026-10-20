/**
 * pi types tool parameter schemas with TypeBox's `TSchema`. The bridge passes the runtime's JSON
 * schemas through verbatim, so only the type is needed; this indirection keeps the import in one place.
 */
export type { TSchema } from "@sinclair/typebox";
