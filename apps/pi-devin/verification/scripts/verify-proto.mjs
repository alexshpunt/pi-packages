#!/usr/bin/env node
// Source-only check: recompiles the proto/ sources with the pinned buf,
// cross-checks the wire output of the real runtime codec (which loads the same sources directly),
// and confirms the capture-based probes really depend on the added definitions.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { APP_ROOT, bufVersion, runBuf, sha256 } from "./lib/buf.mjs";

const USAGE = `Usage: node verification/scripts/verify-proto.mjs [--source <proto-root>] [--report <file>] [--mutation-control]

  --source            .proto source root (default: <app>/proto)
  --report            JSON report path inside <app>/verification/followup/ or the OS temp directory
  --mutation-control  also verify that a scratch copy with one changed field number fails

Exit 0 means every check passed. Exit 1 means compilation, a wire check or a control failed.`;
const MODELS_METHOD = "exa.api_server_pb.ApiServerService/GetCliModelConfigs";
const CAPTURE_SEPARATOR = "[----------------------next message----------------------]";
const MUTATION = { file: "exa/chat_pb/chat.proto", from: "  string signature_type = 18;", to: "  string signature_type = 1018;" };

const require = createRequire(join(APP_ROOT, "package.json"));
const protobuf = require("protobufjs");

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

/** Loads a source tree exactly like the runtime: direct parse, keepCase, imports resolved against the tree. */
function rootFromSource(source, removeAdditions = []) {
  const root = new protobuf.Root();
  root.resolvePath = (_origin, target) => isAbsolute(target) ? target : join(source, target);
  root.loadSync(protoFiles(source).map((name) => join(source, name)), { keepCase: true });
  for (const addition of removeAdditions) {
    if (addition.kind === "field") {
      const type = root.lookupType(addition.parent);
      type.remove(type.fields[addition.field.name]);
    } else root.lookupEnum(addition.parent).remove(addition.value.name);
  }
  root.resolveAll();
  return root;
}

function capturedJSON(text) {
  return JSON.parse(text, (_key, value) => typeof value === "string"
    ? value.replace(/^Exa[A-Za-z0-9]+_[A-Za-z0-9]+_([A-Z][A-Z0-9_]+)$/, "$1") : value);
}

/** Checks that runtime codec output bytes survive decode→encode with the parsed schema. protobufjs drops unknown fields. */
function roundTrip(root, typeName, bytes) {
  const type = root.lookupType(typeName);
  const message = type.decode(bytes);
  return { isIdentical: Buffer.compare(Buffer.from(type.encode(message).finish()), Buffer.from(bytes)) === 0,
    object: type.toObject(message, { longs: String, enums: String, bytes: String, defaults: false }) };
}

/** The runtime codecs are imported from the real runtime; the check roots are parsed from the same source tree. */
async function runtimeChecks(source, additions) {
  const runtime = await import(pathToFileURL(join(APP_ROOT, "src/core/protocol/protobuf.ts")).href);
  const parsed = rootFromSource(source);
  const originalOnly = rootFromSource(source, additions);
  const cases = [], failures = [];
  const record = (name, ok, detail = {}) => { cases.push({ name, ok, ...detail }); if (!ok) failures.push(name); };
  const samples = join(APP_ROOT, "tests/fixtures/captured-samples/GetChatMessage");
  let frames = 0;
  for (const sample of readdirSync(samples).filter((name) => statSync(join(samples, name)).isDirectory()).sort()) {
    const request = capturedJSON(readFileSync(join(samples, sample, "request.txt"), "utf8"));
    const original = roundTrip(parsed, "exa.api_server_pb.GetChatMessageRequest", runtime.chatRequestCodec.encode(request));
    request.clientSessionId = "probe-session";
    request.chatMessagePrompts = (request.chatMessagePrompts ?? []).map((prompt, index) => index === 0 ? { ...prompt, modelUid: "probe-model" } : prompt);
    const probed = runtime.chatRequestCodec.encode(request);
    const augmented = roundTrip(parsed, "exa.api_server_pb.GetChatMessageRequest", probed);
    const withoutAdditions = roundTrip(originalOnly, "exa.api_server_pb.GetChatMessageRequest", probed);
    record(`GetChatMessage/${sample}/request`, original.isIdentical && augmented.isIdentical
      && augmented.object.client_session_id === "probe-session" && augmented.object.chat_message_prompts?.[0]?.model_uid === "probe-model"
      && !withoutAdditions.isIdentical, { bytes: probed.length, controlWithoutAdditionsDiffers: !withoutAdditions.isIdentical });
    let responseOk = true;
    for (const part of readFileSync(join(samples, sample, "response.txt"), "utf8").split(CAPTURE_SEPARATOR).filter((value) => value.trim())) {
      frames++;
      responseOk &&= roundTrip(parsed, "exa.api_server_pb.GetChatMessageResponse", runtime.chatResponseCodec.encode(capturedJSON(part))).isIdentical;
    }
    record(`GetChatMessage/${sample}/response`, responseOk);
  }
  const models = runtime.unaryCodecs(MODELS_METHOD);
  const catalog = JSON.parse(readFileSync(join(APP_ROOT, "tests/fixtures/model-catalog.json"), "utf8"));
  const catalogBytes = models.response.encode(catalog);
  const catalogTrip = roundTrip(parsed, "exa.api_server_pb.GetCliModelConfigsResponse", catalogBytes);
  record("GetCliModelConfigs/response/catalog-fixture", catalogTrip.isIdentical, { configs: catalog.clientModelConfigs.length, bytes: catalogBytes.length });
  const probe = { clientModelConfigs: [{ modelUid: "probe-model", modelInfo: { modelUid: "probe-model", aliases: ["probe-alias", "probe-family"] } }] };
  const aliasBytes = models.response.encode(probe);
  const aliasTrip = roundTrip(parsed, "exa.api_server_pb.GetCliModelConfigsResponse", aliasBytes);
  record("ModelInfo.aliases", aliasTrip.isIdentical && JSON.stringify(models.response.decode(aliasBytes)) === JSON.stringify(probe)
    && !roundTrip(originalOnly, "exa.api_server_pb.GetCliModelConfigsResponse", aliasBytes).isIdentical);
  const displays = ["DISPLAY_OPTION_MODEL_ROUTER", "DISPLAY_OPTION_QUICK_REVIEW", "DISPLAY_OPTION_HIDDEN_TOOL", "DISPLAY_OPTION_WIRE_7", "DISPLAY_OPTION_MODERN_AGENT_CHAT"];
  const displayBytes = models.request.encode({ metadata: { supportedModelDisplays: displays } });
  const displayTrip = roundTrip(parsed, "exa.api_server_pb.GetCliModelConfigsRequest", displayBytes);
  const displayOriginal = roundTrip(originalOnly, "exa.api_server_pb.GetCliModelConfigsRequest", displayBytes);
  record("DisplayOption.DISPLAY_OPTION_WIRE_7=7", displayTrip.isIdentical && JSON.stringify(displayTrip.object.metadata.supported_model_displays) === JSON.stringify(displays)
    && displayOriginal.object.metadata.supported_model_displays[3] === 7, { withoutAdditionsDecodes: displayOriginal.object.metadata.supported_model_displays[3] });
  let isUnknownRejected = false;
  try { runtime.chatRequestCodec.encode({ notAField: true }); } catch (error) { isUnknownRejected = /Field not in the protobuf schema/.test(error.message); }
  record("runtime rejects unknown DTO fields", isUnknownRejected && !parsed.lookupType("exa.api_server_pb.GetChatMessageRequest").fields.not_a_field);
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

function assertReportPath(path) {
  const allowed = [realpathSync(join(APP_ROOT, "verification/followup")) + sep, realpathSync(tmpdir()) + sep];
  // The report file itself may not exist yet, so validate through its real directory.
  const target = join(realpathSync(dirname(path)), basename(path));
  if (!allowed.some((prefix) => target.startsWith(prefix))) throw new Error(`Reports are written only to verification/followup or a temp directory: ${path}`);
}

async function main() {
  const { values } = parseArgs({ options: { source: { type: "string" }, report: { type: "string" }, "mutation-control": { type: "boolean" }, help: { type: "boolean" } } });
  if (values.help) { console.log(USAGE); return 0; }
  const source = resolve(values.source ?? join(APP_ROOT, "proto"));
  const reportPath = values.report ? resolve(values.report) : undefined;
  if (reportPath) assertReportPath(reportPath);
  const provenancePath = join(APP_ROOT, "verification/followup/proto-provenance.json");
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  const work = mkdtempSync(join(tmpdir(), "pi-devin-verify-proto-"));
  const report = { schemaVersion: 3, tool: "verification/scripts/verify-proto.mjs", recordedAt: new Date().toISOString(), ok: false };
  try {
    const sourceFiles = protoFiles(source);
    report.tools = { buf: bufVersion(work), node: process.version, protobufjs: require("protobufjs/package.json").version };
    report.inputs = {
      provenance: { path: relative(APP_ROOT, provenancePath), sha256: sha256(readFileSync(provenancePath)) },
      sourceRoot: relative(APP_ROOT, source) || ".",
      sourceFiles: sourceFiles.map((name) => ({ name, sha256: sha256(readFileSync(join(source, name))) })),
      runtime: { path: "src/core/protocol/protobuf.ts", sha256: sha256(readFileSync(join(APP_ROOT, "src/core/protocol/protobuf.ts"))) },
      fixtures: ["tests/fixtures/captured-samples/GetChatMessage", "tests/fixtures/model-catalog.json"],
    };
    report.compilerCommand = `buf build ${report.inputs.sourceRoot} --as-file-descriptor-set --exclude-source-info`;
    const build = buildSource(source, work, "regenerated");
    report.generation = build.ok ? { ok: true, bytes: build.bytes.length, sha256: sha256(build.bytes) } : { ok: false, error: build.error };
    report.observedAdditions = provenance.observedAdditions.map((addition) => ({ id: addition.id, parent: addition.parent, ...(addition.field ?? addition.value) }));
    report.runtime = build.ok ? await runtimeChecks(source, provenance.observedAdditions) : { skipped: "compilation failed" };
    if (values["mutation-control"]) {
      const scratch = join(work, "mutated source");
      cpSync(source, scratch, { recursive: true });
      const target = join(scratch, MUTATION.file), text = readFileSync(target, "utf8");
      if (text.split(MUTATION.from).length !== 2) throw new Error(`Mutation control target statement not found: ${MUTATION.from}`);
      writeFileSync(target, text.replace(MUTATION.from, MUTATION.to));
      const mutated = buildSource(scratch, work, "mutated");
      report.mutationControl = { change: MUTATION, detected: !mutated.ok || Buffer.compare(mutated.bytes, build.bytes) !== 0,
        sourceUnchanged: sha256(readFileSync(join(source, MUTATION.file))) === report.inputs.sourceFiles.find((file) => file.name === MUTATION.file).sha256 };
    }
    report.ok = build.ok && report.runtime.failures?.length === 0
      && (!values["mutation-control"] || (report.mutationControl.detected && report.mutationControl.sourceUnchanged));
  } catch (error) {
    report.error = String(error.stack ?? error);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(JSON.stringify({ ok: report.ok, generation: report.generation?.ok, runtime: report.runtime?.skipped ?? `${report.runtime?.cases?.length ?? 0} cases, ${report.runtime?.failures?.length ?? 0} failures`,
    mutationControl: report.mutationControl, report: reportPath ? relative(APP_ROOT, reportPath) : undefined }, null, 2));
  return report.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}