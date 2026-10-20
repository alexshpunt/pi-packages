#!/usr/bin/env node
// Source-only bootstrap: writes the original FileDescriptorSet as a readable .proto tree.
// The output holds only the original declarations. Observed additions are maintained directly in the proto/ sources and recorded in proto-provenance.json.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { APP_ROOT, descriptorSetJSON, sha256 } from "./lib/buf.mjs";

const SCALARS = {
  TYPE_DOUBLE: "double", TYPE_FLOAT: "float", TYPE_INT64: "int64", TYPE_UINT64: "uint64", TYPE_INT32: "int32",
  TYPE_FIXED64: "fixed64", TYPE_FIXED32: "fixed32", TYPE_BOOL: "bool", TYPE_STRING: "string", TYPE_BYTES: "bytes",
  TYPE_UINT32: "uint32", TYPE_SFIXED32: "sfixed32", TYPE_SFIXED64: "sfixed64", TYPE_SINT32: "sint32", TYPE_SINT64: "sint64",
};
const MESSAGE_RANGE_MAX = 536870911; // The end of a DescriptorProto range is exclusive, so the stored value is 536870912.
const ENUM_RANGE_MAX = 2147483647; // The end of an EnumReservedRange is inclusive.
const OPTION_TYPES = {
  file: ".google.protobuf.FileOptions", message: ".google.protobuf.MessageOptions", field: ".google.protobuf.FieldOptions",
  oneof: ".google.protobuf.OneofOptions", enum: ".google.protobuf.EnumOptions", value: ".google.protobuf.EnumValueOptions",
  service: ".google.protobuf.ServiceOptions", method: ".google.protobuf.MethodOptions",
};

/** protoc's default json_name rule. */
export function defaultJSONName(name) {
  let result = "", isUpper = false;
  for (const character of name) {
    if (character === "_") { isUpper = true; continue; }
    result += isUpper ? character.toUpperCase() : character;
    isUpper = false;
  }
  return result;
}

function createSchema(set) {
  const messages = new Map(), extensions = new Map();
  const visit = (prefix, message) => {
    const name = `${prefix}.${message.name}`;
    messages.set(name, message);
    for (const nested of message.nestedType ?? []) visit(name, nested);
    for (const extension of message.extension ?? []) extensions.set(`${name}.${extension.name}`.slice(1), extension);
  };
  for (const file of set.file) {
    const prefix = file.package ? `.${file.package}` : "";
    for (const message of file.messageType ?? []) visit(prefix, message);
    for (const extension of file.extension ?? []) extensions.set(`${prefix}.${extension.name}`.slice(1), extension);
  }
  return { messages, extensions };
}

function unsupported(path, detail) {
  throw new Error(`Unsupported descriptor shape: ${path}: ${detail}`);
}

function quoteText(text) {
  const escapes = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t" };
  return `"${text.replace(/[\\"\n\r\t\u0000-\u001f\u007f]/g, (character) => escapes[character] ?? `\\${character.charCodeAt(0).toString(8).padStart(3, "0")}`)}"`;
}

function quoteBytes(bytes) {
  let result = '"';
  for (const byte of bytes) {
    if (byte === 0x5c) result += "\\\\";
    else if (byte === 0x22) result += '\\"';
    else if (byte >= 0x20 && byte < 0x7f) result += String.fromCharCode(byte);
    else result += `\\${byte.toString(8).padStart(3, "0")}`;
  }
  return `${result}"`;
}

function floatLiteral(value, path) {
  if (value === "NaN") return "nan";
  if (value === "Infinity") return "inf";
  if (value === "-Infinity") return "-inf";
  if (typeof value !== "number" || !Number.isFinite(value)) unsupported(path, `float ${JSON.stringify(value)}`);
  return String(value);
}

function scalarValue(field, value, path) {
  switch (field.type) {
    case "TYPE_STRING": return quoteText(value);
    case "TYPE_BYTES": return quoteBytes(Buffer.from(value, "base64"));
    case "TYPE_ENUM": return String(value);
    case "TYPE_BOOL": return value ? "true" : "false";
    case "TYPE_FLOAT": case "TYPE_DOUBLE": return floatLiteral(value, path);
    default:
      if (!SCALARS[field.type]) unsupported(path, field.type);
      if (!/^-?\d+$/.test(String(value))) unsupported(path, `integer ${JSON.stringify(value)}`);
      return String(value);
  }
}

function resolveOptionField(schema, typeName, key, path) {
  if (key.startsWith("[") && key.endsWith("]")) {
    const name = key.slice(1, -1);
    const extension = schema.extensions.get(name);
    if (!extension || extension.extendee !== typeName) unsupported(path, `extension ${key} of ${typeName}`);
    return { field: extension, label: name, isExtension: true };
  }
  const message = schema.messages.get(typeName) ?? unsupported(path, `message ${typeName}`);
  const field = (message.field ?? []).find((candidate) => (candidate.jsonName ?? defaultJSONName(candidate.name)) === key)
    ?? unsupported(path, `field ${key} of ${typeName}`);
  return { field, label: field.name, isExtension: false };
}

function isMapEntry(schema, field) {
  return field.type === "TYPE_MESSAGE" && schema.messages.get(field.typeName)?.options?.mapEntry === true;
}

/** Text-format aggregate value. Copies repeated, extension and nested values from the original JSON as is. */
function aggregate(schema, typeName, value, depth, path) {
  const lines = [], pad = "  ".repeat(depth + 1);
  for (const [key, item] of Object.entries(value)) {
    const { field, label, isExtension } = resolveOptionField(schema, typeName, key, `${path}.${key}`);
    if (isMapEntry(schema, field)) unsupported(`${path}.${key}`, "map option value");
    const name = isExtension ? `[${label}]` : label;
    const items = field.label === "LABEL_REPEATED" ? item : [item];
    if (!Array.isArray(items)) unsupported(`${path}.${key}`, "repeated value must be an array");
    for (const element of items) {
      lines.push(field.type === "TYPE_MESSAGE"
        ? `${pad}${name} ${aggregate(schema, field.typeName, element, depth + 1, `${path}.${key}`)}`
        : `${pad}${name}: ${scalarValue(field, element, `${path}.${key}`)}`);
    }
  }
  return lines.length === 0 ? "{}" : `{\n${lines.join("\n")}\n${"  ".repeat(depth)}}`;
}

/** The `name = value` list for an option statement or a field/value bracket. */
function optionAssignments(schema, kind, options, depth, path, skipped = []) {
  const typeName = OPTION_TYPES[kind];
  const assignments = [];
  for (const [key, value] of Object.entries(options ?? {})) {
    if (skipped.includes(key)) continue;
    const { field, label, isExtension } = resolveOptionField(schema, typeName, key, `${path}.${key}`);
    const name = isExtension ? `(${label})` : label;
    const items = field.label === "LABEL_REPEATED" ? value : [value];
    if (!Array.isArray(items)) unsupported(`${path}.${key}`, "repeated option must be an array");
    for (const element of items) {
      assignments.push(field.type === "TYPE_MESSAGE"
        ? `${name} = ${aggregate(schema, field.typeName, element, depth, `${path}.${key}`)}`
        : `${name} = ${scalarValue(field, element, `${path}.${key}`)}`);
    }
  }
  return assignments;
}

function optionStatements(schema, kind, options, depth, path, skipped) {
  const pad = "  ".repeat(depth);
  return optionAssignments(schema, kind, options, depth, path, skipped).map((assignment) => `${pad}option ${assignment};`);
}

function fieldType(field) {
  return SCALARS[field.type] ?? field.typeName ?? unsupported(field.name, field.type);
}

function defaultLiteral(field) {
  if (field.type === "TYPE_STRING") return quoteText(field.defaultValue);
  if (field.type === "TYPE_BYTES") return `"${field.defaultValue}"`; // The descriptor already stores bytes defaults with C escapes.
  return field.defaultValue;
}

function fieldBracket(schema, field, depth, path, isExtension) {
  const parts = [];
  if (field.defaultValue !== undefined) parts.push(`default = ${defaultLiteral(field)}`);
  if (!isExtension && field.jsonName !== undefined && field.jsonName !== defaultJSONName(field.name)) parts.push(`json_name = ${quoteText(field.jsonName)}`);
  parts.push(...optionAssignments(schema, "field", field.options, depth, path));
  return parts.length === 0 ? "" : ` [${parts.join(", ")}]`;
}

function rangeText(start, end, maximum) {
  if (end === maximum) return `${start} to max`;
  return start === end ? String(start) : `${start} to ${end}`;
}

function rangeStatements(keyword, ranges, isExclusive, maximum, pad) {
  if (!ranges?.length) return [];
  const items = ranges.map((range) => rangeText(range.start, isExclusive ? range.end - 1 : range.end, maximum));
  return [`${pad}${keyword} ${items.join(", ")};`];
}

function printField(schema, syntax, field, depth, path, label, isExtension = false) {
  const pad = "  ".repeat(depth);
  if (field.type === "TYPE_GROUP") unsupported(path, "group");
  const bracket = fieldBracket(schema, field, depth, path, isExtension);
  if (isMapEntry(schema, field)) {
    const entry = schema.messages.get(field.typeName);
    const key = entry.field.find((item) => item.number === 1), value = entry.field.find((item) => item.number === 2);
    return `${pad}map<${fieldType(key)}, ${fieldType(value)}> ${field.name} = ${field.number}${bracket};`;
  }
  return `${pad}${label}${fieldType(field)} ${field.name} = ${field.number}${bracket};`;
}

function fieldLabel(syntax, field, isInOneof) {
  if (isInOneof) return "";
  if (field.label === "LABEL_REPEATED") return "repeated ";
  if (field.label === "LABEL_REQUIRED") return "required ";
  if (syntax === "proto3") return field.proto3Optional ? "optional " : "";
  return "optional ";
}

function printEnum(schema, enumeration, depth, path) {
  const pad = "  ".repeat(depth), inner = "  ".repeat(depth + 1);
  const lines = [`${pad}enum ${enumeration.name} {`, ...optionStatements(schema, "enum", enumeration.options, depth + 1, path)];
  for (const value of enumeration.value ?? []) {
    const options = optionAssignments(schema, "value", value.options, depth + 1, `${path}.${value.name}`);
    lines.push(`${inner}${value.name} = ${value.number}${options.length ? ` [${options.join(", ")}]` : ""};`);
  }
  lines.push(...rangeStatements("reserved", enumeration.reservedRange, false, ENUM_RANGE_MAX, inner));
  if (enumeration.reservedName?.length) lines.push(`${inner}reserved ${enumeration.reservedName.map(quoteText).join(", ")};`);
  lines.push(`${pad}}`);
  return lines;
}

function printExtends(schema, syntax, extensions, depth, path) {
  const lines = [], pad = "  ".repeat(depth);
  let current;
  for (const extension of extensions ?? []) {
    if (extension.extendee !== current) {
      if (current !== undefined) lines.push(`${pad}}`);
      current = extension.extendee;
      lines.push(`${pad}extend ${current} {`);
    }
    lines.push(printField(schema, syntax, extension, depth + 1, `${path}.${extension.name}`, fieldLabel(syntax, extension, false), true));
  }
  if (current !== undefined) lines.push(`${pad}}`);
  return lines;
}

function printMessage(schema, syntax, message, depth, path) {
  const pad = "  ".repeat(depth), inner = "  ".repeat(depth + 1);
  const name = `${path}.${message.name}`;
  const lines = [`${pad}message ${message.name} {`, ...optionStatements(schema, "message", message.options, depth + 1, name, ["mapEntry"])];
  const fields = message.field ?? [];
  const isSynthetic = (index) => {
    const members = fields.filter((field) => field.oneofIndex === index);
    return members.length === 1 && members[0].proto3Optional === true;
  };
  const printedOneofs = new Set();
  let next = 0;
  const printFieldsUntil = (end) => {
    while (next < end) {
      const field = fields[next], index = field.oneofIndex;
      if (index === undefined || isSynthetic(index)) {
        lines.push(printField(schema, syntax, field, depth + 1, `${name}.${field.name}`, fieldLabel(syntax, field, false)));
        next++;
        continue;
      }
      const members = fields.filter((item) => item.oneofIndex === index);
      if (printedOneofs.has(index) || fields.slice(next, next + members.length).some((item) => item.oneofIndex !== index)) {
        unsupported(name, `oneof ${message.oneofDecl[index].name} fields are not contiguous`);
      }
      printedOneofs.add(index);
      const oneof = message.oneofDecl[index];
      lines.push(`${inner}oneof ${oneof.name} {`, ...optionStatements(schema, "oneof", oneof.options, depth + 2, `${name}.${oneof.name}`));
      for (const member of members) lines.push(printField(schema, syntax, member, depth + 2, `${name}.${member.name}`, ""));
      lines.push(`${inner}}`);
      next += members.length;
    }
  };
  // The compiler creates the entry message when it meets a map field, so fields are interleaved to keep the nested message order.
  for (const nested of message.nestedType ?? []) {
    if (!nested.options?.mapEntry) {
      lines.push(...printMessage(schema, syntax, nested, depth + 1, name));
      continue;
    }
    const owner = fields.findIndex((field) => field.typeName === `${name}.${nested.name}`);
    if (owner < 0) unsupported(name, `map entry ${nested.name} without field`);
    printFieldsUntil(owner + 1);
  }
  printFieldsUntil(fields.length);
  (message.oneofDecl ?? []).forEach((oneof, index) => {
    if (!printedOneofs.has(index) && !isSynthetic(index)) unsupported(name, `empty oneof ${oneof.name}`);
  });
  lines.push(...rangeStatements("reserved", message.reservedRange, true, MESSAGE_RANGE_MAX, inner));
  if (message.reservedName?.length) lines.push(`${inner}reserved ${message.reservedName.map(quoteText).join(", ")};`);
  for (const range of message.extensionRange ?? []) {
    if (range.options) unsupported(name, "extension range options");
  }
  lines.push(...rangeStatements("extensions", message.extensionRange, true, MESSAGE_RANGE_MAX, inner));
  for (const enumeration of message.enumType ?? []) lines.push(...printEnum(schema, enumeration, depth + 1, `${name}.${enumeration.name}`));
  lines.push(...printExtends(schema, syntax, message.extension, depth + 1, name));
  lines.push(`${pad}}`);
  return lines;
}

function printService(schema, service, path) {
  const lines = [`service ${service.name} {`, ...optionStatements(schema, "service", service.options, 1, path)];
  for (const method of service.method ?? []) {
    const signature = `  rpc ${method.name}(${method.clientStreaming ? "stream " : ""}${method.inputType}) returns (${method.serverStreaming ? "stream " : ""}${method.outputType})`;
    const options = optionStatements(schema, "method", method.options, 2, `${path}.${method.name}`);
    lines.push(options.length ? `${signature} {` : `${signature};`, ...(options.length ? [...options, "  }"] : []));
  }
  lines.push("}");
  return lines;
}

export function printFile(schema, file, header) {
  if (file.edition || file.publicDependency?.length || file.weakDependency?.length || file.sourceCodeInfo) unsupported(file.name, "editions/public/weak/source info");
  const syntax = file.syntax || "proto2";
  const path = file.package ? `.${file.package}` : "";
  const sections = [[...header, `syntax = "${syntax}";`]];
  if (file.package) sections.push([`package ${file.package};`]);
  if (file.dependency?.length) sections.push(file.dependency.map((dependency) => `import ${quoteText(dependency)};`));
  const options = optionStatements(schema, "file", file.options, 0, file.name);
  if (options.length) sections.push(options);
  for (const message of file.messageType ?? []) sections.push(printMessage(schema, syntax, message, 0, path));
  for (const enumeration of file.enumType ?? []) sections.push(printEnum(schema, enumeration, 0, `${path}.${enumeration.name}`));
  const extensions = printExtends(schema, syntax, file.extension, 0, path);
  if (extensions.length) sections.push(extensions);
  for (const service of file.service ?? []) sections.push(printService(schema, service, `${path}.${service.name}`));
  return `${sections.map((lines) => lines.join("\n")).join("\n\n")}\n`;
}

function safeOutputPath(root, name) {
  if (isAbsolute(name) || normalize(name).split(sep).includes("..")) throw new Error(`File name outside the output root: ${name}`);
  return join(root, name);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: "string" }, descriptor: { type: "string" }, help: { type: "boolean" } } });
  if (values.help || !values.out || !values.descriptor) {
    console.log("Usage: node verification/scripts/descriptor-to-proto.mjs --out <new-or-empty-dir> --descriptor <FileDescriptorSet>");
    process.exit(values.help ? 0 : 2);
  }
  const descriptor = resolve(values.descriptor);
  const out = resolve(values.out);
  let isEmpty = true;
  try { isEmpty = readdirSync(out).length === 0; } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!isEmpty) throw new Error(`Existing files are not overwritten. Choose an empty output directory: ${out}`);
  const work = mkdtempSync(join(tmpdir(), "pi-devin-proto-print-"));
  try {
    const set = descriptorSetJSON(descriptor, descriptor, join(work, "original.json"), work);
    const schema = createSchema(set);
    const digest = sha256(readFileSync(descriptor));
    const header = [
      `// Printed from ${basename(descriptor)} (sha256 ${digest}).`,
      "// Declarations, numbers and options come from that descriptor. Original comments and layout are not recoverable.",
    ];
    for (const file of set.file) {
      const target = safeOutputPath(out, file.name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, printFile(schema, file, header), { flag: "wx" });
    }
    console.log(JSON.stringify({ out, files: set.file.length, descriptorSha256: digest }));
  } finally { rmSync(work, { recursive: true, force: true }); }
}
