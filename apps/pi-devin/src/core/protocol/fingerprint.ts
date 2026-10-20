import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { collectDeviceIdentity, type DeviceIdentity } from "./device.ts";

// Matches the CLI's fingerprint construction; verified with fake-token requests only.
// This is not encryption for credential storage. f contains the API token, so it is never logged.
const KEY_MATERIAL = "df97465349f38646af1d66c263e25e08";
const KEY = createHash("sha256").update(KEY_MATERIAL, "utf8").digest();

export interface FingerprintProvider {
  create(): string;
  device(): string;
}

export function hashDeviceIdentity(identity: DeviceIdentity): string {
  const macs = Buffer.byteLength(identity.serial) >= 4 ? "" : identity.macs.join(",");
  return createHash("sha512").update(macs + identity.serial + identity.username, "utf8").digest("hex");
}

export function createFingerprintProvider(sessionToken: string, options: {
  collectIdentity?: () => DeviceIdentity;
  nowNanoseconds?: () => bigint;
  nonce?: () => Uint8Array;
} = {}): FingerprintProvider {
  let device: string | undefined;
  const getDevice = () => device ??= hashDeviceIdentity((options.collectIdentity ?? collectDeviceIdentity)());
  return {
    device: getDevice,
    create: () => encodeFingerprint({
      deviceFingerprint: getDevice(), sessionToken,
      timestampNanoseconds: options.nowNanoseconds?.(), nonce: options.nonce?.(),
    }),
  };
}

export function unixNanoseconds(): bigint {
  // High-resolution epoch clock from the public Node API. It does not guarantee the OS's raw CLOCK_REALTIME precision.
  const originMilliseconds = Math.trunc(performance.timeOrigin);
  const fractionalNanoseconds = Math.round((performance.timeOrigin - originMilliseconds + performance.now()) * 1_000_000);
  return BigInt(originMilliseconds) * 1_000_000n + BigInt(fractionalNanoseconds);
}

export function encodeFingerprint(options: {
  deviceFingerprint: string;
  sessionToken: string;
  timestampNanoseconds?: bigint;
  nonce?: Uint8Array;
}): string {
  if (!/^[0-9a-f]{128}$/.test(options.deviceFingerprint)) throw new Error("The device identifier must be 128 lowercase hex characters.");
  if (!options.sessionToken || /[|\s\u0000-\u001f\u007f]/.test(options.sessionToken)) throw new Error("Invalid session token format.");
  const timestamp = options.timestampNanoseconds ?? unixNanoseconds();
  if (timestamp < 0n || timestamp >= (1n << 128n)) throw new Error("Invalid fingerprint timestamp.");
  const nonce = options.nonce ?? randomBytes(12);
  if (nonce.length !== 12) throw new Error("The fingerprint nonce must be 12 bytes.");
  const plaintext = `${options.deviceFingerprint}|${options.sessionToken}|${timestamp}`;
  const cipher = createCipheriv("aes-256-gcm", KEY, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("hex");
}
