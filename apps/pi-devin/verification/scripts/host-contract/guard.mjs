// Node preload for host-contract verification. The OS sandbox does the real blocking; this file applies the same policy
// to record and refuse external connections and subprocess spawns, leaving observable evidence. Not shipped.
import { appendFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";

const require = createRequire(import.meta.url);
const net = require("node:net");
const childProcess = require("node:child_process");
const logPath = process.env.PI_DEVIN_HOST_GUARD_LOG;
const allowedPort = Number(process.env.PI_DEVIN_HOST_GUARD_PORT);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
// Browser openers and keychain access commands are never run.
const BLOCKED_COMMANDS = new Set(["open", "xdg-open", "wslview", "security", "osascript", "explorer.exe"]);

function record(entry) {
  if (logPath) appendFileSync(logPath, JSON.stringify({ pid: process.pid, ...entry }) + "\n");
}
function guardError(message) {
  return Object.assign(new Error(`host-contract guard: ${message}`), { code: "EHOSTCONTRACT" });
}
function isAllowedTarget(host, port) {
  return LOOPBACK_HOSTS.has(host) && Number(port) === allowedPort;
}

function connectTarget(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === "object") {
    return first.path ? { path: first.path } : { host: String(first.host ?? "localhost"), port: first.port };
  }
  if (typeof first === "string" && Number.isNaN(Number(first))) return { path: first };
  return { host: typeof args[1] === "string" ? args[1] : "localhost", port: first };
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const target = connectTarget(args);
  if (target.path) {
    record({ kind: "socket", path: basename(String(target.path)), allowed: true });
    return originalConnect.apply(this, args);
  }
  const allowed = isAllowedTarget(target.host, target.port);
  record({ kind: "net", host: target.host, port: Number(target.port), allowed });
  if (!allowed) {
    process.nextTick(() => this.destroy(guardError(`outbound connection to ${target.host}:${target.port} blocked`)));
    return this;
  }
  return originalConnect.apply(this, args);
};

const originalFetch = globalThis.fetch;
globalThis.fetch = function guardedFetch(input, init) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const port = url.port || (url.protocol === "https:" ? 443 : 80);
  const allowed = isAllowedTarget(url.hostname, port);
  record({ kind: "fetch", host: url.hostname, port: Number(port), allowed });
  if (!allowed) return Promise.reject(new TypeError("fetch failed", { cause: guardError(`fetch to ${url.hostname} blocked`) }));
  return originalFetch.call(this, input, init);
};

function checkCommand(file, kind) {
  const name = basename(String(file));
  const allowed = !BLOCKED_COMMANDS.has(name);
  record({ kind, file: name, allowed });
  if (!allowed) throw guardError(`process ${name} blocked`);
}
const originalSpawn = childProcess.ChildProcess.prototype.spawn;
childProcess.ChildProcess.prototype.spawn = function guardedSpawn(options) {
  checkCommand(options?.file, "spawn");
  return originalSpawn.call(this, options);
};
for (const name of ["spawnSync", "execFileSync"]) {
  const original = childProcess[name];
  childProcess[name] = function guardedSync(file, ...rest) {
    checkCommand(file, name);
    return original.call(this, file, ...rest);
  };
}
const originalExecSync = childProcess.execSync;
childProcess.execSync = function guardedExecSync(command, ...rest) {
  checkCommand(String(command).trim().split(/\s+/)[0], "execSync");
  return originalExecSync.call(this, command, ...rest);
};
syncBuiltinESMExports();
record({ kind: "guard", node: process.version, allowedPort });
