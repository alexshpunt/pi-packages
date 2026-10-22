import { Effect } from "effect";
import { toDevinError, type DevinError } from "../errors.ts";
import { failWith } from "../validation.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

/** The origin of an HTTPS endpoint, or of loopback HTTP for local verification, without credentials or a path. */
export function endpoint(value: string): Effect.Effect<string, DevinError> {
  return Effect.try({ try: () => new URL(value), catch: toDevinError }).pipe(Effect.flatMap((url) => {
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
      return failWith("The endpoint must be HTTPS, or loopback HTTP for local verification.");
    }
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      return failWith("The endpoint must not contain credentials, a path, a query, or a fragment.");
    }
    return Effect.succeed(url.origin);
  }));
}
