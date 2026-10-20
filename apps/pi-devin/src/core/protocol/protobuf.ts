import { readFileSync } from "node:fs";
import protobuf from "protobufjs";
import "protobufjs/ext/descriptor/index.js";
import { object, type JsonObject } from "../types.ts";

export const CHAT_METHOD = "exa.api_server_pb.ApiServerService/GetChatMessage";

export interface MessageCodec {
  encode(value: JsonObject): Uint8Array;
  decode(bytes: Uint8Array): JsonObject;
}

let root: protobuf.Root | undefined;
const camelCase = (name: string) => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

function getRoot(): protobuf.Root {
  if (!root) {
    const bytes = readFileSync(new URL("../../../resources/descriptors.pb", import.meta.url));
    // The descriptor extension's runtime API exists, but the Root type declarations do not include it.
    const factory = protobuf.Root as typeof protobuf.Root & {
      fromDescriptor(value: Uint8Array): protobuf.Root;
    };
    // Descriptor built from `proto/` with buf. The four definitions added by this package's protocol analysis are part of the source.
    // Names, reserved words and field numbers are used exactly as in the descriptor.
    root = factory.fromDescriptor(bytes);
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
    const entryType = field.resolvedType instanceof protobuf.Type ? field.resolvedType : undefined;
    // fromDescriptor restores maps as repeated key/value messages, not MapField.
    const isDescriptorMap = field.repeated && entryType?.getOption("map_entry") === true
      && entryType.fieldsArray.length === 2 && entryType.fields.key?.id === 1 && entryType.fields.value?.id === 2;
    if (isDescriptorMap) {
      if (isEncoding) {
        converted = Object.entries(object(entry, `${path}.${name}`)).map(([key, value]) => convert({
          key: entryType.fields.key.type === "bool" ? key === "true" : key, value,
        }));
      } else {
        if (!Array.isArray(entry)) throw new Error(`Map field requires an array: ${path}.${name}`);
        converted = Object.fromEntries(entry.map((pair) => {
          const item = object(convert(pair), `${path}.${name}`);
          return [String(item.key ?? entryType.fields.key.defaultValue), item.value ?? entryType.fields.value.defaultValue];
        }));
      }
    } else if (field.map) converted = Object.fromEntries(Object.entries(object(entry, `${path}.${name}`)).map(([key, item]) => [key, convert(item)]));
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
