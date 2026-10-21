import { createDecipheriv, createHash } from "node:crypto";
import type { NetworkInterfaceInfo } from "node:os";
import { expect, test } from "vitest";
import { DevinClient } from "../src/core/client.ts";
import { chatRequest, streamChat, userMessage } from "../src/core/inference/chat.ts";
import { collectDeviceIdentity, type DeviceSystem } from "../src/core/protocol/device.ts";
import { createFingerprintProvider, encodeFingerprint, hashDeviceIdentity, unixNanoseconds } from "../src/core/protocol/fingerprint.ts";
import { CHAT_METHOD } from "../src/core/protocol/protobuf.ts";
import { ConnectClient } from "../src/core/protocol/transport.ts";
import type { JsonObject } from "../src/core/types.ts";
import {
  credential, finalFrames, identity, MODELS_METHOD, modelResponse, requestBody, STATUS_METHOD, statusResponse, streamResponse, unaryResponse,
} from "./helpers.ts";

// Only OS inputs are controlled so no real device values are read. Collection rules, hashing and encryption run the real implementation.
const address = (family: "IPv4" | "IPv6", mac: string): NetworkInterfaceInfo => family === "IPv4"
  ? { address: "192.0.2.10", netmask: "255.255.255.0", family, mac, internal: false, cidr: "192.0.2.10/24" }
  : { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family, mac, internal: false, cidr: "fe80::1/64", scopeid: 2 };
const fakeInterfaces = () => ({
  lo: [{ ...address("IPv4", "00:00:00:00:00:00"), internal: true }],
  eth0: [address("IPv4", "0A:00:00:00:00:02"), address("IPv6", "0a:00:00:00:00:02")],
  wlan0: [address("IPv4", "0a:00:00:00:00:01")],
});
function fakeSystem(platform: NodeJS.Platform, overrides: Partial<DeviceSystem> = {}) {
  const commands: string[] = [];
  const system: DeviceSystem = {
    platform,
    run: (file) => { commands.push(file); throw new Error("controlled command unavailable"); },
    networkInterfaces: fakeInterfaces,
    username: () => "fake-user",
    ...overrides,
  };
  return { system, commands };
}

function decrypt(value: string): string {
  const bytes = Buffer.from(value, "hex");
  const key = createHash("sha256").update("df97465349f38646af1d66c263e25e08").digest();
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8");
}

test("native fingerprint layout: MAC/serial/user SHA-512 and authenticated AES-GCM", () => {
  const hash = hashDeviceIdentity(identity);
  expect(hash).toBe(createHash("sha512").update(identity.serial + identity.username).digest("hex"));
  expect(hashDeviceIdentity({ ...identity, macs: ["ignored-for-valid-serial"] })).toBe(hash);
  expect(hashDeviceIdentity({ serial: "", macs: ["aa", "bb"], username: "unknown" })).toBe(createHash("sha512").update("aa,bbunknown").digest("hex"));
  const timestamp = 1_792_281_600_123_456_789n;
  const value = encodeFingerprint({ deviceFingerprint: hash, sessionToken: credential.sessionToken, timestampNanoseconds: timestamp, nonce: Buffer.alloc(12, 7) });
  expect(decrypt(value)).toBe(`${hash}|${credential.sessionToken}|${timestamp}`);
  expect(value.length).toBe((12 + Buffer.byteLength(`${hash}|${credential.sessionToken}|${timestamp}`) + 16) * 2);
  expect(() => decrypt(value.slice(0, -2) + (value.endsWith("00") ? "01" : "00"))).toThrow();
  expect(() => encodeFingerprint({ deviceFingerprint: "a", sessionToken: credential.sessionToken })).toThrow(/device identifier/);
  expect(() => encodeFingerprint({ deviceFingerprint: hash, sessionToken: "invalid|token" })).toThrow(/session token/);
  expect(Math.abs(Number(unixNanoseconds() / 1_000_000n) - Date.now()) < 1000).toBeTruthy();
});

test("the device is looked up once, a nonce is made per request and reaches the final protobuf consumer", async () => {
  let collections = 0;
  const provider = createFingerprintProvider(credential.sessionToken, { collectIdentity: () => { collections++; return identity; }, nowNanoseconds: () => 123456789n });
  const values: string[] = [];
  const client = new ConnectClient({ baseURL: credential.apiServerURL, token: credential.sessionToken, fetch: async (_url, init) => {
    const body = requestBody(STATUS_METHOD, init!);
    const metadata = body.metadata as Record<string, string>;
    values.push(metadata.f);
    expect(decrypt(metadata.f)).toBe(`${provider.device()}|${credential.sessionToken}|123456789`);
    return unaryResponse(STATUS_METHOD, {});
  } });
  for (let index = 0; index < 2; index++) await client.unary(STATUS_METHOD, { metadata: { apiKey: credential.sessionToken, f: provider.create() } });
  expect(collections).toBe(1);
  expect(values[0]).not.toBe(values[1]);
});

test("non-darwin collection is not rejected by OS name and uses only real inputs and the native missing-value rules", () => {
  for (const platform of ["linux", "win32", "freebsd"] as const) {
    const { system, commands } = fakeSystem(platform);
    expect(collectDeviceIdentity(system)).toStrictEqual({ serial: "", macs: ["0a:00:00:00:00:01", "0a:00:00:00:00:02"], username: "fake-user" });
    expect(commands).toStrictEqual([]); // The macOS-only ioreg/ifconfig commands are not run.
  }
  const failed = fakeSystem("linux", {
    networkInterfaces: () => { throw new Error("interfaces unavailable"); },
    username: () => { throw new Error("getpwuid unavailable"); },
  });
  expect(collectDeviceIdentity(failed.system)).toStrictEqual({ serial: "", macs: [], username: "unknown" });
});

test("macOS collection uses the same ioreg serial as native and, for short serials, only the ifconfig MAC", () => {
  const ioreg = (serial: string) => `+-o J314sAP  <class IOPlatformExpertDevice>\n    "IOPlatformSerialNumber" = "${serial}"\n`;
  const noInterfaces = () => { throw new Error("Node interface API must not replace the native macOS command"); };
  const commands: string[] = [];
  const full: DeviceSystem = { platform: "darwin", networkInterfaces: noInterfaces, username: () => "mac-user",
    run: (file) => { commands.push(file); return file === "/usr/sbin/ioreg" ? ioreg("FAKE-SERIAL-1") : ""; } };
  expect(collectDeviceIdentity(full)).toStrictEqual({ serial: "FAKE-SERIAL-1", macs: [], username: "mac-user" });
  expect(commands).toStrictEqual(["/usr/sbin/ioreg"]);
  commands.length = 0;
  const short: DeviceSystem = { ...full,
    run: (file) => { commands.push(file); return file === "/usr/sbin/ioreg" ? ioreg("AB") : "0a:00:00:00:00:03\n"; } };
  expect(collectDeviceIdentity(short)).toStrictEqual({ serial: "AB", macs: ["0a:00:00:00:00:03"], username: "mac-user" });
  expect(commands).toStrictEqual(["/usr/sbin/ioreg", "/bin/sh"]);
  expect(collectDeviceIdentity({ ...full, run: () => { throw new Error("ioreg unavailable"); } })).toStrictEqual({ serial: "", macs: [], username: "mac-user" });
});

test("a fingerprint from the non-darwin default collector reaches the final status, catalog and chat payloads", async () => {
  const { system } = fakeSystem("linux");
  const expectedDevice = createHash("sha512").update("0a:00:00:00:00:01,0a:00:00:00:00:02" + "" + "fake-user").digest("hex");
  const seen: { method: string; metadata: JsonObject }[] = [];
  const client = new DevinClient(credential, {
    fingerprint: createFingerprintProvider(credential.sessionToken, { collectIdentity: () => collectDeviceIdentity(system) }),
    fetch: async (url, init) => {
      const method = new URL(String(url)).pathname.slice(1);
      seen.push({ method, metadata: requestBody(method, init!).metadata as JsonObject });
      if (method === STATUS_METHOD) return unaryResponse(method, statusResponse());
      if (method === MODELS_METHOD) return unaryResponse(method, modelResponse());
      return streamResponse(finalFrames("portable"));
    },
  });
  await client.status();
  await client.catalog();
  const result = await streamChat(client.transport, chatRequest({ metadata: client.metadata(), model: "swe-2-medium",
    messages: [userMessage("hello")], systemPrompt: "system", maxTokens: 16, cascadeId: "cascade", trajectoryId: "trajectory" }));
  expect(result.message.prompt).toBe("portable");
  expect(seen.map((request) => request.method)).toStrictEqual([STATUS_METHOD, MODELS_METHOD, CHAT_METHOD]);
  for (const { metadata } of seen) {
    const [device, token, timestamp] = decrypt(metadata.f as string).split("|");
    expect(device).toBe(expectedDevice);
    expect(token).toBe(credential.sessionToken);
    expect(timestamp).toMatch(/^\d+$/);
  }
  expect(new Set(seen.map((request) => request.metadata.f)).size).toBe(3);
});

test("errors hide the fingerprint ciphertext, its uppercase form and the API token", async () => {
  const value = createFingerprintProvider(credential.sessionToken, { collectIdentity: () => identity }).create();
  let calls = 0;
  const client = new ConnectClient({ baseURL: credential.apiServerURL, token: credential.sessionToken, fetch: async () => {
    calls++;
    return Response.json({ code: "invalid_argument", message: `${credential.sessionToken} ${value} ${value.toUpperCase()}` }, { status: 400 });
  } });
  await expect(client.unary(STATUS_METHOD, { metadata: { apiKey: credential.sessionToken, f: value } })).rejects.toThrow(expect.toSatisfy((error: Error) => error.message === "invalid_argument: [REDACTED] [REDACTED] [REDACTED]"));
  expect(calls).toBe(1);
});
