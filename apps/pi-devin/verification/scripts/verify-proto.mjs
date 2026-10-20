#!/usr/bin/env node
// Source-only check: recompiles the proto/ sources with the pinned buf.
// Checks byte equality with the shipped descriptor (resources/descriptors.pb) and cross-checks the wire output of the real runtime codec.
// With --original, also compares against the original descriptor plus the declared additions and normalizations.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { APP_ROOT, bufVersion, descriptorSetJSON, runBuf, sha256 } from "./lib/buf.mjs";
import { defaultJSONName } from "./descriptor-to-proto.mjs";

const USAGE = `Usage: node verification/scripts/verify-proto.mjs [--source <proto-root>] [--original <descriptor>] [--report <file>] [--mutation-control]

  --source            .proto source root (default: <app>/proto)
  --original          original third-party FileDescriptorSet; must match the provenance baseline (optional, not shipped)
  --report            JSON report path inside <app>/verification/followup/ or the OS temp directory
  --mutation-control  also verify that a scratch copy with one changed field number fails

Exit 0 means every comparison passed. Exit 1 means a generation, shipped-descriptor, original, wire or control mismatch.`;
const MODELS_METHOD = "exa.api_server_pb.ApiServerService/GetCliModelConfigs";
const CAPTURE_SEPARATOR = "[----------------------next message----------------------]";
const MUTATION = { file: "exa/chat_pb/chat.proto", from: "  string signature_type = 18;", to: "  string signature_type = 1018;" };

const require = createRequire(join(APP_ROOT, "package.json"));
const protobuf = require("protobufjs");
require("protobufjs/ext/descriptor");

function rawFiles(bytes) {
  const reader = protobuf.Reader.create(bytes), files = new Map();
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    if (tag !== 10) { reader.skipType(tag & 7); continue; }
    const raw = Buffer.from(reader.bytes()), fileReader = protobuf.Reader.create(raw);
    let name;
    while (fileReader.pos < fileReader.len) {
      const fileTag = fileReader.uint32();
      if (fileTag === 10) { name = fileReader.string(); break; }
      fileReader.skipType(fileTag & 7);
    }
    if (!name || files.has(name)) throw new Error(`Invalid FileDescriptorSet file name: ${name}`);
    files.set(name, raw);
  }
  return files;
}

function protoFiles(root) {
  const result = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".proto")) result.push(relative(root, path).split(sep).join("/"));
    }
  };
  walk(root);
  return result.sort();
}

function deepDiffs(expected, actual, path, output, limit = 50) {
  if (output.length >= limit || JSON.stringify(expected) === JSON.stringify(actual)) return;
  if (typeof expected !== "object" || typeof actual !== "object" || expected === null || actual === null || Array.isArray(expected) !== Array.isArray(actual)) {
    output.push({ path, expected, actual });
    return;
  }
  if (Array.isArray(expected)) {
    for (let index = 0; index < Math.max(expected.length, actual.length); index++) deepDiffs(expected[index], actual[index], `${path}[${index}]`, output, limit);
    return;
  }
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) deepDiffs(expected[key], actual[key], `${path}.${key}`, output, limit);
}

function findDeclaration(set, fullName) {
  for (const file of set.file) {
    const prefix = file.package ? `${file.package}.` : "";
    if (!fullName.startsWith(prefix)) continue;
    let messages = file.messageType ?? [], enums = file.enumType ?? [], current;
    const parts = fullName.slice(prefix.length).split(".");
    for (const [index, part] of parts.entries()) {
      const message = messages.find((item) => item.name === part);
      if (message) { current = message; messages = message.nestedType ?? []; enums = message.enumType ?? []; continue; }
      const enumeration = enums.find((item) => item.name === part);
      if (enumeration && index === parts.length - 1) return { file, enumeration };
      current = undefined;
      break;
    }
    if (current) return { file, message: current };
  }
  throw new Error(`Declaration not found: ${fullName}`);
}

/** Applies only the closed list of normalizations and provenance additions to the original JSON. Fails when an applied count differs from its declaration. */
function expectedSet(original, provenance) {
  const set = structuredClone(original), applied = { N1: 0, N2: 0 };
  const visitFields = (fields) => {
    for (const field of fields ?? []) {
      if (field.jsonName === undefined) { field.jsonName = defaultJSONName(field.name); applied.N2++; }
    }
  };
  const visitMessage = (message) => {
    visitFields(message.field); visitFields(message.extension);
    for (const nested of message.nestedType ?? []) visitMessage(nested);
  };
  for (const file of set.file) {
    visitFields(file.extension);
    for (const message of file.messageType ?? []) visitMessage(message);
    for (const service of file.service ?? []) {
      for (const method of service.method ?? []) {
        if (method.options && Object.keys(method.options).length === 0) { delete method.options; applied.N1++; }
      }
    }
  }
  for (const addition of provenance.observedAdditions) {
    const declaration = findDeclaration(set, addition.parent);
    if (declaration.file.name !== addition.file) throw new Error(`Addition file differs: ${addition.id}`);
    if (addition.kind === "field") {
      const fields = declaration.message?.field ?? (() => { throw new Error(`Not a message: ${addition.parent}`); })();
      if (fields.some((field) => field.number === addition.field.number || field.name === addition.field.name)) throw new Error(`Addition already in the original: ${addition.id}`);
      fields.push({ ...addition.field });
    } else if (addition.kind === "enumValue") {
      const values = declaration.enumeration?.value ?? (() => { throw new Error(`Not an enum: ${addition.parent}`); })();
      if (values.some((value) => value.number === addition.value.number || value.name === addition.value.name)) throw new Error(`Addition already in the original: ${addition.id}`);
      values.push({ ...addition.value });
    } else throw new Error(`Unknown addition kind: ${addition.kind}`);
  }
  for (const rule of provenance.normalization) {
    if (rule.expectedCount !== null && applied[rule.id] !== rule.expectedCount) {
      throw new Error(`Normalization ${rule.id} applied ${applied[rule.id]} times instead of the declared ${rule.expectedCount}.`);
    }
  }
  return { set, applied };
}

/** The name, number, type, oneof, map, presence, enum and service shape that protobufjs actually consumes. */
function runtimeShape(root) {
  const shape = {};
  const visit = (namespace) => {
    for (const nested of namespace.nestedArray) {
      if (nested instanceof protobuf.Type) {
        shape[nested.fullName] = {
          fields: nested.fieldsArray.map((field) => [field.name, field.id, field.type, field.repeated, field.required, field.map ? field.keyType : "",
            field.partOf?.name ?? "", field.options?.proto3_optional === true, field.options?.packed ?? null]),
          oneofs: nested.oneofsArray.map((oneof) => [oneof.name, oneof.oneof.join(",")]),
          mapEntry: nested.options?.map_entry === true,
        };
      } else if (nested instanceof protobuf.Enum) {
        shape[nested.fullName] = { values: Object.entries(nested.values) };
      } else if (nested instanceof protobuf.Service) {
        shape[nested.fullName] = { methods: nested.methodsArray.map((method) => [method.name, method.requestType, method.responseType, Boolean(method.requestStream), Boolean(method.responseStream)]) };
      }
      if (nested.nestedArray) visit(nested);
    }
  };
  visit(root);
  return shape;
}

function rootFromDescriptor(bytes, additions = []) {
  const root = protobuf.Root.fromDescriptor(bytes);
  for (const addition of additions) {
    if (addition.kind === "field") {
      root.lookupType(addition.parent).add(new protobuf.Field(addition.field.name, addition.field.number,
        addition.field.type.slice("TYPE_".length).toLowerCase(), addition.field.label === "LABEL_REPEATED" ? "repeated" : undefined));
    } else root.lookupEnum(addition.parent).add(addition.value.name, addition.value.number);
  }
  root.resolveAll();
  return root;
}

/** Control schema without the addition definitions. Used to check that the probes really depend on the added fields. */
function rootWithoutAdditions(bytes, additions) {
  const root = protobuf.Root.fromDescriptor(bytes);
  for (const addition of additions) {
    if (addition.kind === "field") {
      const type = root.lookupType(addition.parent);
      type.remove(type.fields[addition.field.name]);
    } else root.lookupEnum(addition.parent).remove(addition.value.name);
  }
  root.resolveAll();
  return root;
}

function capturedJSON(text) {
  return JSON.parse(text, (_key, value) => typeof value === "string" ? value.replace(/^Exa[A-Za-z0-9]+_[A-Za-z0-9]+_([A-Z][A-Z0-9_]+)$/, "$1") : value);
}

/** Checks that runtime codec output bytes survive decode→encode with the regenerated schema. protobufjs drops unknown fields. */
function roundTrip(regenerated, typeName, bytes) {
  const type = regenerated.lookupType(typeName);
  const message = type.decode(bytes);
  return { isIdentical: Buffer.compare(Buffer.from(type.encode(message).finish()), Buffer.from(bytes)) === 0,
    object: type.toObject(message, { longs: String, enums: String, bytes: String, defaults: false }) };
}

async function runtimeChecks(regeneratedBytes, additions) {
  const runtime = await import(pathToFileURL(join(APP_ROOT, "src/core/protocol/protobuf.ts")).href);
  const regenerated = rootFromDescriptor(regeneratedBytes);
  const originalOnly = rootWithoutAdditions(regeneratedBytes, additions);
  const cases = [], failures = [];
  const record = (name, ok, detail = {}) => { cases.push({ name, ok, ...detail }); if (!ok) failures.push(name); };
  const samples = join(APP_ROOT, "tests/fixtures/captured-samples/GetChatMessage");
  let frames = 0;
  for (const sample of readdirSync(samples).filter((name) => statSync(join(samples, name)).isDirectory()).sort()) {
    const request = capturedJSON(readFileSync(join(samples, sample, "request.txt"), "utf8"));
    const original = roundTrip(regenerated, "exa.api_server_pb.GetChatMessageRequest", runtime.chatRequestCodec.encode(request));
    request.clientSessionId = "probe-session";
    request.chatMessagePrompts = (request.chatMessagePrompts ?? []).map((prompt, index) => index === 0 ? { ...prompt, modelUid: "probe-model" } : prompt);
    const probed = runtime.chatRequestCodec.encode(request);
    const augmented = roundTrip(regenerated, "exa.api_server_pb.GetChatMessageRequest", probed);
    const withoutAdditions = roundTrip(originalOnly, "exa.api_server_pb.GetChatMessageRequest", probed);
    record(`GetChatMessage/${sample}/request`, original.isIdentical && augmented.isIdentical
      && augmented.object.client_session_id === "probe-session" && augmented.object.chat_message_prompts?.[0]?.model_uid === "probe-model"
      && !withoutAdditions.isIdentical, { bytes: probed.length, controlWithoutAdditionsDiffers: !withoutAdditions.isIdentical });
    let responseOk = true;
    for (const part of readFileSync(join(samples, sample, "response.txt"), "utf8").split(CAPTURE_SEPARATOR).filter((value) => value.trim())) {
      frames++;
      responseOk &&= roundTrip(regenerated, "exa.api_server_pb.GetChatMessageResponse", runtime.chatResponseCodec.encode(capturedJSON(part))).isIdentical;
    }
    record(`GetChatMessage/${sample}/response`, responseOk);
  }
  const models = runtime.unaryCodecs(MODELS_METHOD);
  const catalog = JSON.parse(readFileSync(join(APP_ROOT, "tests/fixtures/model-catalog.json"), "utf8"));
  const catalogBytes = models.response.encode(catalog);
  const catalogTrip = roundTrip(regenerated, "exa.api_server_pb.GetCliModelConfigsResponse", catalogBytes);
  record("GetCliModelConfigs/response/catalog-fixture", catalogTrip.isIdentical, { configs: catalog.clientModelConfigs.length, bytes: catalogBytes.length });
  const probe = { clientModelConfigs: [{ modelUid: "probe-model", modelInfo: { modelUid: "probe-model", aliases: ["probe-alias", "probe-family"] } }] };
  const aliasBytes = models.response.encode(probe);
  const aliasTrip = roundTrip(regenerated, "exa.api_server_pb.GetCliModelConfigsResponse", aliasBytes);
  record("ModelInfo.aliases=27", aliasTrip.isIdentical && JSON.stringify(aliasTrip.object.client_model_configs[0].model_info.aliases) === JSON.stringify(["probe-alias", "probe-family"])
    && JSON.stringify(models.response.decode(aliasBytes)) === JSON.stringify(probe)
    && !roundTrip(originalOnly, "exa.api_server_pb.GetCliModelConfigsResponse", aliasBytes).isIdentical);
  const displays = ["DISPLAY_OPTION_MODEL_ROUTER", "DISPLAY_OPTION_QUICK_REVIEW", "DISPLAY_OPTION_HIDDEN_TOOL", "DISPLAY_OPTION_WIRE_7", "DISPLAY_OPTION_MODERN_AGENT_CHAT"];
  const displayBytes = models.request.encode({ metadata: { supportedModelDisplays: displays } });
  const displayTrip = roundTrip(regenerated, "exa.api_server_pb.GetCliModelConfigsRequest", displayBytes);
  const displayOriginal = roundTrip(originalOnly, "exa.api_server_pb.GetCliModelConfigsRequest", displayBytes);
  record("DisplayOption.DISPLAY_OPTION_WIRE_7=7", displayTrip.isIdentical && JSON.stringify(displayTrip.object.metadata.supported_model_displays) === JSON.stringify(displays)
    && displayOriginal.object.metadata.supported_model_displays[3] === 7, { originalDescriptorDecodes: displayOriginal.object.metadata.supported_model_displays[3] });
  let isUnknownRejected = false;
  try { runtime.chatRequestCodec.encode({ notAField: true }); } catch (error) { isUnknownRejected = /Field not in the protobuf schema/.test(error.message); }
  record("runtime rejects unknown DTO fields", isUnknownRejected && !regenerated.lookupType("exa.api_server_pb.GetChatMessageRequest").fields.not_a_field);
  return { cases, failures, capturedRequests: cases.filter((item) => item.name.endsWith("/request")).length, responseFrames: frames };
}

function buildSource(source, work, label) {
  const path = join(work, `${label}.binpb`);
  try {
    runBuf(["build", source, "--as-file-descriptor-set", "--exclude-source-info", "-o", path], work);
  } catch (error) {
    return { ok: false, error: String(error.stderr || error.message).trim().slice(0, 2000) };
  }
  return { ok: true, path, bytes: readFileSync(path) };
}

/** Compares the regenerated result with the original JSON plus normalizations and additions by file bytes, semantics and runtime shape. */
function compareWithOriginal(build, context) {
  const { originalJSON, originalBytes, provenance, work, label } = context;
  const regeneratedJSON = descriptorSetJSON(join(APP_ROOT, "resources/descriptors.pb"), build.path, join(work, `${label}.json`), work);
  const { set, applied } = expectedSet(originalJSON, provenance);
  const expectedJSONPath = join(work, `${label}-expected.json`), expectedPath = join(work, `${label}-expected.binpb`);
  writeFileSync(expectedJSONPath, JSON.stringify(set));
  runBuf(["convert", `${join(APP_ROOT, "resources/descriptors.pb")}#format=binpb`, "--type", "google.protobuf.FileDescriptorSet",
    "--from", `${expectedJSONPath}#format=json`, "--to", `${expectedPath}#format=binpb`], work);
  const expected = rawFiles(readFileSync(expectedPath)), actual = rawFiles(build.bytes);
  const missing = [...expected.keys()].filter((name) => !actual.has(name)), extra = [...actual.keys()].filter((name) => !expected.has(name));
  const byteMismatches = [...expected].filter(([name, bytes]) => actual.has(name) && Buffer.compare(bytes, actual.get(name)) !== 0).map(([name]) => name);
  const semanticDiffs = [];
  const actualByName = new Map(regeneratedJSON.file.map((file) => [file.name, file]));
  for (const file of set.file) if (actualByName.has(file.name)) deepDiffs(file, actualByName.get(file.name), file.name, semanticDiffs);
  const expectedShape = runtimeShape(rootFromDescriptor(originalBytes, provenance.observedAdditions));
  const actualShape = runtimeShape(rootFromDescriptor(build.bytes));
  const shapeDiffs = [];
  deepDiffs(expectedShape, actualShape, "root", shapeDiffs);
  return {
    ok: missing.length === 0 && extra.length === 0 && byteMismatches.length === 0 && semanticDiffs.length === 0 && shapeDiffs.length === 0,
    normalizationApplied: applied,
    files: { expected: expected.size, actual: actual.size, byteIdentical: expected.size - byteMismatches.length - missing.length, missing, extra, byteMismatches,
      setOrderMatchesOriginal: JSON.stringify(originalJSON.file.map((file) => file.name)) === JSON.stringify(regeneratedJSON.file.map((file) => file.name)) },
    semanticDiffs, runtimeShape: { types: Object.keys(expectedShape).length, diffs: shapeDiffs },
  };
}

/** Compares the shipped descriptor with the regenerated result, as a whole and per file, by bytes. */
function compareWithShipped(build, shippedBytes) {
  const expected = rawFiles(shippedBytes), actual = rawFiles(build.bytes);
  const byteMismatches = [...expected].filter(([name, bytes]) => actual.has(name) && Buffer.compare(bytes, actual.get(name)) !== 0).map(([name]) => name);
  const missing = [...expected.keys()].filter((name) => !actual.has(name)), extra = [...actual.keys()].filter((name) => !expected.has(name));
  return { ok: Buffer.compare(build.bytes, shippedBytes) === 0, regeneratedSha256: sha256(build.bytes), shippedSha256: sha256(shippedBytes),
    files: expected.size, byteMismatches, missing, extra };
}

/** A report path that does not exist yet is compared through the real path of its nearest existing parent, including links like macOS /var → /private/var. */
function realPath(path) {
  const rest = [];
  let current = path;
  while (!existsSync(current)) { rest.unshift(basename(current)); current = dirname(current); }
  return join(realpathSync(current), ...rest);
}

function assertReportPath(path) {
  const allowed = [realPath(join(APP_ROOT, "verification/followup")) + sep, realPath(tmpdir()) + sep];
  if (!allowed.some((prefix) => realPath(path).startsWith(prefix))) throw new Error(`Reports are written only to verification/followup or a temp directory: ${path}`);
}

async function main() {
  const { values } = parseArgs({ options: { source: { type: "string" }, original: { type: "string" }, report: { type: "string" }, "mutation-control": { type: "boolean" }, help: { type: "boolean" } } });
  if (values.help) { console.log(USAGE); return 0; }
  const source = resolve(values.source ?? join(APP_ROOT, "proto"));
  const reportPath = values.report ? resolve(values.report) : undefined;
  if (reportPath) assertReportPath(reportPath);
  const provenancePath = join(APP_ROOT, "verification/followup/proto-provenance.json");
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  const shippedPath = join(APP_ROOT, "resources/descriptors.pb");
  const shippedBytes = readFileSync(shippedPath), shippedBefore = sha256(shippedBytes);
  const work = mkdtempSync(join(tmpdir(), "pi-devin-verify-proto-"));
  const report = { schemaVersion: 2, tool: "verification/scripts/verify-proto.mjs", recordedAt: new Date().toISOString(), ok: false };
  try {
    const sourceFiles = protoFiles(source);
    report.tools = { buf: bufVersion(work), node: process.version, protobufjs: require("protobufjs/package.json").version };
    report.inputs = {
      shippedDescriptor: { path: relative(APP_ROOT, shippedPath), sha256: shippedBefore, bytes: shippedBytes.length, expectedSha256: provenance.shipped.sha256 },
      provenance: { path: relative(APP_ROOT, provenancePath), sha256: sha256(readFileSync(provenancePath)) },
      sourceRoot: relative(APP_ROOT, source) || ".",
      sourceFiles: sourceFiles.map((name) => ({ name, sha256: sha256(readFileSync(join(source, name))) })),
      runtime: { path: "src/core/protocol/protobuf.ts", sha256: sha256(readFileSync(join(APP_ROOT, "src/core/protocol/protobuf.ts"))) },
      fixtures: ["tests/fixtures/captured-samples/GetChatMessage", "tests/fixtures/model-catalog.json"],
    };
    report.compilerCommand = `buf build ${report.inputs.sourceRoot} --as-file-descriptor-set --exclude-source-info`;
    const build = buildSource(source, work, "regenerated");
    report.generation = build.ok ? { ok: true, bytes: build.bytes.length, sha256: sha256(build.bytes) } : { ok: false, error: build.error };
    report.shipped = build.ok ? compareWithShipped(build, shippedBytes) : { ok: false, skipped: "generation failed" };
    report.shipped.matchesProvenance = shippedBefore === provenance.shipped.sha256;
    if (values.original) {
      const originalPath = resolve(values.original), originalBytes = readFileSync(originalPath), originalRaw = rawFiles(originalBytes);
      const baselineFiles = provenance.original.files.map((file) => [file.name, file.sha256]);
      const actualFiles = [...originalRaw].map(([name, bytes]) => [name, sha256(bytes)]);
      const baseline = { sha256: sha256(originalBytes), expectedSha256: provenance.original.sha256, files: originalRaw.size,
        ok: sha256(originalBytes) === provenance.original.sha256 && JSON.stringify(baselineFiles) === JSON.stringify(actualFiles) };
      report.original = { baseline, ...(baseline.ok && build.ok ? compareWithOriginal(build, {
        originalJSON: descriptorSetJSON(shippedPath, originalPath, join(work, "original.json"), work), originalBytes, provenance, work, label: "original-comparison" }) : { ok: false }) };
      report.original.ok &&= baseline.ok;
    } else {
      report.original = { skipped: "original descriptor not supplied; the recorded equivalence is verification/followup/proto-check-12.json" };
    }
    report.observedAdditions = provenance.observedAdditions.map((addition) => ({ id: addition.id, parent: addition.parent, ...(addition.field ?? addition.value) }));
    const isComparable = build.ok && report.shipped.ok && report.shipped.matchesProvenance && (report.original.skipped !== undefined || report.original.ok);
    report.runtime = isComparable ? await runtimeChecks(build.bytes, provenance.observedAdditions) : { skipped: "comparison failed" };
    if (values["mutation-control"]) {
      const scratch = join(work, "mutated source");
      cpSync(source, scratch, { recursive: true });
      const target = join(scratch, MUTATION.file), text = readFileSync(target, "utf8");
      if (text.split(MUTATION.from).length !== 2) throw new Error(`Mutation control target statement not found: ${MUTATION.from}`);
      writeFileSync(target, text.replace(MUTATION.from, MUTATION.to));
      const mutated = buildSource(scratch, work, "mutated");
      const comparison = mutated.ok ? compareWithShipped(mutated, shippedBytes) : { ok: false, byteMismatches: [] };
      report.mutationControl = { change: MUTATION, detected: comparison.ok === false, byteMismatches: comparison.byteMismatches,
        sourceUnchanged: sha256(readFileSync(join(source, MUTATION.file))) === report.inputs.sourceFiles.find((file) => file.name === MUTATION.file).sha256 };
    }
    report.ok = isComparable && report.runtime.failures?.length === 0
      && (!values["mutation-control"] || (report.mutationControl.detected && report.mutationControl.sourceUnchanged));
  } catch (error) {
    report.error = String(error.stack ?? error);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  report.shippedDescriptorUnchanged = sha256(readFileSync(shippedPath)) === shippedBefore;
  report.ok &&= report.shippedDescriptorUnchanged;
  if (reportPath) { mkdirSync(dirname(reportPath), { recursive: true }); writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n"); }
  console.log(JSON.stringify({
    ok: report.ok, shipped: report.shipped?.ok, shippedFiles: report.shipped?.files, original: report.original?.skipped ? "skipped" : report.original?.ok,
    originalByteIdentical: report.original?.files?.byteIdentical, runtimeCases: report.runtime?.cases?.length, runtimeFailures: report.runtime?.failures,
    mutationDetected: report.mutationControl?.detected, error: report.error?.split("\n")[0], report: reportPath,
  }));
  return report.ok ? 0 : 1;
}

process.exitCode = await main();
