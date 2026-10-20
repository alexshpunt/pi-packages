import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";
import { object, type JsonObject } from "../types.ts";

export const CHAT_METHOD = "exa.api_server_pb.ApiServerService/GetChatMessage";

export interface MessageCodec {
  encode(value: JsonObject): Uint8Array;
  decode(bytes: Uint8Array): JsonObject;
}

let root: protobuf.Root | undefined;
const camelCase = (name: string) => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

const PROTO_ROOT = fileURLToPath(new URL("../../../proto/", import.meta.url));

function protoSources(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) protoSources(path, out);
    else if (entry.endsWith(".proto")) out.push(path);
  }
  return out;
}

function getRoot(): protobuf.Root {
  if (!root) {
    // The schema is the shipped `proto/` source tree, parsed directly. The four definitions this
    // package added from its own protocol analysis are marked in the sources, so nothing is
    // patched in at runtime. keepCase keeps the declared snake_case names the DTO boundary uses.
    root = new protobuf.Root();
    root.resolvePath = (_origin: string, target: string) => isAbsolute(target) ? target : join(PROTO_ROOT, target);
    root.loadSync(protoSources(PROTO_ROOT), { keepCase: true });
    root.resolveAll();
  }
  return root;
}

/** Converts between camelCase DTOs and the original snake_case at the boundary; user keys inside maps stay unchanged. */
function convertFields(type: protobuf.Type, value: JsonObject, isEncoding: boolean, path: string): JsonObject {
  const result: [string, unknown][] = [];
  for (const [name, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null) continue;
    const field = isEncoding ? type.fieldsArray.find((candidate) => camelCase(candidate.name) === name)
      : Object.hasOwn(type.fields, name) ? type.fields[name] : undefined;
    if (!field) throw new Error(`Field not in the protobuf schema: ${path}.${name}`);
    const convert = (item: unknown): unknown => {
      if (field.resolvedType instanceof protobuf.Type) {
        return convertFields(field.resolvedType, object(item, `${path}.${name}`), isEncoding, `${path}.${name}`);
      }
      // Prevents fromObject from silently turning an invalid enum into 0.
      if (isEncoding && field.resolvedType instanceof protobuf.Enum) {
        const isValid = typeof item === "string" ? Object.hasOwn(field.resolvedType.values, item)
          : typeof item === "number" && Object.hasOwn(field.resolvedType.valuesById, item);
        if (!isValid) throw new Error(`Unknown protobuf enum: ${path}.${name}`);
      }
      return item;
    };
    let converted: unknown;
    if (field.map) converted = Object.fromEntries(Object.entries(object(entry, `${path}.${name}`)).map(([key, item]) => [key, convert(item)]));
    else if (field.repeated) {
      if (!Array.isArray(entry)) throw new Error(`Field requires an array: ${path}.${name}`);
      converted = entry.map(convert);
    } else converted = convert(entry);
    result.push([isEncoding ? field.name : camelCase(field.name), converted]);
  }
  return Object.fromEntries(result);
}

function messageCodec(typeName: string): MessageCodec {
  const getType = () => getRoot().lookupType(typeName);
  return {
    encode(value) {
      const type = getType();
      const message = type.fromObject(convertFields(type, value, true, typeName));
      const error = type.verify(message);
      if (error) throw new Error(`Invalid protobuf input: ${error}`);
      return type.encode(message).finish();
    },
    decode(bytes) {
      const type = getType();
      try {
        const decoded = object(type.toObject(type.decode(bytes), {
          longs: String, enums: String, bytes: String, defaults: false,
        }), typeName);
        return convertFields(type, decoded, false, typeName);
      } catch {
        throw new Error(`Invalid protobuf response: ${typeName}`);
      }
    },
  };
}

export function unaryCodecs(method: string): { request: MessageCodec; response: MessageCodec } {
  const split = method.lastIndexOf("/");
  if (split <= 0) throw new Error("A valid RPC path is required.");
  const service = getRoot().lookupService(method.slice(0, split));
  const definition = service.methods[method.slice(split + 1)];
  definition?.resolve();
  if (!definition?.resolvedRequestType || !definition.resolvedResponseType || definition.responseStream || definition.requestStream) {
    throw new Error(`Unsupported unary RPC: ${method}`);
  }
  return {
    request: messageCodec(definition.resolvedRequestType.fullName),
    response: messageCodec(definition.resolvedResponseType.fullName),
  };
}

export const chatRequestCodec = messageCodec("exa.api_server_pb.GetChatMessageRequest");
export const chatResponseCodec = messageCodec("exa.api_server_pb.GetChatMessageResponse");
