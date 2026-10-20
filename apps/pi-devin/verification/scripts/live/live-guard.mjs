// Node preload for the 07 live check. Not shipped.
// The Devin transport calls request() of node:http/https directly, so both modules' request is wrapped and the ESM named imports are synced.
// Right before end() sends the request body, the following is enforced. A refused request is destroyed without writing the HTTP request.
// - refuse requests outside the allowed hosts
// - check that the final protobuf chatModelUid of a chat request is an approved UID (including Fusion sidekick requests)
// - an overall cap on physical model HTTP requests across processes
// - check that the approved UIDs in the catalog response are active and free tier; otherwise stop all later model requests
// Records hold only the method, UID, status code and time. Bodies, headers, tokens and fingerprints are never recorded.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";

const required = (name) => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`live-guard: ${name} is required`);
  return value;
};
const ledgerPath = required("PI_DEVIN_LIVE_LEDGER");
const allowedUIDs = new Set(required("PI_DEVIN_LIVE_ALLOWED_UIDS").split(",").map((uid) => uid.trim()).filter(Boolean));
const allowedHosts = new Set(required("PI_DEVIN_LIVE_ALLOWED_HOSTS").split(",").map((host) => host.trim()).filter(Boolean));
const maxModelCalls = Number(required("PI_DEVIN_LIVE_MAX_MODEL_CALLS"));
const requireFreeTier = process.env.PI_DEVIN_LIVE_REQUIRE_FREE_TIER === "1";
if (!Number.isSafeInteger(maxModelCalls) || maxModelCalls < 0) throw new Error("live-guard: invalid PI_DEVIN_LIVE_MAX_MODEL_CALLS");
if (allowedHosts.has("*")) throw new Error("live-guard: wildcard hosts are not allowed");
const protobuf = await import(pathToFileURL(required("PI_DEVIN_LIVE_CODEC")).href);
const MODELS_METHOD = "exa.api_server_pb.ApiServerService/GetCliModelConfigs";
const FREE_TIER = "MODEL_COST_TIER_FREE";

function record(entry) {
  appendFileSync(ledgerPath, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry }) + "\n");
}
function ledger() {
  const entries = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return { modelCalls: entries.filter((entry) => entry.kind === "model").length, halted: entries.some((entry) => entry.kind === "halt") };
}
function chatModelUID(body) {
  const bytes = Buffer.from(body);
  return protobuf.chatRequestCodec.decode(bytes[0] & 1 ? gunzipSync(bytes.subarray(5)) : bytes.subarray(5)).chatModelUid;
}
function inspectCatalog(bytes) {
  try {
    const catalog = protobuf.unaryCodecs(MODELS_METHOD).response.decode(bytes);
    const configs = new Map((catalog.clientModelConfigs ?? []).map((config) => [config.modelUid, config]));
    const uids = Object.fromEntries([...allowedUIDs].map((uid) => {
      const config = configs.get(uid);
      return [uid, config ? { present: true, disabled: Boolean(config.disabled), costTier: config.modelCostTier ?? null,
        promoActive: config.promoStatus?.isActive ?? null, promoEnd: config.promoStatus?.endDate ?? null } : { present: false }];
    }));
    record({ kind: "catalog", models: configs.size, uids });
    const unusable = Object.entries(uids).filter(([, info]) => !info.present || info.disabled || (requireFreeTier && info.costTier !== FREE_TIER));
    if (unusable.length) record({ kind: "halt", reason: "approved UID missing, disabled or not free tier", uids: unusable.map(([uid]) => uid) });
  } catch (error) {
    record({ kind: "halt", reason: "catalog could not be inspected", error: error instanceof Error ? error.name : "unknown" });
  }
}
function target(args, scheme) {
  const [first, second] = args;
  if (first instanceof URL || typeof first === "string") {
    const url = new URL(first);
    return { host: url.host, path: url.pathname };
  }
  const options = first ?? {};
  const port = options.port && String(options.port) !== (scheme === "https:" ? "443" : "80") ? `:${options.port}` : "";
  return { host: `${options.hostname ?? options.host ?? "localhost"}${port}`, path: String(options.path ?? "/").split("?")[0], second };
}
/** Decides before end(). Returns the reason when the request is not allowed. */
function decide(host, method, body) {
  if (!allowedHosts.has(host)) return { reason: "host", details: { host } };
  if (method !== protobuf.CHAT_METHOD) return { entry: { kind: "read", method: method.split("/").pop(), host } };
  let uid;
  try { uid = chatModelUID(body); } catch { return { reason: "undecodable-chat", details: {} }; }
  const state = ledger();
  if (state.halted) return { reason: "halted", details: { uid } };
  if (!allowedUIDs.has(uid)) return { reason: "uid", details: { uid } };
  if (state.modelCalls >= maxModelCalls) return { reason: "budget", details: { uid, modelCalls: state.modelCalls } };
  return { entry: { kind: "model", method: method.split("/").pop(), uid, host } };
}
function guard(original, scheme) {
  return function liveGuardedRequest(...args) {
    const request = original.apply(this, args);
    const { host, path } = target(args, scheme);
    const method = path.replace(/^\//, "");
    const originalEnd = request.end;
    request.end = function guardedEnd(body, ...rest) {
      const verdict = decide(host, method, body);
      if (verdict.reason) {
        record({ kind: "blocked", reason: verdict.reason, method: method.split("/").pop(), ...verdict.details });
        request.destroy(Object.assign(new Error(`live-guard blocked: ${verdict.reason}`), { code: "ELIVEGUARD" }));
        return request;
      }
      record(verdict.entry);
      request.once("response", (incoming) => {
        record({ kind: verdict.entry.kind === "model" ? "model-response" : "read-response", method: verdict.entry.method, status: incoming.statusCode });
        if (method !== MODELS_METHOD || (incoming.statusCode ?? 0) >= 300) return;
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.once("end", () => {
          const raw = Buffer.concat(chunks);
          inspectCatalog(String(incoming.headers["content-encoding"] ?? "").toLowerCase() === "gzip" ? gunzipSync(raw) : raw);
        });
      });
      return originalEnd.call(this, body, ...rest);
    };
    return request;
  };
}

const require = createRequire(import.meta.url);
const http = require("node:http"), https = require("node:https"), net = require("node:net");

// The HTTP client bundled in Pi bypasses node:http and global fetch, so every TCP/TLS connection is also checked at the socket level.
function socketTarget(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === "object") return first.path ? { path: first.path } : { host: String(first.host ?? "localhost"), port: Number(first.port) };
  if (typeof first === "string" && Number.isNaN(Number(first))) return { path: first };
  return { host: typeof args[1] === "string" ? args[1] : "localhost", port: Number(first) };
}
const isAllowedSocket = ({ host, port }) => allowedHosts.has(`${host}:${port}`) || ((port === 443 || port === 80) && allowedHosts.has(host));
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function liveGuardedConnect(...args) {
  const target = socketTarget(args);
  if (!target.path && !isAllowedSocket(target)) {
    record({ kind: "blocked", reason: "host", host: `${target.host}:${target.port}`, via: "socket" });
    process.nextTick(() => this.destroy(Object.assign(new Error("live-guard blocked: host"), { code: "ELIVEGUARD" })));
    return this;
  }
  return originalConnect.apply(this, args);
};
for (const [module, scheme] of [[http, "http:"], [https, "https:"]]) {
  module.request = guard(module.request, scheme);
  // get() calls the module-internal request directly, so it is redefined to go through the wrapped request.
  module.get = function liveGuardedGet(...args) {
    const request = module.request(...args);
    request.end();
    return request;
  };
}
syncBuiltinESMExports();
const originalFetch = globalThis.fetch;
// The transport does not use fetch. Requests outside the allowed hosts through other paths are refused and recorded.
globalThis.fetch = function liveGuardedFetch(input, init) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!allowedHosts.has(url.host)) {
    record({ kind: "blocked", reason: "host", host: url.host, via: "fetch" });
    return Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("live-guard blocked: host"), { code: "ELIVEGUARD" }) }));
  }
  record({ kind: "read", method: url.pathname.split("/").pop(), host: url.host, via: "fetch" });
  return originalFetch.call(this, input, init);
};
record({ kind: "guard", node: process.version, allowedUIDs: [...allowedUIDs], allowedHosts: [...allowedHosts], maxModelCalls, requireFreeTier });
