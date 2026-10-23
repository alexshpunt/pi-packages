import { Effect, Predicate } from "effect";
import { DevinError } from "./errors.ts";
import type { JsonObject } from "./types.ts";

export function object(value: unknown, label: string): Effect.Effect<JsonObject, DevinError> {
  return Predicate.isObject(value) ? Effect.succeed(value as JsonObject)
    : Effect.fail(new DevinError({ message: `${label}: a JSON object is required.` }));
}

export function requiredString(value: unknown, label: string): Effect.Effect<string, DevinError> {
  return Predicate.isString(value) && value.length > 0 ? Effect.succeed(value)
    : Effect.fail(new DevinError({ message: `${label}: a non-empty string is required.` }));
}

export function tokenCount(value: unknown, label: string): Effect.Effect<number, DevinError> {
  const isCountLike = Predicate.isNumber(value) || (Predicate.isString(value) && /^\d+$/.test(value));
  const count = Number(value);
  return isCountLike && Number.isSafeInteger(count) && count >= 0 ? Effect.succeed(count)
    : Effect.fail(new DevinError({ message: `${label}: invalid token count.` }));
}

/** Fails with a message-only error. */
export function failWith(message: string): Effect.Effect<never, DevinError> {
  return Effect.fail(new DevinError({ message }));
}
