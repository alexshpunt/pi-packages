import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import protobuf from "protobufjs";
import { DevinError, toDevinError } from "../errors.ts";
import type { JsonObject } from "../types.ts";
import { failWith, object } from "../validation.ts";

export const CHAT_METHOD = "exa.api_server_pb.ApiServerService/GetChatMessage";

export interface MessageCodec {
  encode(value: JsonObject): Effect.Effect<Uint8Array, DevinError>;
  decode(bytes: Uint8Array): Effect.Effect<JsonObject, DevinError>;
}

const PROTO_ROOT = fileURLToPath(new URL("../../../proto/", import.meta.url));
const camelCase = (name: string) => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

function protoSources(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) protoSources(path, out);
    else if (entry.endsWith(".proto")) out.push(path);
  }
  return out;
}

let loadedRoot: protobuf.Root | undefined;

/**
 * The schema is the shipped `proto/` source tree, parsed once per process. The four definitions this
 * package added from its own protocol analysis are marked in the sources, so nothing is patched in at
 * runtime. keepCase keeps the declared snake_case names the DTO boundary uses.
 */
const schemaRoot: Effect.Effect<protobuf.Root, DevinError> = Effect.suspend(() => loadedRoot ? Effect.succeed(loadedRoot) : Effect.try({
  try: () => {
    const root = new protobuf.Root();
    root.resolvePath = (_origin: string, target: string) => isAbsolute(target) ? target : join(PROTO_ROOT, target);
    root.loadSync(protoSources(PROTO_ROOT), { keepCase: true });
    root.resolveAll();
    loadedRoot = root;
    return root;
  },
  catch: toDevinError,
}));

/** Converts between camelCase DTOs and the original snake_case at the boundary; user keys inside maps stay unchanged. */
function convertFields(type: protobuf.Type, value: JsonObject, isEncoding: boolean, path: string): Effect.Effect<JsonObject, DevinError> {
  return Effect.gen(function* () {
    const result: [string, unknown][] = [];
    for (const [name, entry] of Object.entries(value)) {
      if (entry === undefined || entry === null) continue;
      const field = isEncoding ? type.fieldsArray.find((candidate) => camelCase(candidate.name) === name)
        : Object.hasOwn(type.fields, name) ? type.fields[name] : undefined;
      if (!field) return yield* failWith(`Field not in the protobuf schema: ${path}.${name}`);
      const label = `${path}.${name}`;
      const convert = (item: unknown): Effect.Effect<unknown, DevinError> => {
        if (field.resolvedType instanceof protobuf.Type) {
          const nested = field.resolvedType;
          return object(item, label).pipe(Effect.flatMap((fields) => convertFields(nested, fields, isEncoding, label)));
        }
        // Prevents fromObject from silently turning an invalid enum into 0.
        if (isEncoding && field.resolvedType instanceof protobuf.Enum) {
          const values = field.resolvedType;
          const isValid = typeof item === "string" ? Object.hasOwn(values.values, item)
            : typeof item === "number" && Object.hasOwn(values.valuesById, item);
          if (!isValid) return failWith(`Unknown protobuf enum: ${label}`);
        }
        return Effect.succeed(item);
      };
      let converted: unknown;
      if (field.map) {
        const entries = Object.entries(yield* object(entry, label));
        converted = Object.fromEntries(yield* Effect.forEach(entries, ([key, item]) => Effect.map(convert(item), (mapped) => [key, mapped] as const)));
      } else if (field.repeated) {
        if (!Array.isArray(entry)) return yield* failWith(`Field requires an array: ${label}`);
        converted = yield* Effect.forEach(entry, convert);
      } else converted = yield* convert(entry);
      result.push([isEncoding ? field.name : camelCase(field.name), converted]);
    }
    return Object.fromEntries(result);
  });
}

function messageCodec(typeName: string): MessageCodec {
  const messageType = Effect.flatMap(schemaRoot, (root) => Effect.try({ try: () => root.lookupType(typeName), catch: toDevinError }));
  return {
    encode: (value) => Effect.gen(function* () {
      const type = yield* messageType;
      const fields = yield* convertFields(type, value, true, typeName);
      const message = yield* Effect.try({ try: () => type.fromObject(fields), catch: toDevinError });
      const error = type.verify(message);
      if (error) return yield* failWith(`Invalid protobuf input: ${error}`);
      return yield* Effect.try({ try: () => type.encode(message).finish(), catch: toDevinError });
    }),
    decode: (bytes) => Effect.flatMap(messageType, (type) => Effect.gen(function* () {
      const decoded = yield* Effect.try({
        try: () => type.toObject(type.decode(bytes), { longs: String, enums: String, bytes: String, defaults: false }),
        catch: toDevinError,
      });
      return yield* convertFields(type, yield* object(decoded, typeName), false, typeName);
    }).pipe(Effect.mapError(() => new DevinError({ message: `Invalid protobuf response: ${typeName}` })))),
  };
}

export function unaryCodecs(method: string): Effect.Effect<{ request: MessageCodec; response: MessageCodec }, DevinError> {
  return Effect.gen(function* () {
    const split = method.lastIndexOf("/");
    if (split <= 0) return yield* failWith("A valid RPC path is required.");
    const root = yield* schemaRoot;
    const definition = yield* Effect.try({
      try: () => {
        const found = root.lookupService(method.slice(0, split)).methods[method.slice(split + 1)];
        found?.resolve();
        return found;
      },
      catch: toDevinError,
    });
    if (!definition?.resolvedRequestType || !definition.resolvedResponseType || definition.responseStream || definition.requestStream) {
      return yield* failWith(`Unsupported unary RPC: ${method}`);
    }
    return {
      request: messageCodec(definition.resolvedRequestType.fullName),
      response: messageCodec(definition.resolvedResponseType.fullName),
    };
  });
}

export const chatRequestCodec = messageCodec("exa.api_server_pb.GetChatMessageRequest");
export const chatResponseCodec = messageCodec("exa.api_server_pb.GetChatMessageResponse");
